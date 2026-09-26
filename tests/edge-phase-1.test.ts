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
  encodePureMp3,
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
} from '@/lib/client-converter';
import { ConversionQueueItem } from '@/lib/types';
import * as fs from 'fs';
import * as path from 'path';

describe('Phase 1: Pure Isomorphic Fast-Path & Edge Infrastructure (L0)', () => {
  // ==========================================================================
  // 1. Dependency Isolation & Purity Verification
  // ==========================================================================
  describe('Dependency Isolation Audit', () => {
    it('pure-data.ts strictly avoids importing pdfkit, office, sharp, or fs', () => {
      const filePath = path.join(process.cwd(), 'src/lib/edge/pure/pure-data.ts');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toContain("from 'pdfkit'");
      expect(content).not.toContain("from './office'");
      expect(content).not.toContain("from 'sharp'");
      expect(content).not.toContain("from 'fs'");
    });

    it('pure-cad.ts strictly avoids importing sharp, pdfkit, zlib, or vector-cad.ts', () => {
      const filePath = path.join(process.cwd(), 'src/lib/edge/pure/pure-cad.ts');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toContain("from 'sharp'");
      expect(content).not.toContain("from 'pdfkit'");
      expect(content).not.toContain("from 'zlib'");
      expect(content).not.toContain("from './vector-cad'");
      expect(content).not.toContain("from '../../conversions/vector-cad'");
    });

    it('pure-audio.ts strictly avoids Node Buffer globals and methods', () => {
      const filePath = path.join(process.cwd(), 'src/lib/edge/pure/pure-audio.ts');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toContain('Buffer.alloc');
      expect(content).not.toContain('Buffer.concat');
      expect(content).not.toContain('Buffer.from');
      expect(content).not.toContain(': Buffer');
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
  });

  // ==========================================================================
  // 3. Pure CAD Engine (STEP/IGES to STL/OBJ)
  // ==========================================================================
  describe('Pure CAD Engine (pure-cad.ts)', () => {
    const SAMPLE_STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Sample STEP model'),'2;1');
FILE_NAME('test.stp','2026-09-27',('Author'),('Org'),'','','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#10 = CARTESIAN_POINT('P1', (0.0, 0.0, 0.0));
#20 = CARTESIAN_POINT('P2', (10.0, 0.0, 0.0));
#30 = CARTESIAN_POINT('P3', (0.0, 10.0, 0.0));
#40 = CARTESIAN_POINT('P4', (10.0, 10.0, 0.0));
#50 = CARTESIAN_POINT('P5', (5.0, 5.0, 10.0));
#60 = CARTESIAN_POINT('P6', (0.0, 0.0, 0.0));
ENDSEC;
END-ISO-10303-21;`;

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
      expect(res.text).toContain('v 0 0 0');
      expect(res.text).toContain('v 10 0 0');
      expect(res.text).toContain('f ');
    });

    it('correctly handles Uint8Array input for CAD conversion', () => {
      const bytes = new TextEncoder().encode(SAMPLE_STEP);
      const res = convertPureCad(bytes, 'stp', 'stl');
      expect(res.text).toContain('solid');
      expect(res.data).toBeInstanceOf(Uint8Array);
    });

    it('fails closed when given empty or unparseable CAD content', () => {
      expect(() => convertPureCad('NOT A VALID STEP FILE', 'step', 'stl')).toThrow(
        /Failed to tessellate CAD geometry/
      );
    });
  });

  // ==========================================================================
  // 4. Pure Audio Engine (WAV/PCM/MP3)
  // ==========================================================================
  describe('Pure Audio Engine (pure-audio.ts)', () => {
    it('correctly reports audio format capability', () => {
      expect(isPureAudioConvertible('wav', 'mp3')).toBe(true);
      expect(isPureAudioConvertible('pcm', 'wav')).toBe(true);
      expect(isPureAudioConvertible('raw', 'mp3')).toBe(true);
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

    it('encodes PCM samples to compliant MP3 with ID3v2 metadata and sync frames', () => {
      const sampleCount = 1152 * 4; // 4 frames stereo
      const samples = new Int16Array(sampleCount * 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = (i % 2000) - 1000;
      }

      const mp3Bytes = encodePureMp3(samples, 44100, 2, '192k', 'Test Track');
      expect(mp3Bytes).toBeInstanceOf(Uint8Array);
      expect(mp3Bytes.length).toBeGreaterThan(100);

      // Verify ID3v2 header: 'ID3' at byte 0, version 3 at byte 3
      const id3Magic = String.fromCharCode(mp3Bytes[0], mp3Bytes[1], mp3Bytes[2]);
      expect(id3Magic).toBe('ID3');
      expect(mp3Bytes[3]).toBe(3); // ID3v2.3

      // Find MPEG-1 Layer III Sync Word (0xFF, 0xFB) after ID3 tag
      let foundSyncWord = false;
      for (let i = 10; i < mp3Bytes.length - 1; i++) {
        if (mp3Bytes[i] === 0xff && (mp3Bytes[i + 1] & 0xfe) === 0xfa) {
          foundSyncWord = true;
          break;
        }
      }
      expect(foundSyncWord).toBe(true);
    });

    it('executes end-to-end convertPureAudio for WAV to MP3', () => {
      const samples = new Int16Array(1152 * 2);
      const wavBytes = encodePcmToWav(samples, 44100, 2);

      const res = convertPureAudio(wavBytes, 'wav', 'mp3', {
        title: 'Isomorphic Edge Song',
      });
      expect(res.mimeType).toBe('audio/mpeg');
      expect(res.extension).toBe('mp3');
      expect(res.data.length).toBeGreaterThan(0);
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
      expect(view.getUint16(26, true)).toBe(1); // 1 plane
      expect(view.getUint16(28, true)).toBe(24); // 24-bit RGB
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
      expect(Array.isArray(caps.supportedVideoEncoders)).toBe(true);
    });

    it('routes pure data format pairs to Level 0 (Instant)', () => {
      const res = resolveConversionTier('csv', 'json', 5000);
      expect(res.tier).toBe('L0');
      expect(res.tierName).toBe('Edge L0 (Instant)');
      expect(res.isClientEdge).toBe(true);
    });

    it('routes pure CAD pairs to Level 0 (Instant)', () => {
      const res = resolveConversionTier('step', 'stl', 150000);
      expect(res.tier).toBe('L0');
      expect(res.tierName).toBe('Edge L0 (Instant)');
      expect(res.isClientEdge).toBe(true);
    });

    it('routes pure Audio pairs to Level 0 (Instant)', () => {
      const res = resolveConversionTier('wav', 'mp3', 44100);
      expect(res.tier).toBe('L0');
      expect(res.tierName).toBe('Edge L0 (Instant)');
      expect(res.isClientEdge).toBe(true);
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
      const opfsAvailable = resolveConversionTier('mp4', 'mp3', largeSize, {}, {
        hasOpfsSyncAccess: true,
      });
      expect(opfsAvailable.tier).toBe('L3');
      expect(opfsAvailable.tierName).toBe('Edge L3 (OPFS Stream)');
      expect(opfsAvailable.isClientEdge).toBe(true);

      const opfsUnavailable = resolveConversionTier('mp4', 'mp3', largeSize, {}, {
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

    it('executes pure data conversion through tryProcessClientEdge without calling server', async () => {
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

      expect(edgeRes).not.toBeNull();
      expect(edgeRes?.tier).toBe('L0');
      expect(edgeRes?.tierName).toBe('Edge L0 (Instant)');
      expect(edgeRes?.resultUrl).toBe(fakeUrl);
      expect(edgeRes?.resultSize).toBeGreaterThan(0);
      expect(onProgress).toHaveBeenCalled();
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
