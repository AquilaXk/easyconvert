import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isPureDataConvertible,
  convertPureData,
} from '@/lib/edge/pure/pure-data';
import {
  isPureCadConvertible,
  convertPureCad,
  encodeStl,
  encodeObj,
} from '@/lib/edge/pure/pure-cad';
import {
  isPureAudioConvertible,
  convertPureAudio,
  encodePcmToWav,
  parseWavPcm,
} from '@/lib/edge/pure/pure-audio';
import {
  isCanvasSupported,
  isPureCanvasConvertible,
  encodeBmpFromImageData,
} from '@/lib/edge/pure/pure-canvas';
import {
  resolveConversionTier,
  checkWasmSimdSupport,
  checkOpfsSupport,
  probeEdgeCapabilities,
} from '@/lib/edge/tier-router';
import {
  getEffectiveMaxFileSize,
  tryProcessClientEdge,
  createItemConverter,
  executeItemConversion,
} from '@/lib/client-converter';
import { ConversionQueueItem } from '@/lib/types';
import * as path from 'node:path';
import { collectModuleGraph, identifierUses, parseSource } from './helpers/ts-source';

describe('Phase 1: Pure Isomorphic Fast-Path & Edge Infrastructure (L0)', () => {
  let originalWindow: any;
  let originalUrl: any;

  beforeEach(() => {
    originalWindow = (globalThis as any).window;
    originalUrl = (globalThis as any).URL;
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
    (globalThis as any).URL = originalUrl;
    vi.restoreAllMocks();
  });
  // ==========================================================================
  // 1. Dependency Isolation & Purity Verification
  // ==========================================================================
  describe('Dependency Isolation Audit', () => {
    // The modules are followed through every run-time import, so a heavy dependency pulled in by a helper of a
    // helper is found; text matching on the entry file alone would miss it. Type-only imports are erased and do
    // not count.
    const SRC_ROOT = path.join(process.cwd(), 'src');
    const pureGraph = (name: string) => collectModuleGraph(path.join(SRC_ROOT, 'lib/edge/pure', `${name}.ts`), SRC_ROOT);
    const relativeFiles = (graph: ReturnType<typeof pureGraph>) => graph.files.map((file) => path.relative(SRC_ROOT, file));

    it('pure-data.ts reaches no package beyond the YAML and CSV parsers, and no server-side conversion module', () => {
      const graph = pureGraph('pure-data');
      // node:path arrives through the format registry.
      expect(graph.externalSpecifiers).toEqual(['js-yaml', 'node:path', 'papaparse']);
      expect(relativeFiles(graph).filter((file) => /office|pdf|sharp|vector-cad/i.test(file))).toEqual([]);
    });

    it('pure-cad.ts reaches only the STEP reader of the conversions, no raster, PDF or archive module', () => {
      const graph = pureGraph('pure-cad');
      expect(graph.externalSpecifiers).toEqual(['node:path']);
      expect(relativeFiles(graph).filter((file) => file.startsWith('lib/conversions/'))).toEqual([
        'lib/conversions/cad-nurbs.ts',
        'lib/conversions/cad-predicates.ts',
      ]);
    });

    it('the audio path never names the Node Buffer, and converts with the Buffer global removed', () => {
      const graph = pureGraph('pure-audio');
      expect(graph.externalSpecifiers).toEqual(['node:path']);
      // The registry, the shared types and the job graph are imported for their names and are also used on the
      // server, where they do use Buffer; the audio engine itself is every other file in the graph.
      const audioFiles = graph.files.filter((file) => !/lib\/(?:registry|types)\.ts$|lib\/(?:jobs|api)\//.test(file));
      expect(audioFiles.map((file) => path.relative(SRC_ROOT, file))).toContain('lib/edge/pure/pure-audio.ts');
      const bufferUses = audioFiles.flatMap((file) =>
        identifierUses(parseSource(file), 'Buffer').map((position) => `${path.relative(SRC_ROOT, file)}:${position}`)
      );
      expect(bufferUses).toEqual([]);

      // Behaviour agrees with the source: a conversion runs and returns the samples it was given, with no Buffer.
      const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
      const wavBytes = encodePcmToWav(samples, 8000, 1);
      vi.stubGlobal('Buffer', undefined);
      try {
        const converted = convertPureAudio(wavBytes, 'wav', 'wav');
        expect(parseWavPcm(converted.data).samples).toEqual(samples);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // ==========================================================================
  // 2. Pure Data Engine (CSV, TSV, JSON, YAML)
  // ==========================================================================
  describe('Pure Data Engine (pure-data.ts)', () => {
    it('correctly reports format capability', () => {
      expect(isPureDataConvertible('csv', 'json')).toBe(true);
      expect(isPureDataConvertible('tsv', 'yaml')).toBe(true);
      expect(isPureDataConvertible('json', 'csv')).toBe(true);
      expect(isPureDataConvertible('yaml', 'json')).toBe(true);
      expect(isPureDataConvertible('csv', 'pdf')).toBe(false); // PDF requires server/L2
      expect(isPureDataConvertible('png', 'jpg')).toBe(false);
    });

    it('converts CSV to JSON and TSV with exact field parsing', () => {
      const csv = 'id,name,role\n1,Alice,Engineer\n2,Bob,Designer';
      const jsonRes = convertPureData(csv, 'csv', 'json');
      expect(jsonRes.mimeType).toBe('application/json');
      expect(jsonRes.extension).toBe('json');
      const parsed = JSON.parse(jsonRes.text);
      expect(parsed).toEqual([
        { id: '1', name: 'Alice', role: 'Engineer' },
        { id: '2', name: 'Bob', role: 'Designer' },
      ]);

      // CSV -> TSV
      const tsvRes = convertPureData(csv, 'csv', 'tsv');
      expect(tsvRes.mimeType).toBe('text/tab-separated-values');
      expect(tsvRes.text).toContain('id\tname\trole');
      expect(tsvRes.text).toContain('1\tAlice\tEngineer');
    });

    it('converts JSON to YAML and CSV', () => {
      const jsonStr = JSON.stringify([
        { sku: 'A100', price: 99.5 },
        { sku: 'B200', price: 149.0 },
      ]);
      const yamlRes = convertPureData(jsonStr, 'json', 'yaml');
      expect(yamlRes.mimeType).toBe('application/x-yaml');
      expect(yamlRes.text).toContain('sku: A100');
      expect(yamlRes.text).toContain('price: 99.5');

      const csvRes = convertPureData(jsonStr, 'json', 'csv');
      expect(csvRes.mimeType).toBe('text/csv');
      expect(csvRes.text).toContain('sku,price');
      expect(csvRes.text).toContain('A100,99.5');
    });

    it('converts YAML to JSON and preserves typed array byte representation', () => {
      const yamlStr = 'project: EasyConvert\nversion: 1.0.0\nactive: true';
      const inputBytes = new TextEncoder().encode(yamlStr);
      const res = convertPureData(inputBytes, 'yaml', 'json');
      const parsed = JSON.parse(res.text);
      expect(parsed.project).toBe('EasyConvert');
      expect(parsed.version).toBe('1.0.0');
      expect(parsed.active).toBe(true);
      expect(res.data).toBeInstanceOf(Uint8Array);
      expect(res.data.length).toBeGreaterThan(0);
    });

    it('fails closed on invalid syntax', () => {
      expect(() => convertPureData('{"unclosed: json', 'json', 'yaml')).toThrow(
        /JSON parsing failed/
      );
      expect(() => convertPureData('foo: [unclosed', 'yaml', 'json')).toThrow(
        /YAML parsing failed/
      );
    });

    it('safely serializes JSON primitives and arrays of primitives to CSV/TSV without throwing', () => {
      // A bare value becomes a one-column table headed "value"; records end with CRLF (RFC 4180).
      expect(convertPureData('[10, 20, 30]', 'json', 'csv').text).toBe('value\r\n10\r\n20\r\n30');
      expect(convertPureData('"single string"', 'json', 'tsv').text).toBe('value\r\nsingle string');
      expect(convertPureData('42', 'json', 'csv').text).toBe('value\r\n42');
      // JSON null is no value: the table has its header and no row.
      expect(convertPureData('null', 'json', 'csv').text).toBe('value\r\n');
    });

    it('handles empty or whitespace YAML converting to JSON with valid object rather than string undefined', () => {
      const resEmpty = convertPureData('', 'yaml', 'json');
      expect(resEmpty.text).toBe('{}');
      expect(resEmpty.text).not.toBe('undefined');

      const resWhitespace = convertPureData('   \n  ', 'yaml', 'json');
      expect(resWhitespace.text).toBe('{}');
    });
  });

  // ==========================================================================
  // 3. Pure CAD Engine (STEP/IGES to STL/OBJ)
  // ==========================================================================
  describe('Pure CAD Engine (pure-cad.ts)', () => {
    const SAMPLE_STEP = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('EasyConvert Edge Fast-Path Mesh'), '2;1');",
      "FILE_NAME('isomorphic_mesh.step', '2026-09-27', ('EdgeEngine'), ('EasyConvert'), '', '', '');",
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
      'ENDSEC;',
      'DATA;',
      "#101 = CARTESIAN_POINT('Node_Origin', (1.25, 2.50, 3.75));",
      "#202 = CARTESIAN_POINT('Node_X_Axis', (12.50, 2.50, 3.75));",
      "#303 = CARTESIAN_POINT('Node_Y_Axis', (1.25, 14.50, 3.75));",
      "#404 = CARTESIAN_POINT('Node_Diag', (12.50, 14.50, 3.75));",
      "#505 = CARTESIAN_POINT('Node_Apex', (6.87, 8.50, 15.20));",
      "#606 = CARTESIAN_POINT('Node_Base', (1.25, 2.50, 3.75));",
      "#10 = B_SPLINE_CURVE_WITH_KNOTS('c1', 1, (#101, #202), .UNSPECIFIED., .F., .F., (2, 2), (0.0, 1.0), .PIECEWISE_BEZIER_KNOTS.);",
      "#20 = B_SPLINE_CURVE_WITH_KNOTS('c2', 1, (#303, #404), .UNSPECIFIED., .F., .F., (2, 2), (0.0, 1.0), .PIECEWISE_BEZIER_KNOTS.);",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');

    it('correctly reports CAD format capability', () => {
      expect(isPureCadConvertible('step', 'stl')).toBe(true);
      expect(isPureCadConvertible('stp', 'obj')).toBe(true);
      expect(isPureCadConvertible('iges', 'stl')).toBe(true);
      expect(isPureCadConvertible('igs', 'obj')).toBe(true);
      expect(isPureCadConvertible('step', 'dwg')).toBe(false);
      expect(isPureCadConvertible('obj', 'step')).toBe(false);
    });

    it('tessellates STEP model to valid ASCII STL mesh', () => {
      const res = convertPureCad(SAMPLE_STEP, 'step', 'stl', 'test_model');
      expect(res.mimeType).toBe('model/stl');
      expect(res.extension).toBe('stl');
      expect(res.text).toContain('solid test_model');
      expect(res.text).toContain('facet normal');
      expect(res.text).toContain('outer loop');
      expect(res.text).toContain('vertex');
      expect(res.text).toContain('endloop');
      expect(res.text).toContain('endfacet');
      expect(res.text).toContain('endsolid test_model');
      expect(res.data.length).toBeGreaterThan(0);
    });

    it('tessellates STEP model to valid Wavefront OBJ format', () => {
      const res = convertPureCad(SAMPLE_STEP, 'step', 'obj', 'test_model');
      expect(res.mimeType).toBe('model/obj');
      expect(res.extension).toBe('obj');
      expect(res.text).toContain('o test_model');
      expect(res.text).toContain('v 1.25 2.5 3.75');
      expect(res.text).toContain('v 12.5 2.5 3.75');
      expect(res.text).toContain('f ');
    });

    it('correctly handles Uint8Array input for CAD conversion', () => {
      const fromBytes = convertPureCad(new TextEncoder().encode(SAMPLE_STEP), 'stp', 'stl', 'bytes_model');
      const fromText = convertPureCad(SAMPLE_STEP, 'step', 'stl', 'bytes_model');
      // The same model gives the same mesh whether the STEP text arrives as a string or as bytes, and the
      // returned bytes are exactly the UTF-8 of the returned text.
      expect(fromBytes.text).toBe(fromText.text);
      expect(fromBytes.text.startsWith('solid bytes_model\n')).toBe(true);
      expect(new TextDecoder().decode(fromBytes.data)).toBe(fromBytes.text);

      // Independent read of the ASCII STL: the facets tile the rectangle between the two ruled curves,
      // x 1.25..12.5 by y 2.5..14.5 at z 3.75, an area of 11.25 * 12 = 135.
      const facets = [...fromBytes.text.matchAll(/facet normal (\S+) (\S+) (\S+)\s+outer loop\s+vertex (\S+) (\S+) (\S+)\s+vertex (\S+) (\S+) (\S+)\s+vertex (\S+) (\S+) (\S+)/g)].map(
        (match) => match.slice(1).map(Number)
      );
      expect(facets).toHaveLength((fromBytes.text.match(/facet normal/g) ?? []).length);
      let area = 0;
      for (const facet of facets) {
        const [a, b, c] = [facet.slice(3, 6), facet.slice(6, 9), facet.slice(9, 12)];
        for (const vertex of [a, b, c]) {
          expect(vertex[0]).toBeGreaterThanOrEqual(1.25);
          expect(vertex[0]).toBeLessThanOrEqual(12.5);
          expect(vertex[1]).toBeGreaterThanOrEqual(2.5);
          expect(vertex[1]).toBeLessThanOrEqual(14.5);
          expect(vertex[2]).toBe(3.75);
        }
        const cross = [
          (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
          (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
          (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        ];
        const twiceArea = Math.hypot(cross[0], cross[1], cross[2]);
        // The stored normal is the unit normal of the winding order.
        expect(facet.slice(0, 3).map((value, axis) => Math.abs(value - cross[axis] / twiceArea))).toEqual([0, 0, 0]);
        area += twiceArea / 2;
      }
      expect(area).toBeCloseTo(135, 9);
    });

    it('fails closed when given empty or unparseable CAD content', () => {
      expect(() => convertPureCad('NOT A VALID STEP FILE', 'step', 'stl')).toThrow(
        /Failed to tessellate CAD geometry/
      );
    });

    it('sanitizes model names and handles quad/polygon faces in STL and OBJ', () => {
      const quadMesh = {
        name: 'My\nModel\rName',
        vertices: [
          [0, 0, 0],
          [10, 0, 0],
          [10, 10, 0],
          [0, 10, 0],
        ],
        faces: [[0, 1, 2, 3]],
      };

      const stl = encodeStl(quadMesh);
      expect(stl).toContain('solid My Model Name');
      expect(stl).not.toContain('\nModel');
      // Quad should be triangulated into 2 facets
      const facetCount = (stl.match(/facet normal/g) || []).length;
      expect(facetCount).toBe(2);

      const obj = encodeObj(quadMesh);
      expect(obj).toContain('o My Model Name');
      expect(obj).toContain('f 1 2 3 4');
    });
  });

  // ==========================================================================
  // 4. Pure Audio Engine (WAV/PCM/MP3)
  // ==========================================================================
  describe('Pure Audio Engine (pure-audio.ts)', () => {
    it('correctly reports audio format capability', () => {
      // MP3 is not a pure target: the server engine encodes it.
      expect(isPureAudioConvertible('wav', 'mp3')).toBe(false);
      expect(isPureAudioConvertible('wav', 'wav')).toBe(true);
      // Raw PCM has no header: it is convertible only when the options describe it.
      expect(isPureAudioConvertible('pcm', 'wav')).toBe(false);
      expect(isPureAudioConvertible('raw', 'mp3')).toBe(false);
      expect(isPureAudioConvertible('pcm', 'wav', { source: { sampleRate: 44100, channels: 2, bitDepth: 16 } })).toBe(true);
      expect(isPureAudioConvertible('wav', 'flac')).toBe(false);
      expect(isPureAudioConvertible('mp3', 'aac')).toBe(false);
    });

    it('encodes PCM samples to standard RIFF WAV and parses them back losslessly', () => {
      const sampleCount = 4410; // 0.1s at 44.1kHz mono
      const originalSamples = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        originalSamples[i] = Math.round(Math.sin((i / 44.1) * 2 * Math.PI) * 16000);
      }

      // Encode to WAV
      const wavBytes = encodePcmToWav(originalSamples, 44100, 1);
      expect(wavBytes.length).toBe(44 + sampleCount * 2);

      // Verify RIFF header structure via DataView
      const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
      const riffHeader = String.fromCharCode(
        view.getUint8(0),
        view.getUint8(1),
        view.getUint8(2),
        view.getUint8(3)
      );
      const waveHeader = String.fromCharCode(
        view.getUint8(8),
        view.getUint8(9),
        view.getUint8(10),
        view.getUint8(11)
      );
      expect(riffHeader).toBe('RIFF');
      expect(waveHeader).toBe('WAVE');
      expect(view.getUint32(24, true)).toBe(44100); // Sample rate
      expect(view.getUint16(22, true)).toBe(1); // Channels

      // Parse back to PCM
      const parsed = parseWavPcm(wavBytes);
      expect(parsed.sampleRate).toBe(44100);
      expect(parsed.channels).toBe(1);
      expect(parsed.samples.length).toBe(sampleCount);

      // Exact sample fidelity check
      for (let i = 0; i < 50; i++) {
        expect(parsed.samples[i]).toBe(originalSamples[i]);
      }
    });

    it('executes end-to-end convertPureAudio for WAV to WAV', () => {
      const samples = Int16Array.from({ length: 1152 * 2 }, (_, i) => (i % 200) - 100);
      const wavBytes = encodePcmToWav(samples, 44100, 2);

      const res = convertPureAudio(wavBytes, 'wav', 'wav');
      expect(res.mimeType).toBe('audio/wav');
      expect(res.extension).toBe('wav');
      expect(Buffer.from(res.data).equals(Buffer.from(wavBytes))).toBe(true);
    });

    it('parses WAV with odd-length metadata chunk preceding data chunk', () => {
      // Create a WAV with fmt subchunk, an odd-sized JUNK chunk (15 bytes + 1 pad byte), then data
      const sampleCount = 100;
      const dataBytesLen = sampleCount * 2;
      const junkPayloadLen = 15; // Odd size
      const junkTotalLen = 8 + junkPayloadLen + 1; // 8 hdr + 15 payload + 1 pad = 24 bytes
      const totalSize = 12 + 24 + junkTotalLen + 8 + dataBytesLen;

      const buf = new Uint8Array(totalSize);
      const view = new DataView(buf.buffer);

      // RIFF
      buf.set([0x52, 0x49, 0x46, 0x46], 0);
      view.setUint32(4, totalSize - 8, true);
      buf.set([0x57, 0x41, 0x56, 0x45], 8);

      // fmt
      buf.set([0x66, 0x6d, 0x74, 0x20], 12);
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 1, true); // mono
      view.setUint32(24, 48000, true); // 48kHz
      view.setUint32(28, 96000, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true); // 16-bit

      // JUNK chunk (odd length 15)
      let off = 36;
      buf.set([0x4a, 0x55, 0x4e, 0x4b], off);
      view.setUint32(off + 4, junkPayloadLen, true);
      off += 8 + junkPayloadLen;
      buf[off++] = 0x00; // Pad byte

      // data chunk
      buf.set([0x64, 0x61, 0x74, 0x61], off);
      view.setUint32(off + 4, dataBytesLen, true);
      off += 8;
      for (let i = 0; i < sampleCount; i++) {
        view.setInt16(off + i * 2, 1234, true);
      }

      const parsed = parseWavPcm(buf);
      expect(parsed.sampleRate).toBe(48000);
      expect(parsed.channels).toBe(1);
      expect(parsed.samples.length).toBe(sampleCount);
      expect(parsed.samples[0]).toBe(1234);
    });

    it('parses 8-bit unsigned and 24-bit signed PCM WAV files', () => {
      // 1. 8-bit unsigned PCM
      const count8 = 64;
      const buf8 = new Uint8Array(44 + count8);
      const v8 = new DataView(buf8.buffer);
      buf8.set([0x52, 0x49, 0x46, 0x46], 0);
      v8.setUint32(4, 36 + count8, true);
      buf8.set([0x57, 0x41, 0x56, 0x45], 8);
      buf8.set([0x66, 0x6d, 0x74, 0x20], 12);
      v8.setUint32(16, 16, true);
      v8.setUint16(20, 1, true); // PCM
      v8.setUint16(22, 1, true); // mono
      v8.setUint32(24, 22050, true);
      v8.setUint32(28, 22050, true);
      v8.setUint16(32, 1, true);
      v8.setUint16(34, 8, true); // 8-bit!
      buf8.set([0x64, 0x61, 0x74, 0x61], 36);
      v8.setUint32(40, count8, true);
      for (let i = 0; i < count8; i++) {
        buf8[44 + i] = 128 + 50; // value +50
      }

      const parsed8 = parseWavPcm(buf8);
      expect(parsed8.sampleRate).toBe(22050);
      expect(parsed8.channels).toBe(1);
      expect(parsed8.samples[0]).toBe(50 << 8);

      // 2. 24-bit signed PCM
      const count24 = 32;
      const data24Len = count24 * 3;
      const buf24 = new Uint8Array(44 + data24Len);
      const v24 = new DataView(buf24.buffer);
      buf24.set([0x52, 0x49, 0x46, 0x46], 0);
      v24.setUint32(4, 36 + data24Len, true);
      buf24.set([0x57, 0x41, 0x56, 0x45], 8);
      buf24.set([0x66, 0x6d, 0x74, 0x20], 12);
      v24.setUint32(16, 16, true);
      v24.setUint16(20, 1, true); // PCM
      v24.setUint16(22, 1, true); // mono
      v24.setUint32(24, 44100, true);
      v24.setUint32(28, 132300, true);
      v24.setUint16(32, 3, true);
      v24.setUint16(34, 24, true); // 24-bit!
      buf24.set([0x64, 0x61, 0x74, 0x61], 36);
      v24.setUint32(40, data24Len, true);
      // Sample 0: 0x123456 -> high 16 bits: 0x1234
      buf24[44] = 0x56;
      buf24[45] = 0x34;
      buf24[46] = 0x12;

      const parsed24 = parseWavPcm(buf24);
      expect(parsed24.samples[0]).toBe(0x1234);
    });

  });

  // ==========================================================================
  // 5. Pure Canvas 2D Transcoder (BMP / OffscreenCanvas)
  // ==========================================================================
  describe('Pure Canvas Engine (pure-canvas.ts)', () => {
    it('correctly reports canvas format capability', () => {
      expect(isPureCanvasConvertible('png', 'webp')).toBe(true);
      expect(isPureCanvasConvertible('jpeg', 'bmp')).toBe(true);
      expect(isPureCanvasConvertible('bmp', 'png')).toBe(true);
      expect(isPureCanvasConvertible('png', 'mp4')).toBe(false);
    });

    it('encodes synthetic RGBA image data to valid 24-bit Windows BMP', () => {
      const width = 4;
      const height = 2;
      // 4x2 RGBA pixels = 32 bytes
      const rgba = new Uint8ClampedArray(width * height * 4);
      // Pixel 0,0: Red (255, 0, 0, 255)
      rgba[0] = 255;
      rgba[1] = 0;
      rgba[2] = 0;
      rgba[3] = 255;
      // Pixel 1,0: Green (0, 255, 0, 255)
      rgba[4] = 0;
      rgba[5] = 255;
      rgba[6] = 0;
      rgba[7] = 255;

      const bmpBytes = encodeBmpFromImageData({ width, height, data: rgba });
      expect(bmpBytes).toBeInstanceOf(Uint8Array);

      // Verify BMP file header
      const view = new DataView(bmpBytes.buffer, bmpBytes.byteOffset, bmpBytes.byteLength);
      expect(view.getUint8(0)).toBe(0x42); // 'B'
      expect(view.getUint8(1)).toBe(0x4d); // 'M'
      expect(view.getUint32(2, true)).toBe(bmpBytes.length); // Total file size
      expect(view.getUint32(10, true)).toBe(54); // Pixel array offset (14 + 40)

      // Verify BITMAPINFOHEADER
      expect(view.getUint32(14, true)).toBe(40); // DIB header size
      expect(view.getInt32(18, true)).toBe(width);
      expect(view.getInt32(22, true)).toBe(height);
      expect(view.getInt16(26, true)).toBe(1); // 1 plane
      expect(view.getUint16(28, true)).toBe(24); // 24-bit RGB
    });

    it('fails closed and validates input parameters for BMP encoder', () => {
      expect(() =>
        encodeBmpFromImageData({ width: 0, height: 10, data: new Uint8Array(10) })
      ).toThrow(/Invalid image dimensions/);
      expect(() =>
        encodeBmpFromImageData({ width: 10, height: 0, data: new Uint8Array(10) })
      ).toThrow(/Invalid image dimensions/);
    });
  });

  // ==========================================================================
  // 6. Tier Router & Probing
  // ==========================================================================
  describe('Tier Capability Router (tier-router.ts)', () => {
    it('validates Wasm SIMD capability via bytecode probe without crashing', () => {
      const simdSupported = checkWasmSimdSupport();
      expect(typeof simdSupported).toBe('boolean');
    });

    it('probes edge capabilities deterministically', async () => {
      const caps = await probeEdgeCapabilities();
      expect(caps).toHaveProperty('hasWasmSimd');
      expect(caps).toHaveProperty('hasOpfsSyncAccess');
      expect(caps).toHaveProperty('hardwareConcurrency');
      expect(caps).toHaveProperty('hasCanvas');
      expect(Array.isArray(caps.supportedVideoEncoders)).toBe(true);
    });

    it('routes structured data pairs to the server data engine (Cloud L4)', () => {
      const res = resolveConversionTier('csv', 'json', 5000);
      expect(res.tier).toBe('L4');
      expect(res.tierName).toBe('Cloud (Zero-Retention)');
      expect(res.isClientEdge).toBe(false);
    });

    it('routes pure CAD pairs to Level 0 (Instant)', () => {
      const res = resolveConversionTier('step', 'stl', 150000);
      expect(res.tier).toBe('L0');
      expect(res.tierName).toBe('Edge L0 (Instant)');
      expect(res.isClientEdge).toBe(true);
    });

    it('routes pure Audio pairs to Level 0 (Instant)', () => {
      const res = resolveConversionTier('wav', 'wav', 44100);
      expect(res.tier).toBe('L0');
      expect(res.tierName).toBe('Edge L0 (Instant)');
      expect(res.isClientEdge).toBe(true);
    });

    it('routes Canvas format pairs based on hasCanvas capability', () => {
      const resWithCanvas = resolveConversionTier('png', 'webp', 1000, {}, { hasCanvas: true });
      expect(resWithCanvas.tier).toBe('L0');
      expect(resWithCanvas.tierName).toBe('Edge L0 (Instant)');
      expect(resWithCanvas.isClientEdge).toBe(true);

      const resWithoutCanvas = resolveConversionTier('png', 'webp', 1000, {}, { hasCanvas: false });
      expect(resWithoutCanvas.tier).toBe('L4');
      expect(resWithoutCanvas.isClientEdge).toBe(false);
    });

    it('routes OCR tasks to Level 2 (SIMD Wasm)', () => {
      const res = resolveConversionTier('png', 'pdf', 50000, { ocrEnabled: true });
      expect(res.tier).toBe('L2');
      expect(res.tierName).toBe('Edge L2 (SIMD Wasm)');
      expect(res.isClientEdge).toBe(true);
    });

    it('routes user opt-out clientEdgeMode: false directly to Cloud L4', () => {
      const res = resolveConversionTier('csv', 'json', 1000, { clientEdgeMode: false });
      expect(res.tier).toBe('L4');
      expect(res.tierName).toBe('Cloud (Zero-Retention)');
      expect(res.isClientEdge).toBe(false);
    });

    it('routes files > 100MB to L3 OPFS when available, or L4 when unavailable', () => {
      const largeSize = 250 * 1024 * 1024; // 250 MB
      const opfsAvailable = resolveConversionTier('csv', 'tsv', largeSize, {}, {
        hasOpfsSyncAccess: true,
      });
      expect(opfsAvailable.tier).toBe('L3');
      expect(opfsAvailable.tierName).toBe('Edge L3 (OPFS Stream)');
      expect(opfsAvailable.isClientEdge).toBe(true);

      const opfsUnavailable = resolveConversionTier('csv', 'tsv', largeSize, {}, {
        hasOpfsSyncAccess: false,
      });
      expect(opfsUnavailable.tier).toBe('L4');
      expect(opfsUnavailable.tierName).toBe('Cloud (Zero-Retention)');
      expect(opfsUnavailable.isClientEdge).toBe(false);
    });
  });

  // ==========================================================================
  // 7. Client Converter & Queue Integration
  // ==========================================================================
  describe('Client Converter Integration (client-converter.ts)', () => {
    it('calculates dynamic effective file size limit', () => {
      const limit = getEffectiveMaxFileSize(100 * 1024 * 1024);
      expect(limit).toBeGreaterThanOrEqual(100 * 1024 * 1024);
    });

    it('leaves structured data conversion to the server: tryProcessClientEdge converts nothing', async () => {
      // Mock File and window in test environment
      const csvContent = 'name,score\nAda,100\nGrace,99';
      const file = new File([csvContent], 'scores.csv', { type: 'text/csv' });

      // Mock window and URL.createObjectURL
      (globalThis as any).window = globalThis;
      const fakeUrl = 'blob:http://localhost:3000/mock-uuid';
      const createObjectURLMock = vi.fn().mockReturnValue(fakeUrl);
      (globalThis as any).URL.createObjectURL = createObjectURLMock;

      const queueItem: ConversionQueueItem = {
        id: 'test-1',
        file,
        name: 'scores.csv',
        size: file.size,
        sourceFormat: 'csv',
        targetFormat: 'json',
        status: 'ready',
        progress: 0,
        options: { clientEdgeMode: true },
      };

      const onProgress = vi.fn();
      const edgeRes = await tryProcessClientEdge(queueItem, onProgress);

      expect(edgeRes).toBeNull();
      expect(createObjectURLMock).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
    });

    it('blocks a structured data conversion in client-only mode instead of uploading it without consent', async () => {
      (globalThis as any).window = globalThis;
      const fetchSpy = vi.fn();
      (globalThis as any).fetch = fetchSpy;

      const corruptFile = new File(['{"unclosed: json'], 'corrupt.json', { type: 'application/json' });
      const queueItem: ConversionQueueItem = {
        id: 'test-corrupt',
        file: corruptFile,
        name: 'corrupt.json',
        size: corruptFile.size,
        sourceFormat: 'json',
        targetFormat: 'csv',
        status: 'ready',
        progress: 0,
        options: { clientEdgeMode: true },
      };

      let capturedError = '';
      await executeItemConversion(queueItem, {
        onProgress: vi.fn(),
        onSuccess: vi.fn(),
        onError: (err) => {
          capturedError = err;
        },
      });

      expect(capturedError).toBe(
        'Conversion from JSON to CSV requires cloud serverless processing, but client-only edge mode is strictly enabled without cloud fallback consent.'
      );
      // Crucial: Must NEVER make an unconsented network fetch to server when the client edge cannot convert!
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects oversized files in createItemConverter', async () => {
      let queue: ConversionQueueItem[] = [];
      const setQueue = (action: any) => {
        queue = typeof action === 'function' ? action(queue) : action;
      };

      const converter = createItemConverter(setQueue, 50 * 1024 * 1024); // 50MB ceiling
      const bigFile = new File([new Uint8Array(60 * 1024 * 1024)], 'giant.csv');

      const queueItem: ConversionQueueItem = {
        id: 'item-big',
        file: bigFile,
        name: 'giant.csv',
        size: bigFile.size,
        sourceFormat: 'csv',
        targetFormat: 'json',
        status: 'ready',
        progress: 0,
        options: {},
      };
      queue = [queueItem];

      await converter(queueItem);

      expect(queue[0].status).toBe('error');
      expect(queue[0].error).toContain('File size exceeds 50 MB limit.');
    });
  });
});
