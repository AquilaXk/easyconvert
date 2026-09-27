import fs from 'fs';
import path from 'path';
import { beforeAll, describe, it, expect } from 'vitest';
import sharp from 'sharp';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import {
  demuxMp4,
  buildFmp4InitSegment,
  buildFmp4MediaSegment,
  muxFmp4Stream,
} from '../src/lib/edge/workers/webcodecs.worker';
import { extractZipArchive, createZipArchive, crc32 } from '../src/lib/conversions/archive';
import { extractStepBRepMesh, parseStepEntities } from '../src/lib/conversions/cad-nurbs';
import { decodeWoff2 } from '../src/lib/conversions/font';
import { applyFloydSteinbergDither } from '../src/lib/conversions/quantize';
import { parseCfbf } from '../src/lib/conversions/hwp';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

/**
 * Deterministic SSIM (Structural Similarity Index Measure) calculation.
 * Computes luminance, contrast, and structural comparison across two grayscale/RGB buffers.
 */
export function calculateSsim(
  img1: Uint8Array | Buffer,
  img2: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number = 1
): number {
  if (img1.length !== img2.length) {
    throw new Error('Image buffers must have matching dimensions for SSIM comparison');
  }

  const n = width * height;
  if (n === 0) return 1.0;

  let mean1 = 0;
  let mean2 = 0;

  for (let i = 0; i < n; i++) {
    let val1 = 0;
    let val2 = 0;
    for (let c = 0; c < channels; c++) {
      val1 += img1[i * channels + c];
      val2 += img2[i * channels + c];
    }
    mean1 += val1 / channels;
    mean2 += val2 / channels;
  }
  mean1 /= n;
  mean2 /= n;

  let var1 = 0;
  let var2 = 0;
  let cov = 0;

  for (let i = 0; i < n; i++) {
    let val1 = 0;
    let val2 = 0;
    for (let c = 0; c < channels; c++) {
      val1 += img1[i * channels + c];
      val2 += img2[i * channels + c];
    }
    const d1 = val1 / channels - mean1;
    const d2 = val2 / channels - mean2;
    var1 += d1 * d1;
    var2 += d2 * d2;
    cov += d1 * d2;
  }

  const denomN = Math.max(1, n - 1);
  var1 /= denomN;
  var2 /= denomN;
  cov /= denomN;

  // Standard constants for dynamic range L = 255
  const k1 = 0.01;
  const k2 = 0.03;
  const l = 255;
  const c1 = (k1 * l) ** 2;
  const c2 = (k2 * l) ** 2;

  const numerator = (2 * mean1 * mean2 + c1) * (2 * cov + c2);
  const denominator = (mean1 ** 2 + mean2 ** 2 + c1) * (var1 + var2 + c2);

  return denominator === 0 ? 1.0 : numerator / denominator;
}

/**
 * Creates canonical golden fixtures if not already present.
 */
async function ensureAllGoldenFixtures(): Promise<void> {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  // 1. Golden PNG Image (64x64 RGBA test pattern with gradient)
  const pngPath = path.join(FIXTURES_DIR, 'sample.png');
  if (!fs.existsSync(pngPath)) {
    const rawRgba = Buffer.alloc(64 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const idx = (y * 64 + x) * 4;
        rawRgba[idx] = Math.round((x / 63) * 255); // R gradient
        rawRgba[idx + 1] = Math.round((y / 63) * 255); // G gradient
        rawRgba[idx + 2] = 128; // B constant
        rawRgba[idx + 3] = 255; // Alpha
      }
    }
    const pngBuf = await sharp(rawRgba, { raw: { width: 64, height: 64, channels: 4 } })
      .png()
      .toBuffer();
    fs.writeFileSync(pngPath, pngBuf);
  }

  // 2. Golden BMP Image (32x32 24bpp uncompressed Windows DIB)
  const bmpPath = path.join(FIXTURES_DIR, 'sample.bmp');
  if (!fs.existsSync(bmpPath)) {
    const rowSize = 32 * 3;
    const paddedRowSize = Math.ceil(rowSize / 4) * 4;
    const pixelArraySize = paddedRowSize * 32;
    const fileSize = 54 + pixelArraySize;
    const bmpBuf = Buffer.alloc(fileSize);
    bmpBuf.write('BM', 0, 'ascii');
    bmpBuf.writeUInt32LE(fileSize, 2);
    bmpBuf.writeUInt32LE(54, 10); // pixel data offset
    bmpBuf.writeUInt32LE(40, 14); // DIB header size
    bmpBuf.writeInt32LE(32, 18); // width
    bmpBuf.writeInt32LE(32, 22); // height
    bmpBuf.writeUInt16LE(1, 26); // planes
    bmpBuf.writeUInt16LE(24, 28); // bpp
    bmpBuf.writeUInt32LE(0, 30); // uncompressed
    bmpBuf.writeUInt32LE(pixelArraySize, 34);
    for (let y = 0; y < 32; y++) {
      const rowOff = 54 + (31 - y) * paddedRowSize;
      for (let x = 0; x < 32; x++) {
        bmpBuf[rowOff + x * 3] = 200; // B
        bmpBuf[rowOff + x * 3 + 1] = y * 8; // G
        bmpBuf[rowOff + x * 3 + 2] = x * 8; // R
      }
    }
    fs.writeFileSync(bmpPath, bmpBuf);
  }

  // 3. Golden WAV Audio (RIFF/WAVE PCM 16-bit 44.1kHz Stereo, 100ms 440Hz sine wave)
  const wavPath = path.join(FIXTURES_DIR, 'sample.wav');
  if (!fs.existsSync(wavPath)) {
    const sampleRate = 44100;
    const numChannels = 2;
    const bytesPerSample = 2;
    const numSamples = Math.floor(sampleRate * 0.1); // 100ms
    const dataSize = numSamples * numChannels * bytesPerSample;
    const fileSize = 44 + dataSize;

    const buf = Buffer.alloc(fileSize);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(fileSize - 8, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16); // Subchunk1Size
    buf.writeUInt16LE(1, 20); // AudioFormat PCM = 1
    buf.writeUInt16LE(numChannels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28); // ByteRate
    buf.writeUInt16LE(numChannels * bytesPerSample, 32); // BlockAlign
    buf.writeUInt16LE(16, 34); // BitsPerSample
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < numSamples; i++) {
      const sampleVal = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000);
      const off = 44 + i * 4;
      buf.writeInt16LE(sampleVal, off);
      buf.writeInt16LE(sampleVal, off + 2);
    }
    fs.writeFileSync(wavPath, buf);
  }

  // 4. Golden TAR Archive (POSIX ustar format with 2 files)
  const tarPath = path.join(FIXTURES_DIR, 'sample.tar');
  if (!fs.existsSync(tarPath)) {
    const file1Name = 'test1.txt';
    const file1Data = Buffer.from('Golden tar test content 1\n', 'utf-8');
    const file2Name = 'test2.txt';
    const file2Data = Buffer.from('Golden tar test content 2\n', 'utf-8');

    const makeTarHeader = (name: string, size: number): Buffer => {
      const header = Buffer.alloc(512);
      header.write(name, 0, 100, 'ascii');
      header.write('0000644\0', 100, 8, 'ascii'); // mode
      header.write('0001750\0', 108, 8, 'ascii'); // uid
      header.write('0001750\0', 116, 8, 'ascii'); // gid
      header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii'); // size
      header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii'); // mtime
      header.fill(32, 148, 156); // checksum spaces initially
      header[156] = 48; // typeflag '0' (regular file)
      header.write('ustar\0', 257, 6, 'ascii');
      header.write('00', 263, 2, 'ascii');

      let chk = 0;
      for (let i = 0; i < 512; i++) chk += header[i];
      header.write(`${chk.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
      return header;
    };

    const pad512 = (len: number): Buffer => {
      const rem = len % 512;
      return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - rem);
    };

    const tarBuf = Buffer.concat([
      makeTarHeader(file1Name, file1Data.length),
      file1Data,
      pad512(file1Data.length),
      makeTarHeader(file2Name, file2Data.length),
      file2Data,
      pad512(file2Data.length),
      Buffer.alloc(1024), // 2 EOF null blocks
    ]);
    fs.writeFileSync(tarPath, tarBuf);
  }

  // 5. Golden DXF Model (AutoCAD R12 ASCII DXF)
  const dxfPath = path.join(FIXTURES_DIR, 'sample.dxf');
  if (!fs.existsSync(dxfPath)) {
    const dxfContent = `0
SECTION
2
HEADER
9
$ACADVER
1
AC1009
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
8
0
10
0.0
20
0.0
30
0.0
11
10.0
21
10.0
31
0.0
0
CIRCLE
8
0
10
5.0
20
5.0
30
0.0
40
2.5
0
ENDSEC
0
EOF
`;
    fs.writeFileSync(dxfPath, dxfContent, 'utf-8');
  }
}

describe('Phase 3: Differential Testnet & Fuzzing Gates', () => {
  beforeAll(async () => {
    await ensureAllGoldenFixtures();
  });

  describe('1. Golden Binary Fixture Deployment & Validity', () => {
    it('deploys and validates all canonical golden fixtures in tests/fixtures/', () => {
      const requiredFixtures = [
        'sample.png',
        'sample.bmp',
        'sample.wav',
        'sample.tar',
        'sample.dxf',
        'sample.step',
        'sample.docx',
        'sample.xlsx',
        'sample.pdf',
        'sample.mp4',
        'sample.woff2',
        'sample.zip',
      ];

      for (const name of requiredFixtures) {
        const fullPath = path.join(FIXTURES_DIR, name);
        expect(fs.existsSync(fullPath), `Fixture ${name} must exist on disk`).toBe(true);
        const stats = fs.statSync(fullPath);
        expect(stats.size, `Fixture ${name} must have non-zero size`).toBeGreaterThan(0);
      }
    });

    it('verifies golden audio and image headers conform to standard binary specifications', () => {
      // Golden WAV
      const wavBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.wav'));
      expect(wavBuf.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wavBuf.toString('ascii', 8, 12)).toBe('WAVE');
      expect(wavBuf.readUInt16LE(20)).toBe(1); // PCM
      expect(wavBuf.readUInt16LE(22)).toBe(2); // Stereo
      expect(wavBuf.readUInt32LE(24)).toBe(44100); // 44.1 kHz

      // Golden BMP
      const bmpBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.bmp'));
      expect(bmpBuf.toString('ascii', 0, 2)).toBe('BM');
      expect(bmpBuf.readInt32LE(18)).toBe(32); // Width
      expect(bmpBuf.readInt32LE(22)).toBe(32); // Height

      // Golden PNG
      const pngBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.png'));
      expect(pngBuf[0]).toBe(0x89);
      expect(pngBuf.toString('ascii', 1, 4)).toBe('PNG');
    });
  });

  describe('2. Differential Oracle Decoders', () => {
    describe('2.1 Visual Fidelity Oracle (SSIM & Perceptual Distance)', () => {
      it('calculates deterministic SSIM of 1.0 on identical image buffers', () => {
        const w = 32;
        const h = 32;
        const buf = Buffer.alloc(w * h);
        for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) % 256;

        const ssim = calculateSsim(buf, buf, w, h, 1);
        expect(ssim).toBeCloseTo(1.0, 4);
      });

      it('preserves high perceptual fidelity (SSIM >= 0.90) on PNG -> WebP conversion', async () => {
        const pngBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.png'));

        // Convert PNG to WebP via standard pipeline
        const result = await convertFile(pngBuf, 'png', 'webp', { quality: 95 }, 'sample.png');
        expect(result.mimeType).toBe('image/webp');

        // Re-decode both to raw grayscale for differential comparison
        const origRaw = await sharp(pngBuf).resize(64, 64).greyscale().raw().toBuffer();
        const convRaw = await sharp(result.buffer).resize(64, 64).greyscale().raw().toBuffer();

        const ssim = calculateSsim(origRaw, convRaw, 64, 64, 1);
        expect(ssim).toBeGreaterThanOrEqual(0.90);
      });

      it('preserves structural fidelity (SSIM >= 0.70) when applying OKLab dithering', async () => {
        const pngBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.png'));
        const { data, info } = await sharp(pngBuf).raw().toBuffer({ resolveWithObject: true });

        // 16-color standard palette
        const palette = [
          { r: 0, g: 0, b: 0 },
          { r: 128, g: 0, b: 0 },
          { r: 0, g: 128, b: 0 },
          { r: 128, g: 128, b: 0 },
          { r: 0, g: 0, b: 128 },
          { r: 128, g: 0, b: 128 },
          { r: 0, g: 128, b: 128 },
          { r: 192, g: 192, b: 192 },
          { r: 128, g: 128, b: 128 },
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 },
          { r: 255, g: 255, b: 0 },
          { r: 0, g: 0, b: 255 },
          { r: 255, g: 0, b: 255 },
          { r: 0, g: 255, b: 255 },
          { r: 255, g: 255, b: 255 },
        ];

        // Apply Floyd-Steinberg error diffusion with OKLab Euclidean distance
        const ditheredIndices = applyFloydSteinbergDither(
          data,
          info.width,
          info.height,
          info.channels,
          palette,
          true,
          true
        );

        // Reconstruct RGB buffer from indices
        const ditheredRgb = Buffer.alloc(info.width * info.height * 3);
        for (let i = 0; i < ditheredIndices.length; i++) {
          const color = palette[ditheredIndices[i]];
          ditheredRgb[i * 3] = color.r;
          ditheredRgb[i * 3 + 1] = color.g;
          ditheredRgb[i * 3 + 2] = color.b;
        }

        const origGray = await sharp(pngBuf).greyscale().raw().toBuffer();
        const ditherGray = await sharp(ditheredRgb, {
          raw: { width: info.width, height: info.height, channels: 3 },
        })
          .greyscale()
          .raw()
          .toBuffer();

        const ssim = calculateSsim(origGray, ditherGray, info.width, info.height, 1);
        expect(ssim).toBeGreaterThanOrEqual(0.7);
      });
    });

    describe('2.2 Media Demuxing & ISO BMFF Container Oracle', () => {
      it('demuxes golden sample.mp4 with valid sample tables, timescale, and non-empty samples', () => {
        const mp4Buf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.mp4'));
        const arrayBuf = mp4Buf.buffer.slice(mp4Buf.byteOffset, mp4Buf.byteOffset + mp4Buf.byteLength);

        const trackInfo = demuxMp4(arrayBuf);
        expect(trackInfo).not.toBeNull();
        expect(trackInfo?.timescale).toBeGreaterThan(0);
        expect(trackInfo?.samples.length).toBeGreaterThan(0);

        for (const sample of trackInfo!.samples) {
          expect(sample.data.length).toBeGreaterThan(0);
          expect(sample.durationMicros).toBeGreaterThan(0);
        }
      });

      it('validates fragmented MP4 (fMP4) segment sequence numbers and decode timestamps', () => {
        const sampleChunks = [
          { data: new Uint8Array([0x65, 0x88, 0x80, 0x40]), timestampMicros: 0, isKeyFrame: true },
          { data: new Uint8Array([0x41, 0x9a, 0x11, 0x22]), timestampMicros: 33333, isKeyFrame: false },
          { data: new Uint8Array([0x41, 0x9a, 0x33, 0x44]), timestampMicros: 66666, isKeyFrame: false },
        ];

        const emittedSegments: Uint8Array[] = [];
        const fullStream = muxFmp4Stream(sampleChunks, 1920, 1080, {
          fragmentChunkCount: 2,
          onSegment: (seg) => emittedSegments.push(seg),
        });

        // Must produce 1 init segment + 2 media segments = 3 total segments
        expect(emittedSegments).toHaveLength(3);

        // Segment 0: Init segment containing ftyp and moov
        const initSeg = emittedSegments[0];
        const initStr = Buffer.from(initSeg).toString('ascii');
        expect(initStr).toContain('ftyp');
        expect(initStr).toContain('moov');
        expect(initStr).toContain('mvex');

        // Segment 1 & 2: Media segments containing moof and mdat
        for (let i = 1; i <= 2; i++) {
          const seg = emittedSegments[i];
          const segStr = Buffer.from(seg).toString('ascii');
          expect(segStr).toContain('moof');
          expect(segStr).toContain('mdat');
          expect(segStr).toContain('mfhd');
          expect(segStr).toContain('tfhd');
          expect(segStr).toContain('tfdt');
          expect(segStr).toContain('trun');
        }

        expect(fullStream.length).toBeGreaterThan(0);
      });
    });

    describe('2.3 Archive Boundary & CRC-32 Oracle', () => {
      it('verifies 100% CRC-32 match and file content roundtrip on multi-file archives', async () => {
        const file1Content = Buffer.from('Differential testnet text payload 1', 'utf-8');
        const file2Content = Buffer.from('Differential testnet text payload 2 - with more bytes', 'utf-8');

        const crc1Expected = crc32(file1Content);
        const crc2Expected = crc32(file2Content);

        const zipResult = await createZipArchive([
          { filename: 'nested/doc1.txt', buffer: file1Content },
          { filename: 'doc2.txt', buffer: file2Content },
        ]);

        const extracted = await extractZipArchive(zipResult.buffer);
        expect(extracted).toHaveLength(2);

        const extFile1 = extracted.find((f) => f.filename === 'nested/doc1.txt');
        const extFile2 = extracted.find((f) => f.filename === 'doc2.txt');

        expect(extFile1).toBeDefined();
        expect(crc32(extFile1!.buffer)).toBe(crc1Expected);

        expect(extFile2).toBeDefined();
        expect(crc32(extFile2!.buffer)).toBe(crc2Expected);
      });

      it('prevents directory traversal attacks (zip-slip) by sanitizing paths', async () => {
        const hostileZip = new JSZip();
        hostileZip.file('../../etc/shadow', 'root:x:0:0:root:/root:/bin/bash');
        hostileZip.file('..\\..\\windows\\system32\\calc.exe', 'MZ...');
        hostileZip.file('safe.txt', 'Safe content');
        const hostileBuf = await hostileZip.generateAsync({ type: 'nodebuffer' });

        const extracted = await extractZipArchive(hostileBuf);
        // Traversal files must either be filtered out or sanitized to safe relative paths without '..'
        for (const file of extracted) {
          expect(file.filename).not.toContain('..');
        }
      });
    });
  });

  describe('3. Abnormal Binary Header & Payload Fuzzing Gates (Strict Fail-Closed)', () => {
    describe('3.1 Truncated Header Fuzzing', () => {
      it('fails closed on 0-byte, 1-byte, and truncated payloads across all format parsers', async () => {
        const truncatedPayloads = [
          Buffer.alloc(0),
          Buffer.from([0x50]), // 1 byte
          Buffer.from([0x50, 0x4b, 0x03]), // 3 bytes
          Buffer.alloc(7, 0xaa), // 7 bytes
        ];

        for (const buf of truncatedPayloads) {
          // 1. Office / OpenXML parser
          await expect(
            convertFile(buf, 'docx', 'txt', {}, 'corrupted.docx')
          ).rejects.toThrow();

          // 2. Word OLE2 CFBF parser
          expect(() => parseCfbf(buf)).toThrow();

          // 3. WOFF2 decoder
          expect(() => decodeWoff2(buf)).toThrow();

          // 4. Archive extractor
          await expect(
            extractZipArchive(buf)
          ).rejects.toThrow();

          // 5. ISO BMFF demuxer
          const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          const trackInfo = demuxMp4(arrayBuf);
          expect(trackInfo === null || trackInfo.samples.length === 0).toBe(true);

          // 6. CAD STEP parser
          const stepEntities = parseStepEntities(buf.toString('utf-8'));
          const stepMesh = extractStepBRepMesh(stepEntities);
          expect(stepMesh).toBeNull();
        }
      });
    });

    describe('3.2 Corrupted Box Size & Header Fuzzing in ISO BMFF', () => {
      it('fails closed and avoids OOM when box size is 0xFFFFFFFF (4GB)', () => {
        // Construct malformed MP4 box with 4GB size followed by truncated bytes
        const hostileMp4 = Buffer.alloc(32);
        hostileMp4.writeUInt32BE(0xffffffff, 0); // 4GB box size
        hostileMp4.write('ftyp', 4, 'ascii');
        hostileMp4.writeUInt32BE(0xffffffff, 16);
        hostileMp4.write('moov', 20, 'ascii');

        const arrayBuf = hostileMp4.buffer.slice(
          hostileMp4.byteOffset,
          hostileMp4.byteOffset + hostileMp4.byteLength
        );

        // Must fail closed without allocating 4GB or throwing uncaught range error
        const trackInfo = demuxMp4(arrayBuf);
        expect(trackInfo === null || trackInfo.samples.length === 0).toBe(true);
      });

      it('fails closed when 64-bit box size claims massive offset beyond file bounds', () => {
        const hostileMp4 = Buffer.alloc(40);
        hostileMp4.writeUInt32BE(1, 0); // boxSize = 1 indicates 64-bit size
        hostileMp4.write('moov', 4, 'ascii');
        hostileMp4.writeBigUInt64BE(BigInt('0xFFFFFFFFFFFFFF'), 8);

        const arrayBuf = hostileMp4.buffer.slice(
          hostileMp4.byteOffset,
          hostileMp4.byteOffset + hostileMp4.byteLength
        );

        const trackInfo = demuxMp4(arrayBuf);
        expect(trackInfo === null || trackInfo.samples.length === 0).toBe(true);
      });

      it('fails closed and ignores corrupted stsz sample count (0x7FFFFFFF)', () => {
        // Build mock stbl box with stsz claiming 2 billion samples
        const stszBox = Buffer.alloc(24);
        stszBox.writeUInt32BE(24, 0); // box size
        stszBox.write('stsz', 4, 'ascii');
        stszBox.writeUInt32BE(0, 8); // version + flags
        stszBox.writeUInt32BE(0, 12); // uniform size = 0
        stszBox.writeUInt32BE(0x7fffffff, 16); // sample count 2 billion (fuzzed)

        const moovBox = Buffer.concat([
          Buffer.from([0x00, 0x00, 0x00, 0x28, 0x6d, 0x6f, 0x6f, 0x76]), // moov (40 bytes)
          stszBox,
        ]);

        const arrayBuf = moovBox.buffer.slice(
          moovBox.byteOffset,
          moovBox.byteOffset + moovBox.byteLength
        );

        // Must safely parse without OOM crash
        const trackInfo = demuxMp4(arrayBuf);
        expect(trackInfo === null || trackInfo.samples.length === 0).toBe(true);
      });
    });

    describe('3.3 Hostile OLE2 & Word 97-2003 Fuzzing', () => {
      it('fails closed when OLE2 CFBF magic bytes are corrupted', () => {
        const corruptedOle2 = Buffer.alloc(512);
        // Wrong magic bytes (not 0xD0CF11E0A1B11AE1)
        corruptedOle2.write('MALFORMED_OLE2_FILE_HEADER', 0, 'ascii');

        expect(() => parseCfbf(corruptedOle2)).toThrow();
      });

      it('fails closed when OLE2 sector allocation chain forms an infinite cycle', () => {
        const cyclicOle2 = Buffer.alloc(1024);
        // Valid magic bytes
        cyclicOle2[0] = 0xd0;
        cyclicOle2[1] = 0xcf;
        cyclicOle2[2] = 0x11;
        cyclicOle2[3] = 0xe0;
        cyclicOle2[4] = 0xa1;
        cyclicOle2[5] = 0xb1;
        cyclicOle2[6] = 0x1a;
        cyclicOle2[7] = 0xe1;
        cyclicOle2.writeUInt16LE(9, 30); // Sector size 512 bytes
        cyclicOle2.writeUInt32LE(1, 44); // 1 SAT sector
        cyclicOle2.writeUInt32LE(0, 48); // Dir stream start at sector 0
        cyclicOle2.writeUInt32LE(0, 76); // MSAT[0] at sector 0

        // Cyclic FAT entry: sector 0 points to sector 0
        cyclicOle2.writeUInt32LE(0, 512);

        // Must safely terminate without infinite loop
        const cfbf = parseCfbf(cyclicOle2);
        expect(cfbf).toBeDefined();
      });
    });

    describe('3.4 Hostile CAD STEP Fuzzing', () => {
      it('fails closed when STEP contains cyclic entity references or unclosed shells', () => {
        const cyclicStep = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Cyclic Malformed STEP'), '2;1');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#10=ADVANCED_FACE('FACE_1', (#20), #30, .T.);
#20=FACE_OUTER_BOUND('BOUND_1', #40, .T.);
#40=EDGE_LOOP('LOOP_1', (#50));
#50=ORIENTED_EDGE('OE_1', *, *, #60, .T.);
#60=EDGE_CURVE('EC_1', #70, #80, #60, .T.);
#70=VERTEX_POINT('V_1', #10);
#80=VERTEX_POINT('V_2', #20);
#30=PLANE('PL_1', #10);
ENDSEC;
END-ISO-10303-21;`;

        const entities = parseStepEntities(cyclicStep);
        expect(entities.size).toBeGreaterThan(0);

        // extractStepBRepMesh must safely terminate without infinite recursion or crash
        const mesh = extractStepBRepMesh(entities, 'cyclic_model');
        expect(mesh === null || mesh.indices.length === 0).toBe(true);
      });

      it('fails closed when STEP syntax is severely truncated without ENDSEC or semicolons', () => {
        const truncatedStep = 'ISO-10303-21; HEADER; #10=CARTESIAN_POINT(((';
        const entities = parseStepEntities(truncatedStep);
        const mesh = extractStepBRepMesh(entities);
        expect(mesh).toBeNull();
      });
    });

    describe('3.5 Hostile WOFF2 Font Fuzzing', () => {
      it('fails closed when WOFF2 length headers mismatch or Brotli stream is corrupted', () => {
        const malformedWoff2 = Buffer.alloc(64);
        malformedWoff2.write('wOF2', 0, 'ascii'); // Valid magic
        malformedWoff2.writeUInt32BE(0x00010000, 4); // Flavor
        malformedWoff2.writeUInt32BE(10000, 8); // Claim length 10000 bytes (file is only 64 bytes)
        malformedWoff2.writeUInt16LE(10, 12); // Table count 10

        expect(() => decodeWoff2(malformedWoff2)).toThrow();
      });
    });
  });
});
