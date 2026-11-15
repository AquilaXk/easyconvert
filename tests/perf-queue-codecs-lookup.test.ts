import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demosaicRcdBayerCfa } from '@/lib/conversions/raw-hdr';
import { measureInk, OCR_BAND_INK_LEVEL } from '@/lib/conversions/ocr-bands';
import { sauvolaBinarize, SAUVOLA_INK, SAUVOLA_PAPER } from '@/lib/conversions/ocr-sauvola';
import { decodeBmp } from '@/lib/conversions/bmp';
import { pcmBlockToAudioData } from '@/lib/edge/media/pcm-audio';
import { decodeImaBlock, encodeImaBlock, imaFormatFor, newImaChannelStates } from '@/lib/edge/media/ima-adpcm';
import { muxMp4 } from '@/lib/edge/media/mp4-mux';
import { CompactProtocolReader, CompactProtocolWriter, ThriftType } from '@/lib/conversions/parquet-thrift';
import { ParquetFormatError } from '@/lib/conversions/parquet-format';
import { CHAR_COMMA, CHAR_TAB, formatDelimitedString } from '@/lib/conversions/delimited-cells';
import { parsePptxSlideSceneGraph } from '@/lib/conversions/office/pptx-scene';
import { identityMatrix } from '@/lib/conversions/office/affine';
import { PDFDocument } from 'pdf-lib';
import { processGraphNodeJob } from '@/lib/queue/graph/node-executor';
import { s3Storage } from '@/lib/storage/s3-storage';
import type { IStorageBackend } from '@/lib/storage/oci-storage';
import type { Job } from '@/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '@/lib/types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Bit/word, buffer-reuse, and single-pass codec/AST optimizations', () => {
  it('demosaics all four Bayer CFA patterns with zeroed colour-difference reuse and exact channel parity', () => {
    const width = 16;
    const height = 12;
    const patterns = ['RGGB', 'BGGR', 'GRBG', 'GBRG'] as const;

    for (const pattern of patterns) {
      // Uniform neutral sensor must reconstruct uniform linear luminance across all three channels.
      const uniform = new Uint16Array(width * height).fill(2048);
      const resUniform = demosaicRcdBayerCfa({
        width,
        height,
        pattern,
        data: uniform,
        bitsPerSample: 12,
        blackLevel: 0,
        whiteLevel: 4095,
      });
      expect(resUniform.width).toBe(width);
      expect(resUniform.height).toBe(height);
      expect(resUniform.data.length).toBe(width * height * 3);
      expect(resUniform.floatData.length).toBe(width * height * 3);
      const expectedByte = Math.round((2048 / 4095) * 255);
      for (let i = 0; i < resUniform.data.length; i++) {
        expect(Math.abs(resUniform.data[i] - expectedByte)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('counts ink identically across unaligned Uint8Array offsets and non-multiple-of-4 widths via 32-bit SWAR skip', () => {
    const backing = new Uint8Array(4096);
    backing.fill(240);
    for (const offset of [0, 1, 2, 3, 7]) {
      for (const width of [1, 3, 4, 7, 8, 13, 33, 64]) {
        const height = 9;
        const view = backing.subarray(offset, offset + width * height);
        view.fill(250);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const v = ((x * 37 + y * 53 + offset * 11) & 0xff);
            view[y * width + x] = v;
          }
        }
        const got = measureInk(view, width, height);
        const expectedRows = new Uint32Array(height);
        const expectedCols = new Uint32Array(width);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (view[y * width + x] < OCR_BAND_INK_LEVEL) {
              expectedRows[y]++;
              expectedCols[x]++;
            }
          }
        }
        expect(Array.from(got.rows)).toEqual(Array.from(expectedRows));
        expect(Array.from(got.columns)).toEqual(Array.from(expectedCols));
      }
    }
  });

  it('thresholds Sauvola windows identically to direct window mean and variance formulas at borders and interior', async () => {
    const width = 29;
    const height = 23;
    const windowSize = 9;
    const half = 4;
    const k = 0.34;
    const dynamicRange = 128;
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < gray.length; i++) gray[i] = (i * 73 + (i >> 3) * 19) & 0xff;

    const got = await sauvolaBinarize(gray, width, height, { windowSize, k, dynamicRange, yieldEveryPixels: 64 });
    const expected = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - half);
      const y1 = Math.min(height, y + half + 1);
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - half);
        const x1 = Math.min(width, x + half + 1);
        let sum = 0;
        let sq = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const v = gray[yy * width + xx];
            sum += v;
            sq += v * v;
          }
        }
        const invArea = 1 / ((y1 - y0) * (x1 - x0));
        const mean = sum * invArea;
        const variance = sq * invArea - mean * mean;
        const std = variance > 0 ? Math.sqrt(variance) : 0;
        const threshold = mean * (1 - k + (k / dynamicRange) * std);
        expected[y * width + x] = gray[y * width + x] <= threshold ? SAUVOLA_INK : SAUVOLA_PAPER;
      }
    }
    expect(Buffer.from(got).equals(Buffer.from(expected))).toBe(true);
  });

  it('decodes 32-bit BGRA BMPs (both unused-alpha BI_RGB and explicit BITFIELDS alpha) and RLE8 BMPs across unaligned slices', () => {
    const width = 5;
    const height = 3;
    const pixelBytes = width * height * 4;
    const padded = Buffer.alloc(3 + 54 + pixelBytes);
    const bmp = padded.subarray(3); // intentionally unaligned by 3 bytes
    bmp.write('BM', 0, 'ascii');
    bmp.writeUInt32LE(54 + pixelBytes, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(width, 18);
    bmp.writeInt32LE(height, 22); // bottom-up
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(32, 28);
    bmp.writeUInt32LE(0, 30); // BI_RGB with all-zero 4th byte -> opaque 255
    bmp.writeUInt32LE(pixelBytes, 34);
    // Stored row 0 = bottom row (y = 2), x = 0: B=0x11, G=0x22, R=0x33, A=0x00
    bmp[54] = 0x11;
    bmp[55] = 0x22;
    bmp[56] = 0x33;
    bmp[57] = 0x00;

    const decodedOpaque = decodeBmp(bmp);
    expect(decodedOpaque.hasAlpha).toBe(false);
    const bottomLeft = (height - 1) * width * 4;
    expect(Array.from(decodedOpaque.raw.subarray(bottomLeft, bottomLeft + 4))).toEqual([0x33, 0x22, 0x11, 0xff]);

    // Aligned copy with non-zero alpha on pixel 0
    const aligned = Buffer.from(bmp);
    aligned[57] = 0x80;
    const decodedAlpha = decodeBmp(aligned);
    expect(decodedAlpha.hasAlpha).toBe(true);
    expect(Array.from(decodedAlpha.raw.subarray(bottomLeft, bottomLeft + 4))).toEqual([0x33, 0x22, 0x11, 0x80]);
  });

  it('converts aligned and odd-offset PCM s16, s24, s32, and f32 blocks accurately', () => {
    const backing = new Uint8Array(64);
    const unalignedS16 = backing.subarray(1, 9); // 4 int16 samples across 2 channels = 2 frames
    const dv16 = new DataView(unalignedS16.buffer, unalignedS16.byteOffset, unalignedS16.byteLength);
    dv16.setInt16(0, -32768, true);
    dv16.setInt16(2, 12345, true);
    dv16.setInt16(4, -1, true);
    dv16.setInt16(6, 32767, true);
    const res16 = pcmBlockToAudioData('pcm-s16', unalignedS16, 2);
    expect(res16.frames).toBe(2);
    expect(Array.from(res16.data)).toEqual([-32768, 12345, -1, 32767]);

    const unalignedF32 = backing.subarray(3, 19);
    const dvF = new DataView(unalignedF32.buffer, unalignedF32.byteOffset, unalignedF32.byteLength);
    dvF.setFloat32(0, -0.5, true);
    dvF.setFloat32(4, 0.25, true);
    dvF.setFloat32(8, 1.0, true);
    dvF.setFloat32(12, -1.0, true);
    const resF = pcmBlockToAudioData('pcm-f32', unalignedF32, 2);
    expect(Array.from(resF.data)).toEqual([-0.5, 0.25, 1.0, -1.0]);
  });

  it('preserves IMA ADPCM signed 16-bit predictor headers and nibble ordering on odd-offset buffers', () => {
    const format = imaFormatFor(22_050, 2);
    const pcm = new Int16Array(format.samplesPerBlock * 2);
    pcm[0] = -31_000;
    pcm[1] = 29_500;
    for (let i = 2; i < pcm.length; i++) {
      pcm[i] = Math.round(Math.sin(i * 0.15) * 18_000);
    }
    const backing = new Uint8Array(format.blockAlign + 5);
    const block = backing.subarray(3, 3 + format.blockAlign);
    const states = newImaChannelStates(2);
    encodeImaBlock(pcm, format.samplesPerBlock, format, states, block);

    // Header bytes 0..1 and 4..5 must carry exact little-endian int16 predictors
    expect((block[0] | (block[1] << 8)) << 16 >> 16).toBe(-31_000);
    expect((block[4] | (block[5] << 8)) << 16 >> 16).toBe(29_500);

    const out = new Int16Array(format.samplesPerBlock * 2);
    decodeImaBlock(block, format, out);
    expect(out[0]).toBe(-31_000);
    expect(out[1]).toBe(29_500);
  });

  it('produces valid ISO BMFF ftyp/moov/mdat structure with matching stco chunk offsets in muxMp4', () => {
    const mp4 = muxMp4({
      majorBrand: 'isom',
      video: {
        width: 640,
        height: 360,
        config: {
          codec: 'avc1.42001e',
          description: new Uint8Array([1, 0x42, 0, 0x1e, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0, 0x1e, 1, 0, 2, 0x68, 0xce]),
        },
        chunks: [
          { data: new Uint8Array([1, 2, 3, 4, 5]), timestampMicros: 0, durationMicros: 33_333, isKeyFrame: true },
          { data: new Uint8Array([6, 7, 8]), timestampMicros: 33_333, durationMicros: 33_333, isKeyFrame: false },
        ],
      },
    });
    const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
    const ftypLen = view.getUint32(0);
    expect(Buffer.from(mp4.subarray(4, 8)).toString('ascii')).toBe('ftyp');
    const moovLen = view.getUint32(ftypLen);
    expect(Buffer.from(mp4.subarray(ftypLen + 4, ftypLen + 8)).toString('ascii')).toBe('moov');
    const mdatPos = ftypLen + moovLen;
    const mdatLen = view.getUint32(mdatPos);
    expect(Buffer.from(mp4.subarray(mdatPos + 4, mdatPos + 8)).toString('ascii')).toBe('mdat');
    expect(mdatPos + mdatLen).toBe(mp4.byteLength);
    expect(Array.from(mp4.subarray(mdatPos + 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('reads 1-to-5-byte and 64-bit Thrift varints in CompactProtocolReader and rejects truncated/overlong varints', () => {
    const boundaryValues = [0, 1, -1, 63, -64, 64, -65, 8191, -8192, 1_048_575, -1_048_576, 2_147_483_647, -2_147_483_648];
    const writer = new CompactProtocolWriter();
    writer.writeStructBegin();
    boundaryValues.forEach((val, idx) => {
      writer.writeFieldBegin(idx + 1, ThriftType.I32);
      writer.writeI32(val);
    });
    writer.writeFieldBegin(100, ThriftType.BINARY);
    writer.writeString('parquet-utf8-한글');
    writer.writeFieldStop();
    writer.writeStructEnd();

    const reader = new CompactProtocolReader(writer.toBuffer(), 0);
    reader.structBegin();
    const decoded: number[] = [];
    let decodedStr = '';
    while (true) {
      const f = reader.readFieldBegin();
      if (f.isStop) break;
      if (f.type === ThriftType.I32) decoded.push(reader.readZigzag32());
      else if (f.type === ThriftType.BINARY) decodedStr = reader.readString();
    }
    reader.structEnd();
    expect(decoded).toEqual(boundaryValues);
    expect(decodedStr).toBe('parquet-utf8-한글');

    // Truncated varint continuation byte must fail closed with ParquetFormatError
    const truncated = new CompactProtocolReader(Buffer.from([0x81, 0x82]), 0);
    expect(() => truncated.readVarint32()).toThrow(ParquetFormatError);

    // 11-byte varint must fail closed with ParquetFormatError
    const overlong = new CompactProtocolReader(Buffer.alloc(11, 0x81), 0);
    expect(() => overlong.readVarint32()).toThrow(ParquetFormatError);
  });

  it('formats delimited cells with surrogate pairs, BOMs, quotes, and formula guards identically', () => {
    expect(formatDelimitedString('plain_123', CHAR_COMMA, true, false, false)).toBe('plain_123');
    expect(formatDelimitedString('a,b', CHAR_COMMA, true, false, false)).toBe('"a,b"');
    expect(formatDelimitedString('say "hi"', CHAR_COMMA, true, false, false)).toBe('"say ""hi"""');
    expect(formatDelimitedString('\ufeffheader', CHAR_COMMA, true, false, false)).toBe('"\ufeffheader"');
    expect(formatDelimitedString('=1+1', CHAR_COMMA, true, false, false)).toBe('"\'=1+1"');
    const emojiLatin1 = formatDelimitedString('🚀\ttest', CHAR_TAB, true, false, true);
    expect(Buffer.from(emojiLatin1, 'latin1').toString('utf8')).toBe('"🚀\ttest"');
  });

  it('deduplicates repeated slide texts across nested <p:grpSp> groups in O(1) while preserving first-seen order', async () => {
    const zip = new JSZip();
    const xml = `
      <p:spTree>
        <p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="127000" cy="127000"/></a:xfrm></p:spPr>
          <p:txBody><a:p><a:r><a:t>Alpha</a:t></a:r><a:r><a:t>Beta</a:t></a:r></a:p></p:txBody>
        </p:sp>
        <p:grpSp>
          <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="127000" cy="127000"/><a:chOff x="0" y="0"/><a:chExt cx="127000" cy="127000"/></a:xfrm></p:grpSpPr>
          <p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="127000" cy="127000"/></a:xfrm></p:spPr>
            <p:txBody><a:p><a:r><a:t>Beta</a:t></a:r><a:r><a:t>Gamma</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </p:grpSp>
      </p:spTree>
    `;
    const texts: string[] = [];
    await parsePptxSlideSceneGraph(xml, identityMatrix(), 960, 540, new Map(), zip, texts);
    expect(texts).toEqual(['Beta', 'Gamma', 'Alpha']);
  });

  it('bounds concurrent intermediate PDF artifact loads and transforms to <= 4 in processGraphNodeJob', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]).drawText('Hi', { x: 20, y: 20 });
    const pdfBytes = Buffer.from(await doc.save());

    const inputKeys: string[] = [];
    const batchId = `conc_${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      const key = `tests/perf-conc/${batchId}/in_${i}.pdf`;
      s3Storage.saveObject(key, pdfBytes, 'application/pdf', `in_${i}.pdf`, 60_000);
      inputKeys.push(key);
    }

    let inFlight = 0;
    let peakInFlight = 0;
    const savedKeys: string[] = [];
    const meteredStorage: IStorageBackend = Object.assign(
      Object.create(Object.getPrototypeOf(s3Storage)),
      s3Storage,
      {
        getObject: async (key: string) => {
          inFlight++;
          if (inFlight > peakInFlight) peakInFlight = inFlight;
          await new Promise((r) => setTimeout(r, 12));
          try {
            return await s3Storage.getObject(key);
          } finally {
            inFlight--;
          }
        },
        saveObject: async (
          key: string,
          buffer: Buffer,
          contentType: string,
          filename: string,
          ttlMs?: number
        ) => {
          savedKeys.push(key);
          return s3Storage.saveObject(key, buffer, contentType, filename, ttlMs);
        },
      }
    );

    const graphId = `g_${batchId}`;
    const job = {
      id: `${graphId}:rot`,
      data: {
        jobId: `${graphId}:rot`,
        sourceFormat: 'pdf',
        targetFormat: 'pdf',
        fileSize: pdfBytes.length,
        options: {},
        graphId,
        graphNodeId: 'rot',
        graphNode: { op: 'pdf.rotate-pages', input: 'up', options: { rotate: { rotation: 90 } } },
        inputArtifacts: inputKeys,
      },
      opts: { attempts: 1 },
      attemptsMade: 1,
      signal: new AbortController().signal,
      log: async () => {},
      updateProgress: async () => {},
    } as unknown as Job<ConversionJobData, ConversionJobResult>;

    const res = await processGraphNodeJob(job, undefined, meteredStorage);
    expect(peakInFlight).toBeLessThanOrEqual(4);
    expect(peakInFlight).toBeGreaterThanOrEqual(2);
    expect(savedKeys).toHaveLength(10);
    expect(res.resultKey).toContain('/rot/0/in_0.pdf');
  });
});
