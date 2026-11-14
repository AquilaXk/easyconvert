import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

import {
  BitReader as MediaBitReader,
  decodeAudioBuffer,
  decodeFlac,
  decodeWav,
  MAX_PURE_DECODED_SAMPLES,
} from '../src/lib/conversions/media-decoder';
import { quantizeImage } from '../src/lib/conversions/color-quantizer';
import { readMobiText } from '../src/lib/conversions/office/mobi-reader';
import {
  createDeterministicSyntheticStream,
  pipeStreamToStorageMultipart,
} from '../src/lib/streaming/large-payload-streamer';
import type { IStorageBackend } from '../src/lib/storage/oci-storage';
import {
  buildLosslessHuffmanLut,
  decodeLosslessJpegStrip,
  readIfdNumberArray,
  readIfdRationalArray,
} from '../src/lib/conversions/image-lossless-jpeg';
import { decodeRawBayerSensor } from '../src/lib/conversions/image';
import { readBigUIntBE, XrefFormatError } from '../src/lib/conversions/pdf-xref';
import { parseCfbf } from '../src/lib/conversions/cfbf-reader';
import { readRar4BlockHeader } from '../src/lib/conversions/archive-rar4-name';
import { ARCHIVE_SECURITY_LIMITS, inspectArchive, repairZipArchive } from '../src/lib/conversions/archive';
import { decodeLzma } from '../src/lib/conversions/lzma-decoder';
import { unpackXzStream } from '../src/lib/conversions/xz-format';
import { ZstdOutputBuffer } from '../src/lib/conversions/zstd-decoder';
import { decompressZstd } from '../src/lib/conversions/zstd';
import { readHwpSections } from '../src/lib/conversions/hwp-reader';
import { parseHwpRecords } from '../src/lib/conversions/hwp-records';
import { cell, charShape, controlUnits, ctrl, pack, para, table } from './helpers/hwp-craft';
import { bodyBlocks } from '../src/lib/conversions/document-model/support';
import { blockText } from '../src/lib/conversions/document-model/text';
import { readRtfText } from '../src/lib/conversions/office/rtf-reader';
import { readPptSlides } from '../src/lib/conversions/office/ppt-reader';
import { adler32, combineAdler32 } from '../src/lib/conversions/deflate-blocks';
import { combineAdler32 as pngCombineAdler32 } from '../src/lib/conversions/png-photo-bands';
import { decodeDeltaBinaryPacked } from '../src/lib/conversions/parquet-encodings';
import { CompactProtocolReader, CompactProtocolWriter, ThriftType } from '../src/lib/conversions/parquet-thrift';
import { muxWebm } from '../src/lib/edge/media/webm-mux';
import { parseAacLcConfig } from '../src/lib/edge/media/aac';
import { encodePbm, isBitonal } from '../src/lib/conversions/pnm';
import { compressBzip2, decompressBzip2 } from '../src/lib/conversions/bzip2';
import { BitReader as JxlBitReader } from '../src/lib/conversions/image-jxl-header';
import { ForwardBitReader } from '../src/lib/conversions/zstd-fse';
import { readSevenZipArchive } from '../src/lib/conversions/sevenzip-reader';
import { encodePsd } from '../src/lib/conversions/psd-writer';
import { splitAlphaPlanes } from '../src/lib/conversions/png-scanlines';
import { ConversionFailedError, CorruptStreamError, DecompressionLimitError, InvalidRawSensorError } from '../src/lib/types';

import { buildMobi, palmDocCompress } from './helpers/mobi-builder';
import { buildPptBinary } from './helpers/ppt-binary-builder';
import { walkWebm } from './helpers/ebml-walker';
import { expectNoHang } from './helpers/timing';

class MsbBitWriter {
  private readonly bytes: number[] = [];
  private acc = 0;
  private count = 0;

  writeBits(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >>> i) & 1);
      this.count++;
      if (this.count === 8) {
        this.bytes.push(this.acc & 0xff);
        this.acc = 0;
        this.count = 0;
      }
    }
  }

  writeSignedBits(value: number, bits: number): void {
    if (bits <= 32) {
      this.writeBits(value & (bits === 32 ? 0xffffffff : (1 << bits) - 1), bits);
      return;
    }
    const big = BigInt(value);
    const mask = (1n << BigInt(bits)) - 1n;
    const masked = big & mask;
    for (let i = bits - 1; i >= 0; i--) {
      this.writeBits(Number((masked >> BigInt(i)) & 1n), 1);
    }
  }

  writeSignedBigInt(value: bigint, bits: number): void {
    const mask = (1n << BigInt(bits)) - 1n;
    const masked = value & mask;
    for (let i = bits - 1; i >= 0; i--) {
      this.writeBits(Number((masked >> BigInt(i)) & 1n), 1);
    }
  }

  writeRice(residual: number, k: number): void {
    const u = residual >= 0 ? residual * 2 : -residual * 2 - 1;
    const q = Math.floor(u / (1 << k));
    const rem = u - q * (1 << k);
    for (let i = 0; i < q; i++) this.writeBits(0, 1);
    this.writeBits(1, 1);
    if (k > 0) this.writeBits(rem, k);
  }

  align(): void {
    if (this.count > 0) {
      this.writeBits(0, 8 - this.count);
    }
  }

  toBuffer(): Buffer {
    this.align();
    return Buffer.from(this.bytes);
  }
}

function buildFlacStreamInfo(sampleRate: number, channels: number, bitsPerSample: number, blockSize: number): Buffer {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(blockSize, 0);
  info.writeUInt16BE(blockSize, 2);
  info[10] = (sampleRate >> 12) & 0xff;
  info[11] = (sampleRate >> 4) & 0xff;
  info[12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bitsPerSample - 1) >> 4) & 0x01);
  info[13] = ((bitsPerSample - 1) & 0x0f) << 4;
  return Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), info]);
}

function buildDeltaBinaryPackedPage(
  blockSize: number,
  miniblocksPerBlock: number,
  firstValue: bigint,
  blockMinDelta: bigint,
  bitWidths: number[],
  deltas: bigint[]
): Buffer {
  const bytes: number[] = [];
  const pushUleb = (n: number | bigint) => {
    let v = typeof n === 'bigint' ? n : BigInt(n);
    while (v >= 0x80n) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v & 0x7fn));
  };
  const pushZigzag64 = (n: bigint) => {
    const zz = n >= 0n ? n * 2n : -n * 2n - 1n;
    pushUleb(zz);
  };
  const valuesPerMini = Math.floor(blockSize / miniblocksPerBlock);
  pushUleb(blockSize);
  pushUleb(miniblocksPerBlock);
  pushUleb(deltas.length + 1);
  pushZigzag64(firstValue);

  if (deltas.length > 0) {
    pushZigzag64(blockMinDelta);
    for (let m = 0; m < miniblocksPerBlock; m++) {
      bytes.push(bitWidths[m] & 0xff);
    }
    let idx = 0;
    for (let m = 0; m < miniblocksPerBlock; m++) {
      const bw = bitWidths[m];
      if (idx >= deltas.length) break;
      if (bw === 0) {
        idx += valuesPerMini;
        continue;
      }
      const totalBits = valuesPerMini * bw;
      const miniBytes = new Uint8Array(Math.ceil(totalBits / 8));
      let bitOffset = 0;
      for (let vIdx = 0; vIdx < valuesPerMini; vIdx++) {
        const rawDelta = idx < deltas.length ? deltas[idx] - blockMinDelta : 0n;
        idx++;
        for (let b = 0; b < bw; b++) {
          if ((rawDelta & (1n << BigInt(b))) !== 0n) {
            const absBit = bitOffset + b;
            miniBytes[absBit >> 3] |= 1 << (absBit & 7);
          }
        }
        bitOffset += bw;
      }
      for (const b of miniBytes) bytes.push(b);
    }
  }
  return Buffer.from(bytes);
}

function makeInMemoryStorageBackend(): {
  backend: IStorageBackend;
  parts: Map<number, Buffer>;
} {
  const parts = new Map<number, Buffer>();
  const backend: IStorageBackend = {
    providerName: 'memory-test',
    kind: 'local',
    initiateMultipartUpload(_filename, _mime, _size, _metadata, partSize) {
      return {
        uploadId: 'up-1',
        key: 'conversions/test/out.bin',
        partSize: partSize ?? 5 * 1024 * 1024,
        totalParts: 0,
        expiresAt: Date.now() + 60_000,
      };
    },
    uploadPart(_uploadId, partNumber, buffer) {
      parts.set(partNumber, Buffer.from(buffer));
      return { partNumber, etag: `etag-${partNumber}`, size: buffer.length };
    },
    completeMultipartUpload(_uploadId) {
      const all = Array.from(parts.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, buf]) => buf);
      const total = Buffer.concat(all);
      return {
        location: 'memory://conversions/test/out.bin',
        key: 'conversions/test/out.bin',
        etag: 'done',
        size: total.length,
      };
    },
    abortMultipartUpload() {
      return true;
    },
    saveObject() {
      throw new Error('unexpected saveObject');
    },
    saveObjectFromStream() {
      throw new Error('unexpected saveObjectFromStream');
    },
    getObject() {
      return undefined;
    },
    stat() {
      return null;
    },
    openReadStream() {
      return null;
    },
    deleteObject() {
      return false;
    },
    getActiveSessionsCount() {
      return 0;
    },
    getObjectsCount() {
      return 0;
    },
  };
  return { backend, parts };
}

function buildLosslessJpeg(options: {
  width: number;
  height: number;
  bpp: number;
  pointTransform?: number;
  counts?: number[];
  symbols?: number[];
  scanBytes: number[];
  trailingBytes?: number[];
}): Buffer {
  const counts = options.counts ?? [1, ...new Array<number>(15).fill(0)];
  const symbols = options.symbols ?? [0];
  const pt = options.pointTransform ?? 0;
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc3, 0, 11, options.bpp, options.height >> 8, options.height & 0xff, options.width >> 8, options.width & 0xff, 1, 1, 0x11, 0,
    0xff, 0xc4, 0, 2 + 1 + 16 + symbols.length, 0, ...counts, ...symbols,
    0xff, 0xda, 0, 8, 1, 1, 0, 1, 0, pt & 0x0f,
    ...options.scanBytes,
    0xff, 0xd9,
    ...(options.trailingBytes ?? []),
  ]);
}

describe('B-1 & B-8: media-decoder AIFF, PCM, BitReader, FLAC subframes and Rice limits', () => {
  it('breaks cleanly without 32-bit overflow infinite loop on AIFF chunkSize >= 0x7fffffff', async () => {
    const aiff = Buffer.alloc(46);
    aiff.write('FORM', 0, 'ascii');
    aiff.writeUInt32BE(38, 4);
    aiff.write('AIFF', 8, 'ascii');
    // JUNK chunk with chunkSize = 0x7fffffff (would wrap ((0x7fffffff + 1) & ~1) | 0 to -0x80000000 in 32-bit signed math)
    aiff.write('JUNK', 12, 'ascii');
    aiff.writeUInt32BE(0x7fffffff, 16);

    await expectNoHang('AIFF chunkSize 0x7fffffff', () => {
      expect(() => decodeAudioBuffer(aiff, 'aiff')).toThrow(ConversionFailedError);
    });
  });

  it('decodes a valid AIFF PCM file cleanly', () => {
    const numSamples = 4;
    const pcmBytes = Buffer.alloc(numSamples * 2);
    pcmBytes.writeInt16BE(1000, 0);
    pcmBytes.writeInt16BE(-2000, 2);
    pcmBytes.writeInt16BE(3000, 4);
    pcmBytes.writeInt16BE(-4000, 6);

    const aiff = Buffer.alloc(12 + 26 + 16 + pcmBytes.length);
    aiff.write('FORM', 0, 'ascii');
    aiff.writeUInt32BE(aiff.length - 8, 4);
    aiff.write('AIFF', 8, 'ascii');
    aiff.write('COMM', 12, 'ascii');
    aiff.writeUInt32BE(18, 16);
    aiff.writeInt16BE(1, 20); // channels = 1
    aiff.writeUInt32BE(numSamples, 22);
    aiff.writeInt16BE(16, 26); // 16-bit
    // 80-bit extended float 44100 Hz: exponent 0x400e, mantissa 0xac44_0000_0000_0000
    aiff.writeUInt16BE(0x400e, 28);
    aiff.writeUInt32BE(0xac440000, 30);
    aiff.writeUInt32BE(0, 34);
    aiff.write('SSND', 38, 'ascii');
    aiff.writeUInt32BE(8 + pcmBytes.length, 42);
    aiff.writeUInt32BE(0, 46); // offset
    aiff.writeUInt32BE(0, 50); // blockSize
    pcmBytes.copy(aiff, 54);

    const decoded = decodeAudioBuffer(aiff, 'aiff');
    expect(decoded.channels).toBe(1);
    expect(decoded.sampleRate).toBe(44100);
    expect(Array.from(decoded.samples)).toEqual([1000, -2000, 3000, -4000]);
  });

  it('rejects WAV PCM chunk whose decoded sample count exceeds MAX_PURE_DECODED_SAMPLES', () => {
    // 64 Mi samples * 2 bytes + 1 chunk boundary declared in oversized data chunk check
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0, 'ascii');
    hdr.writeUInt32LE(36, 4);
    hdr.write('WAVE', 8, 'ascii');
    hdr.write('fmt ', 12, 'ascii');
    hdr.writeUInt32LE(16, 16);
    hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(44100, 24);
    hdr.writeUInt32LE(44100, 28);
    hdr.writeUInt16LE(1, 32);
    hdr.writeUInt16LE(8, 34);
    hdr.write('data', 36, 'ascii');
    const oversizeData = Buffer.allocUnsafe(MAX_PURE_DECODED_SAMPLES + 1 + 44);
    hdr.copy(oversizeData, 0);
    oversizeData.writeUInt32LE(MAX_PURE_DECODED_SAMPLES + 1, 40);
    expect(() => decodeWav(oversizeData)).toThrow(ConversionFailedError);
  });

  it('handles BitReader 32-bit reservoir across 0, 1..31, 32, and >32 signed/unsigned bits and unary zeroes', () => {
    const bw = new MsbBitWriter();
    bw.writeSignedBits(-1, 5); // 11111
    bw.writeSignedBits(-2147483648, 32);
    bw.writeSignedBigInt(-(1n << 32n) + 7n, 33);
    for (let z = 0; z < 40; z++) bw.writeBits(0, 1);
    bw.writeBits(1, 1);
    const reader = new MediaBitReader(bw.toBuffer());

    expect(reader.readSignedBits(0)).toBe(0);
    expect(reader.readSignedBits(5)).toBe(-1);
    expect(reader.readSignedBits(32)).toBe(-2147483648);
    expect(reader.readSignedBits(33)).toBe(-4294967289);
    expect(reader.readUnaryZeroes(64)).toBe(40);
    expect(() => reader.readUnaryZeroes(5)).toThrow(ConversionFailedError);
    expect(() => reader.readBits(32)).toThrow(ConversionFailedError);
  });

  it('rejects FLAC FIXED order > 4, order > blockSize, and overflowing Rice quotients fail-closed', () => {
    // 1) FIXED order = 5 (subframeType = 0x08 | 5 = 0x0d)
    const bwFixed = new MsbBitWriter();
    bwFixed.writeBits(0x3ffe, 14);
    bwFixed.writeBits(0, 1);
    bwFixed.writeBits(0, 1);
    bwFixed.writeBits(6, 4); // 8-bit block size
    bwFixed.writeBits(9, 4); // 44100 Hz
    bwFixed.writeBits(0, 4); // mono
    bwFixed.writeBits(4, 3); // 16-bit
    bwFixed.writeBits(0, 1);
    bwFixed.writeBits(0, 8); // sample 0
    bwFixed.writeBits(7, 8); // blockSize = 8
    bwFixed.writeBits(0, 8); // crc8
    bwFixed.writeBits(0, 1); // zero pad
    bwFixed.writeBits(0x0d, 6); // FIXED order=5
    bwFixed.writeBits(0, 1);
    const fixedBad = Buffer.concat([buildFlacStreamInfo(44100, 1, 16, 8), bwFixed.toBuffer(), Buffer.alloc(4)]);
    expect(() => decodeFlac(fixedBad)).toThrow(ConversionFailedError);

    // 2) LPC order = 10 > blockSize = 8 (subframeType = 0x20 | 9 = 0x29)
    const bwLpc = new MsbBitWriter();
    bwLpc.writeBits(0x3ffe, 14);
    bwLpc.writeBits(0, 1);
    bwLpc.writeBits(0, 1);
    bwLpc.writeBits(6, 4);
    bwLpc.writeBits(9, 4);
    bwLpc.writeBits(0, 4);
    bwLpc.writeBits(4, 3);
    bwLpc.writeBits(0, 1);
    bwLpc.writeBits(0, 8);
    bwLpc.writeBits(7, 8); // blockSize = 8
    bwLpc.writeBits(0, 8);
    bwLpc.writeBits(0, 1);
    bwLpc.writeBits(0x29, 6); // LPC order = 10
    bwLpc.writeBits(0, 1);
    const lpcBad = Buffer.concat([buildFlacStreamInfo(44100, 1, 16, 8), bwLpc.toBuffer(), Buffer.alloc(4)]);
    expect(() => decodeFlac(lpcBad)).toThrow(ConversionFailedError);

    // 3) Hostile Rice k = 30 (5-bit parameter in method 1) with huge quotient triggering Rice overflow ceiling
    const bwRice = new MsbBitWriter();
    bwRice.writeBits(0x3ffe, 14);
    bwRice.writeBits(0, 1);
    bwRice.writeBits(0, 1);
    bwRice.writeBits(6, 4);
    bwRice.writeBits(9, 4);
    bwRice.writeBits(0, 4);
    bwRice.writeBits(4, 3);
    bwRice.writeBits(0, 1);
    bwRice.writeBits(0, 8);
    bwRice.writeBits(3, 8); // blockSize = 4
    bwRice.writeBits(0, 8);
    bwRice.writeBits(0, 1);
    bwRice.writeBits(0x09, 6); // FIXED order = 1
    bwRice.writeBits(0, 1);
    bwRice.writeSignedBits(10, 16); // warmup
    bwRice.writeBits(1, 2); // Rice method 1 (5-bit k)
    bwRice.writeBits(0, 4); // pOrder = 0
    bwRice.writeBits(30, 5); // k = 30 -> (1 << 30) scale; q >= 6 overflows 32-bit Rice limit
    for (let i = 0; i < 6; i++) bwRice.writeBits(0, 1);
    bwRice.writeBits(1, 1);
    bwRice.writeBits(0, 30);
    const riceBad = Buffer.concat([buildFlacStreamInfo(44100, 1, 16, 4), bwRice.toBuffer(), Buffer.alloc(4)]);
    expect(() => decodeFlac(riceBad)).toThrow(ConversionFailedError);
  });

  it('produces exact samples on FLAC LPC fast path and 64-bit BigInt fallback path', () => {
    // Frame A: 16-bit, order=2, qlpPrecision=12, qlpShift=10, coeffs=[1024, 0] -> sum <= 52 bits -> fast path
    // Expected samples: [100, 150, 151, 150, 151, 150] (residuals 1, -1, 1, -1 with predictor s[n-1])
    const bwFast = new MsbBitWriter();
    bwFast.writeBits(0x3ffe, 14);
    bwFast.writeBits(0, 1);
    bwFast.writeBits(0, 1);
    bwFast.writeBits(6, 4);
    bwFast.writeBits(9, 4);
    bwFast.writeBits(0, 4);
    bwFast.writeBits(4, 3); // 16-bit
    bwFast.writeBits(0, 1);
    bwFast.writeBits(0, 8);
    bwFast.writeBits(5, 8); // blockSize = 6
    bwFast.writeBits(0, 8);
    bwFast.writeBits(0, 1);
    bwFast.writeBits(0x21, 6); // LPC order = 2
    bwFast.writeBits(0, 1);
    bwFast.writeSignedBits(100, 16);
    bwFast.writeSignedBits(150, 16);
    bwFast.writeBits(11, 4); // qlpPrecision = 12
    bwFast.writeSignedBits(10, 5); // qlpShift = 10
    bwFast.writeSignedBits(1024, 12);
    bwFast.writeSignedBits(0, 12);
    bwFast.writeBits(0, 2); // Rice method 0
    bwFast.writeBits(0, 4); // pOrder = 0
    bwFast.writeBits(1, 4); // k = 1
    bwFast.writeRice(1, 1);
    bwFast.writeRice(-1, 1);
    bwFast.writeRice(1, 1);
    bwFast.writeRice(-1, 1);
    bwFast.align();
    bwFast.writeBits(0, 16); // crc16

    const streamFast = Buffer.concat([buildFlacStreamInfo(44100, 1, 16, 6), bwFast.toBuffer()]);
    const decodedFast = decodeFlac(streamFast);
    expect(Array.from(decodedFast.samples)).toEqual([100, 150, 151, 150, 151, 150]);

    // Frame B: 32-bit stream with qlpPrecision=15, order=16 (32 + 15 + 5 = 52? wait 33-bit side channel -> 53 > 52, or Stereo mid-side where ch1 is 33 bps -> BigInt path!)
    // Use stereo mid-side chCode=8 (`ch 0` left, `ch 1` diff 33-bit): bps=32 -> channel 1 activeBps=33 -> 33 + 15 + 5 = 53 > 52 forces BigInt LPC loop!
    const bwBig = new MsbBitWriter();
    bwBig.writeBits(0x3ffe, 14);
    bwBig.writeBits(0, 1);
    bwBig.writeBits(0, 1);
    bwBig.writeBits(6, 4);
    bwBig.writeBits(9, 4);
    bwBig.writeBits(8, 4); // stereo L-S (ch1 gets subframeBps = 33)
    bwBig.writeBits(7, 3); // 32-bit
    bwBig.writeBits(0, 1);
    bwBig.writeBits(0, 8);
    bwBig.writeBits(17, 8); // blockSize = 18 (> order 16)
    bwBig.writeBits(0, 8);

    // Channel 0: CONSTANT 655360 (10 * 65536 -> 10 after >>16)
    bwBig.writeBits(0, 1);
    bwBig.writeBits(0, 6);
    bwBig.writeBits(0, 1);
    bwBig.writeSignedBits(655360, 32);

    // Channel 1 (33-bit side): LPC order = 16, qlpPrecision = 15, qlpShift = 10, coeffs[0] = 1024, others = 0
    bwBig.writeBits(0, 1);
    bwBig.writeBits(0x20 | 15, 6); // order = 16
    bwBig.writeBits(0, 1);
    for (let i = 0; i < 16; i++) {
      bwBig.writeSignedBits(0, 33);
    }
    bwBig.writeBits(14, 4); // qlpPrecision = 15
    bwBig.writeSignedBits(10, 5); // qlpShift = 10
    bwBig.writeSignedBits(1024, 15);
    for (let i = 1; i < 16; i++) {
      bwBig.writeSignedBits(0, 15);
    }
    bwBig.writeBits(0, 2);
    bwBig.writeBits(0, 4);
    bwBig.writeBits(0, 4); // k = 0
    // 2 remaining samples (18 - 16 = 2) with residual 65536 * 2 -> side becomes [0..., 131072, 262144] -> R = L - S -> interleaved check
    bwBig.writeRice(131072, 0);
    bwBig.writeRice(131072, 0);
    bwBig.align();
    bwBig.writeBits(0, 16);

    const streamBig = Buffer.concat([buildFlacStreamInfo(44100, 2, 32, 18), bwBig.toBuffer()]);
    const decodedBig = decodeFlac(streamBig);
    expect(decodedBig.samples[0]).toBe(10); // L[0]
    expect(decodedBig.samples[1]).toBe(10); // R[0] = 10 - 0
    expect(decodedBig.samples[16 * 2 + 1]).toBe(8); // R[16] = (655360 - 131072) >> 16 = 8
    expect(decodedBig.samples[17 * 2 + 1]).toBe(6); // R[17] = (655360 - 262144) >> 16 = 6
  });
});

describe('B-2 & B-3: color-quantizer >16.8MP sums and mobi-reader multi-record scratch reuse', () => {
  it('avoids Uint32 histogram sum wraparound above 16.84 MP in Float64Array accumulators', () => {
    const width = 4250;
    const height = 4000; // 17,000,000 pixels -> 17M * 255 = 4,335,000,000 > 2^32
    const rgba = Buffer.alloc(width * height * 4, 255);
    rgba[0] = 253; // distinct color 1
    rgba[4] = 254; // distinct color 2 (3rd is 255 -> forces histogram path when maxColors = 2)

    const indexed = quantizeImage(rgba, width, height, 2, { dither: 'none' });
    expect(indexed.palette[0]).toBe(255);
    expect(indexed.palette[1]).toBe(255);
    expect(indexed.palette[2]).toBe(255);
  });

  it('reuses a single scratch buffer across multi-record PalmDOC MOBI decompression without cross-record leakage', () => {
    const rec1Text = 'Record one first paragraph. '.repeat(25);
    const rec2Text = 'Record two distinct payload! '.repeat(12);
    const rec3Text = 'Short end.';
    const mobi = buildMobi({
      compression: 2,
      textRecords: [
        palmDocCompress(Buffer.from(rec1Text, 'utf8')),
        palmDocCompress(Buffer.from(rec2Text, 'utf8')),
        palmDocCompress(Buffer.from(rec3Text, 'utf8')),
      ],
      encoding: 65001,
      textLength: Buffer.byteLength(`${rec1Text}${rec2Text}${rec3Text}`, 'utf8'),
    });

    const fullText = readMobiText(mobi);
    expect(fullText).toBe(`${rec1Text}${rec2Text}${rec3Text}`);
  });
});

describe('B-4 & B-5: large-payload-streamer, image lossless JPEG & IFD array bounds', () => {
  it('writes unsigned lower 32 bits of >4GiB bytesRemaining without ERR_OUT_OF_RANGE', async () => {
    const stream = createDeterministicSyntheticStream(0x1_0000_0100, 64);
    const firstChunk = await new Promise<Buffer>((resolve, reject) => {
      stream.once('data', (chunk: Buffer) => {
        stream.destroy();
        resolve(chunk);
      });
      stream.once('error', reject);
    });
    expect(firstChunk.readUInt32BE(0)).toBe(1);
    expect(firstChunk.readUInt32BE(4)).toBe(0x0000_00c0);
  });

  it('slices oversized Uint8Array chunks across multipart boundaries and enforces maxTotalBytes', async () => {
    const { backend, parts } = makeInMemoryStorageBackend();
    // 100 KB single non-Buffer Uint8Array payload with 64 KB sniff header + 32 KB part size
    const raw = new Uint8Array(100 * 1024);
    raw[0] = 0x25; // %PDF-1.4
    raw[1] = 0x50;
    raw[2] = 0x44;
    raw[3] = 0x46;
    raw[4] = 0x2d;
    for (let i = 5; i < raw.length; i++) raw[i] = (i * 17) & 0xff;
    const expectedSha = crypto.createHash('sha256').update(raw).digest('hex');

    async function* singleChunkGen(): AsyncGenerator<Uint8Array> {
      yield raw;
    }

    const res = await pipeStreamToStorageMultipart(singleChunkGen(), {
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      expectedTotalSize: raw.length,
      sourceExtension: 'pdf',
      storage: backend,
      partSizeBytes: 32 * 1024,
      maxTotalBytes: 200 * 1024,
    });

    expect(res.totalBytes).toBe(raw.length);
    expect(res.totalParts).toBe(4);
    expect(res.sha256Digest).toBe(expectedSha);
    expect(Array.from(parts.values()).map((b) => b.length)).toEqual([32768, 32768, 32768, 4096]);

    async function* oversizedGen(): AsyncGenerator<Uint8Array> {
      yield raw;
    }
    await expect(
      pipeStreamToStorageMultipart(oversizedGen(), {
        filename: 'sample.pdf',
        mimeType: 'application/pdf',
        expectedTotalSize: raw.length,
        sourceExtension: 'pdf',
        storage: backend,
        partSizeBytes: 32 * 1024,
        maxTotalBytes: 50 * 1024,
      })
    ).rejects.toThrow(/exceeds maximum allowed size/);
  });

  it('enforces Lossless JPEG SOF3 bpp, SOS pointTransform, DHT Kraft/cat=16, and <=4 zero-pad bounds', () => {
    // Valid cat=16 test: 1x1 16-bit lossless JPEG with cat=16 Huffman symbol (1 bit '0') -> pred=32768, diff=32768 -> (32768+32768)&0xffff = 0
    const countsCat16 = [1, ...new Array<number>(15).fill(0)];
    const jpegCat16 = buildLosslessJpeg({
      width: 1,
      height: 1,
      bpp: 16,
      counts: countsCat16,
      symbols: [16],
      scanBytes: [0x00, 0x00],
    });
    const decoded = decodeLosslessJpegStrip(jpegCat16, { width: 1, height: 1 });
    expect(decoded?.bpp).toBe(16);
    expect(Array.from(decoded?.data ?? [])).toEqual([0]);

    // Invalid bpp = 1
    expect(() =>
      decodeLosslessJpegStrip(buildLosslessJpeg({ width: 1, height: 1, bpp: 1, scanBytes: [0] }))
    ).toThrow(InvalidRawSensorError);

    // Invalid pointTransform >= bpp
    expect(() =>
      decodeLosslessJpegStrip(buildLosslessJpeg({ width: 1, height: 1, bpp: 8, pointTransform: 8, scanBytes: [0] }))
    ).toThrow(InvalidRawSensorError);

    // Invalid cat > 16
    expect(() => buildLosslessHuffmanLut([1, ...new Array<number>(15).fill(0)], [17])).toThrow(InvalidRawSensorError);

    // Exceeds Kraft inequality (2 codes of length 1 is valid, 3 codes of length 1 overflows Kraft sum)
    expect(() => buildLosslessHuffmanLut([3, ...new Array<number>(15).fill(0)], [0, 1, 2])).toThrow(
      InvalidRawSensorError
    );

    // Truncated scan requiring > 4 zero-pad bytes fails closed (4x4 = 16 symbols of length 16 bits -> needs >4 pad bytes on empty scan)
    expect(() =>
      decodeLosslessJpegStrip(
        buildLosslessJpeg({
          width: 4,
          height: 4,
          bpp: 8,
          counts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
          symbols: [0],
          scanBytes: [],
        })
      )
    ).toThrow(InvalidRawSensorError);
  });

  it('rejects crafted TIFF/DNG IFD array counts exceeding maxCount without allocating', () => {
    const buf = Buffer.alloc(64);
    expect(() => readIfdNumberArray(buf, true, 4, 50_000_000, 16, 1024)).toThrow(InvalidRawSensorError);
    expect(() => readIfdRationalArray(buf, true, 5, 50_000_000, 16, 64)).toThrow(InvalidRawSensorError);

    // Build minimal little-endian DNG claiming CFA ColorMatrix1 count = 50_000_000
    const dng = Buffer.alloc(64);
    dng.write('II', 0, 'ascii');
    dng.writeUInt16LE(42, 2);
    dng.writeUInt32LE(8, 4);
    dng.writeUInt16LE(1, 8); // 1 IFD entry
    dng.writeUInt16LE(50721, 10); // ColorMatrix1
    dng.writeUInt16LE(10, 12); // SRATIONAL
    dng.writeUInt32LE(50_000_000, 14);
    dng.writeUInt32LE(32, 18);
    expect(() => decodeRawBayerSensor(dng, 'dng')).toThrow(InvalidRawSensorError);
  });
});

describe('B-4 & B-6: pdf-xref, cfbf-reader, archive RAR4 & ZIP bounds', () => {
  it('reads 5/6/7-byte big-endian xref fields above 2^32 and rejects width > 8 or unsafe integers', () => {
    const data = Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(readBigUIntBE(data, 0, 5)).toBe(0x0123456789);
    expect(readBigUIntBE(data, 0, 6)).toBe(0x0123456789ab);
    expect(() => readBigUIntBE(data, 0, 9)).toThrow(XrefFormatError);
    expect(() => readBigUIntBE(data, 7, 7)).toThrow(XrefFormatError); // 0x00ff_ffff_ffff_ffff > MAX_SAFE_INTEGER
  });

  it('rejects CFBF headers with invalid miniSectorShift even when no directory entry uses the mini stream', () => {
    // 1024-byte CFBF file with 1 FAT sector, miniSectorShift corrupted from 6 to 7 (unconditionally checked)
    const sectorSize = 512;
    const cfbf = Buffer.alloc(sectorSize * 3);
    cfbf.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
    cfbf.writeUInt16LE(0x003e, 24);
    cfbf.writeUInt16LE(0x0003, 26);
    cfbf.writeUInt16LE(0xfffe, 28);
    cfbf.writeUInt16LE(9, 30); // sectorShift = 9 (512B)
    cfbf.writeUInt16LE(7, 32); // BAD miniSectorShift (must be 6)
    cfbf.writeUInt32LE(1, 44); // 1 FAT sector
    cfbf.writeUInt32LE(1, 48); // first dir sector = 1
    cfbf.writeUInt32LE(4096, 56);
    cfbf.writeUInt32LE(0xfffffffe, 60); // ENDOFCHAIN
    cfbf.writeUInt32LE(0xfffffffe, 68);
    cfbf.writeUInt32LE(0, 76); // FAT at sector 0
    for (let i = 1; i < 128; i++) cfbf.writeUInt32LE(0xffffffff, 76 + i * 4);
    // Sector 0 = FAT
    cfbf.writeUInt32LE(0xfffffffd, sectorSize + 0); // FATSECT
    cfbf.writeUInt32LE(0xfffffffe, sectorSize + 4); // dir ENDOFCHAIN
    // Sector 1 = Directory (Root Entry with size 0 -> needsMiniStream === false)
    const dirOff = sectorSize * 2;
    const rootName = Buffer.from('Root Entry', 'utf16le');
    rootName.copy(cfbf, dirOff);
    cfbf.writeUInt16LE(rootName.length + 2, dirOff + 64);
    cfbf[dirOff + 66] = 5; // Root Storage
    cfbf.writeUInt32LE(0xffffffff, dirOff + 68);
    cfbf.writeUInt32LE(0xffffffff, dirOff + 72);
    cfbf.writeUInt32LE(0xffffffff, dirOff + 76);
    cfbf.writeUInt32LE(0xfffffffe, dirOff + 116);
    cfbf.writeUInt32LE(0, dirOff + 120);

    expect(() => parseCfbf(cfbf)).toThrow(CorruptStreamError);
  });

  it('parses RAR4 LHD_LARGE 64-bit sizes, rejects truncated LHD_LARGE, and skips LONG_BLOCK ADD_SIZE', () => {
    // 1) Valid LHD_LARGE file header
    const largeHdr = Buffer.alloc(44);
    largeHdr[2] = 0x74;
    largeHdr.writeUInt16LE(0x0100, 3); // LHD_LARGE
    largeHdr.writeUInt16LE(44, 5);
    largeHdr.writeUInt32LE(0x0000_0001, 7); // lowPackSize
    largeHdr.writeUInt32LE(0x0000_0002, 11); // lowUnpSize
    largeHdr.writeUInt16LE(4, 26); // nameSize
    largeHdr.writeUInt32LE(0x0000_0003, 32); // highPackSize
    largeHdr.writeUInt32LE(0x0000_0004, 36); // highUnpSize
    largeHdr.write('test', 40, 'ascii');

    const parsedLarge = readRar4BlockHeader(largeHdr, 0);
    expect(parsedLarge?.packSize).toBe(3 * 0x100000000 + 1);
    expect(parsedLarge?.unpSize).toBe(4 * 0x100000000 + 2);
    expect(parsedLarge?.nameStart).toBe(40);
    expect(parsedLarge?.nextOffset).toBe(44 + 3 * 0x100000000 + 1);

    // 2) Truncated LHD_LARGE (< 40 bytes) throws CorruptStreamError
    const badLarge = Buffer.alloc(36);
    badLarge[2] = 0x74;
    badLarge.writeUInt16LE(0x0100, 3);
    badLarge.writeUInt16LE(36, 5);
    expect(() => readRar4BlockHeader(badLarge, 0)).toThrow(CorruptStreamError);

    // 3) Non-0x74 LONG_BLOCK (e.g. 0x75 comment subblock with flag 0x8000 and addSize = 12) skips addSize accurately
    const rarLongBlock = Buffer.alloc(11 + 12 + 7);
    rarLongBlock[2] = 0x75;
    rarLongBlock.writeUInt16LE(0x8000, 3);
    rarLongBlock.writeUInt16LE(11, 5);
    rarLongBlock.writeUInt32LE(12, 7); // addSize
    rarLongBlock[23 + 2] = 0x7b; // ENDARC right after 11 + 12 = 23 bytes
    rarLongBlock.writeUInt16LE(0x4000, 23 + 3);
    rarLongBlock.writeUInt16LE(7, 23 + 5);

    const parsedLong = readRar4BlockHeader(rarLongBlock, 0);
    expect(parsedLong?.nextOffset).toBe(23);
    expect(readRar4BlockHeader(rarLongBlock, parsedLong!.nextOffset)?.headType).toBe(0x7b);
  });

  it('enforces MAX_FILES on inspectArchive ZIP EOCD and caps repairZipArchive trial count', async () => {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(ARCHIVE_SECURITY_LIMITS.MAX_FILES + 1, 8);
    eocd.writeUInt16LE(ARCHIVE_SECURITY_LIMITS.MAX_FILES + 1, 10);
    await expect(inspectArchive(eocd, { filename: 'bomb.zip' })).rejects.toThrow(DecompressionLimitError);

    // Corrupt ZIP without EOCD containing 80 dummy PK\x03\x04 local headers whose compressedSize=0 and uncompressedSize>0
    // stops fallback inflate after the 64-trial cap instead of scanning/inflating all 80 entries
    const fakeLfh = Buffer.alloc(35);
    fakeLfh.writeUInt32LE(0x04034b50, 0);
    fakeLfh.writeUInt16LE(8, 8); // deflate
    fakeLfh.writeUInt32LE(0, 18); // compSize=0 triggers heuristic fallback inflate
    fakeLfh.writeUInt32LE(10, 22);
    fakeLfh.writeUInt16LE(1, 26);
    fakeLfh.write('a', 30, 'ascii');
    const manyFakeLfhs = Buffer.concat(Array.from({ length: 80 }, () => fakeLfh));
    const repaired = await repairZipArchive(manyFakeLfhs);
    const inspected = await inspectArchive(repaired, { filename: 'repaired.zip' });
    expect(inspected.totalEntries).toBe(64);

    // Invalid deflate payload triggers failure cleanly once no entries are recoverable
    const badLfh = Buffer.from(fakeLfh);
    badLfh.fill(0xff, 31);
    await expect(repairZipArchive(Buffer.concat(Array.from({ length: 80 }, () => badLfh)))).rejects.toThrow(
      ConversionFailedError
    );
  });
});

describe('B-5: LZMA, XZ, and Zstd spoofed header bounded preallocation', () => {
  it('bounds initial output preallocation on LZMA, XZ, and Zstd spoofed sizes while decoding real XZ/Zstd vectors', () => {
    // 1) LzmaDecoder spoofed unpackSize = 512 MiB on 16 garbage bytes -> fails with small RSS delta (< 16 MiB)
    const props = Uint8Array.from([0x5d, 0x00, 0x00, 0x10, 0x00]); // lc=3, lp=0, pb=2, dict=4KB
    const bogusLzma = Uint8Array.from([0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00]);
    const rssBeforeLzma = process.memoryUsage().rss;
    expect(() => decodeLzma(bogusLzma, props, 512 * 1024 * 1024, 512 * 1024 * 1024)).toThrow();
    expect(process.memoryUsage().rss - rssBeforeLzma).toBeLessThan(16 * 1024 * 1024);

    // Still rejects upfront if unpackSize exceeds maxOutput
    expect(() => decodeLzma(bogusLzma, props, 1024, 512)).toThrow(DecompressionLimitError);

    // 2) ZstdOutputBuffer caps initial preallocation when compressedLen is small
    const outBuf = new ZstdOutputBuffer(512 * 1024 * 1024);
    outBuf.reserve(256 * 1024 * 1024, 16);
    expect(outBuf.data.length).toBe(65536);

    // 3) Zstd decoder handles independent Node zlib zstd vector cleanly
    const plain = Buffer.from('zstd reference payload check! '.repeat(30));
    const compressedZst = zlib.zstdCompressSync(plain);
    expect(decompressZstd(compressedZst)).toEqual(plain);

    // 4) XZ decoder decodes an independent python3-lzma reference vector cleanly
    const xzVector = Buffer.from(
      '/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4AY/ADVdADKYSs6ExV6MjkAd1+XKGu50EYDDs4cHWUapOt7lLb0FGGLFQ9hQKsg/YkrWIyMVScorDEwAAAAAAIawuzs0eI7bAAFRwAwAAADsWESnscRn+wIAAAAABFla',
      'base64'
    );
    const expectedText = 'easyconvert parser bit hardening vector '.repeat(40);
    expect(unpackXzStream(xzVector, 1024 * 1024).toString('utf8')).toBe(expectedText);
  });
});

describe('B-6 & B-10: HWP, RTF, PPT, 7z readers linear/zero-copy equivalence', () => {
  it('reads multi-cell HWP tables and extended controls linearly with readHwpSections', () => {
    const sectionBytes = pack([
      ...para(0, { units: controlUnits(11, 'tbl ') }),
      ctrl(1, 'tbl '),
      table(2, 1, 2),
      cell(2, 0, 0),
      ...para(2, { text: 'Cell A' }),
      cell(2, 1, 0),
      ...para(2, { text: 'Cell B' }),
    ]);
    const docInfo = pack([charShape()]);

    const model = readHwpSections(parseHwpRecords(docInfo), [parseHwpRecords(sectionBytes)], () => undefined);
    const blocks = bodyBlocks(model);
    expect(blocks.some((b) => b.type === 'table')).toBe(true);
    expect(blocks.map(blockText).join(' ')).toContain('Cell A');
    expect(blocks.map(blockText).join(' ')).toContain('Cell B');
  });

  it('extracts ASCII runs, unicode escapes, and skips pict destinations cleanly in readRtfText', () => {
    const rtf = Buffer.from(
      '{\\rtf1\\ansi{\\*\\pict 001122}Hello\\par World \\u54620?\\u44544?}',
      'latin1'
    );
    const out = readRtfText(rtf);
    expect(out).toBe('Hello\nWorld 한글');
  });

  it('tracks monotonic fontRuns cursor across multi-run PPT slides', () => {
    const ppt = buildPptBinary({
      slides: [
        { shapes: [{ chars: 'Run 1 ' }, { chars: 'Run 2 한국어' }] },
        { shapes: [{ bytes: 'Second slide ASCII' }] },
      ],
    });
    const slides = readPptSlides(ppt);
    expect(slides.map((s) => s.texts)).toEqual([['Run 1 ', 'Run 2 한국어'], ['Second slide ASCII']]);
  });

  it('reads a valid uncompressed 7z header/file with zero-copy Buffer subarray views', () => {
    // Minimal 7z with empty header (0 files -> [] path) vs packed stream CRC check via decode callback
    const payload = Buffer.from('sevenzip view check');
    const crc = zlib.crc32(payload);
    // Construct valid 7z header bytes: ID.HEADER (0x01), ID.MAIN_STREAMS_INFO (0x04), ID.PACK_INFO (0x06),
    // packPos=0, numPackStreams=1, ID.SIZE (0x09), packSize=payload.length, ID.END (0x00),
    // ID.UNPACK_INFO (0x07), ID.FOLDER (0x0b), numFolders=1, external=0, numCoders=1, flags=0x01, codecId=[0x00],
    // ID.CODERS_UNPACK_SIZE (0x0c), unpackSize=payload.length, ID.END (0x00),
    // ID.SUBSTREAMS_INFO (0x08), ID.CRC (0x0a), allAreDefined=1, crc32 LE, ID.END (0x00), ID.END (0x00) [end MainStreamsInfo],
    // ID.FILES_INFO (0x05), numFiles=1, ID.NAME (0x11), size=11, external=0, 'a.txt\0' utf16le, ID.END (0x00), ID.END (0x00) [end header]
    const nameUtf16 = Buffer.from('a.txt\0', 'utf16le');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32LE(crc, 0);
    const header = Buffer.concat([
      Buffer.from([
        0x01, 0x04, 0x06, 0x00, 0x01, 0x09, payload.length, 0x00,
        0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, 0x0c, payload.length, 0x00,
        0x08, 0x0a, 0x01,
      ]),
      crcBuf,
      Buffer.from([0x00, 0x00, 0x05, 0x01, 0x11, 1 + nameUtf16.length, 0x00]),
      nameUtf16,
      Buffer.from([0x00, 0x00]),
    ]);
    const sigHdr = Buffer.alloc(32);
    sigHdr.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04], 0);
    sigHdr.writeBigUInt64LE(BigInt(payload.length), 12); // nextHeaderOffset
    sigHdr.writeBigUInt64LE(BigInt(header.length), 20); // nextHeaderSize
    sigHdr.writeUInt32LE(zlib.crc32(header), 28);
    sigHdr.writeUInt32LE(zlib.crc32(sigHdr.subarray(12, 32)), 8);

    const archive = Buffer.concat([sigHdr, payload, header]);
    const entries = readSevenZipArchive(
      archive,
      (_folder, packed) => packed[0],
      { maxFiles: 100, maxUncompressedBytes: 1024 * 1024, maxRatio: 100 }
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('a.txt');
    expect(entries[0].data.equals(payload)).toBe(true);
  });
});

describe('B-7: deflate-blocks Adler-32 chunked SIMD equivalence > 2 MiB', () => {
  it('matches node:zlib deflateSync level 0 trailer byte-for-byte below, at, and above 2 MiB', () => {
    expect(combineAdler32).toBe(pngCombineAdler32);
    const lengths = [0, 1, 131_072, 2 * 1024 * 1024 - 1, 2 * 1024 * 1024, 2 * 1024 * 1024 + 1, 4 * 1024 * 1024 + 37];
    for (const len of lengths) {
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i += 97) buf[i] = (i * 31 + 7) & 0xff;
      const expectedStream = zlib.deflateSync(buf, { level: 0 });
      const expectedAdler = expectedStream.readUInt32BE(expectedStream.length - 4);
      expect(adler32(buf)).toBe(expectedAdler);
    }
  });
});

describe('B-9: parquet-encodings 32-bit fast unpack & CompactProtocolWriter growable buffer', () => {
  it('unpacks bitWidths 0, 1, 5, 16, 25, 31, 32 (including int32 wrap) and 40 bit-identically', () => {
    // bitWidthLimit = 32 triggers int32 wrap at bitWidth = 32 too; compare bw <= 32 exact BigInt values
    for (const bw of [0, 1, 5, 16, 25, 31, 32]) {
      const maxVal = bw === 0 ? 0n : (1n << BigInt(bw)) - 1n;
      const deltas: bigint[] = [];
      for (let i = 0; i < 8; i++) {
        deltas.push(bw === 0 ? 5n : 5n + ((maxVal * BigInt(i + 1)) / 8n));
      }
      const page = buildDeltaBinaryPackedPage(128, 4, 100n, 5n, [bw, bw, bw, bw], deltas);
      const expected: bigint[] = [100n];
      let acc = 100n;
      for (const d of deltas) {
        acc += d;
        expected.push(BigInt.asIntN(32, acc));
      }
      const decoded32 = decodeDeltaBinaryPacked(page, 0, deltas.length + 1, 32, 'col32');
      expect(Array.from(decoded32.values)).toEqual(expected);

      const expected64: bigint[] = [100n];
      let acc64 = 100n;
      for (const d of deltas) {
        acc64 += d;
        expected64.push(BigInt.asIntN(64, acc64));
      }
      const decoded64 = decodeDeltaBinaryPacked(page, 0, deltas.length + 1, 64, 'col64');
      expect(Array.from(decoded64.values)).toEqual(expected64);
    }

    // Also test bw = 40 (> 32 BigInt path)
    const deltas40 = [10n, 0x1_0000_0005n, 0x2_abcd_1234n, 15n, 0n, 1n, 2n, 3n];
    const page40 = buildDeltaBinaryPackedPage(128, 4, 1000n, 0n, [40, 40, 40, 40], deltas40);
    const decoded40 = decodeDeltaBinaryPacked(page40, 0, deltas40.length + 1, 64, 'col40');
    let acc40 = 1000n;
    const expected40 = [1000n];
    for (const d of deltas40) {
      acc40 += d;
      expected40.push(acc40);
    }
    expect(Array.from(decoded40.values)).toEqual(expected40);
  });

  it('serializes and reads structs, delta>15 headers, long lists, i32, i64, and UTF-8 strings via CompactProtocolWriter', () => {
    const writer = new CompactProtocolWriter();
    writer.writeStructBegin();
    writer.writeFieldBegin(1, ThriftType.I32);
    writer.writeI32(-123456);
    writer.writeFieldBegin(20, ThriftType.I64); // field delta > 15
    writer.writeI64(900719925474099); // safe integer above uint32
    writer.writeFieldBegin(21, ThriftType.BINARY);
    writer.writeString('한글 parquet test');
    writer.writeFieldBegin(22, ThriftType.LIST);
    writer.writeListBegin(ThriftType.I32, 16); // long list header (>= 15)
    for (let i = 0; i < 16; i++) writer.writeI32(i - 5);
    writer.writeFieldStop();
    writer.writeStructEnd();

    const buf = writer.toBuffer();
    const reader = new CompactProtocolReader(buf);
    reader.structBegin();
    const seenIds: number[] = [];
    let f1 = 0;
    let f20 = 0n;
    let f21 = '';
    const f22: number[] = [];
    while (true) {
      const f = reader.readFieldBegin();
      if (f.isStop) break;
      seenIds.push(f.fieldId);
      if (f.fieldId === 1) f1 = reader.readZigzag32();
      else if (f.fieldId === 20) f20 = reader.readZigzag64();
      else if (f.fieldId === 21) f21 = reader.readString();
      else if (f.fieldId === 22) {
        const hdr = reader.readListBegin();
        expect(hdr).toEqual({ elemType: ThriftType.I32, size: 16 });
        for (let i = 0; i < hdr.size; i++) f22.push(reader.readZigzag32());
      } else {
        reader.skip(f.type);
      }
    }
    reader.structEnd();
    expect(seenIds).toEqual([1, 20, 21, 22]);
    expect(f1).toBe(-123456);
    expect(f20).toBe(900719925474099n);
    expect(f21).toBe('한글 parquet test');
    expect(f22).toEqual(Array.from({ length: 16 }, (_, i) => i - 5));
  });
});

describe('B-10: PNM SWAR bitonal/PBM packing, WebM mux, AAC, Bzip2, JXL, Zstd-FSE, PSD, PNG scanlines', () => {
  it('matches bit-by-bit reference exactly for isBitonal across all 256 byte values and unaligned offsets', () => {
    // 1) Exhaustive single-byte check across offsets 0..7
    for (let byteVal = 0; byteVal <= 255; byteVal++) {
      for (let off = 0; off < 8; off++) {
        const backing = new Uint8Array(24);
        backing.fill(255);
        backing[off + 9] = byteVal;
        const view = backing.subarray(off, off + 15);
        expect(isBitonal(view)).toBe(byteVal === 0 || byteVal === 255);
      }
    }
    // Empty & all 0/255 mixed across multiple 4-byte words
    expect(isBitonal(new Uint8Array(0))).toBe(true);
    expect(isBitonal(Uint8Array.from([0, 255, 0, 255, 255, 0, 255, 0, 255, 0]))).toBe(true);
  });

  it('matches scalar reference PBM byte-for-byte for widths 1..33 and unaligned subarrays', () => {
    const referenceEncodePbm = (gray: Uint8Array, width: number, height: number): Buffer => {
      const header = Buffer.from(`P4\n${width} ${height}\n`, 'ascii');
      const stride = Math.ceil(width / 8);
      const out = Buffer.alloc(header.length + stride * height);
      header.copy(out, 0);
      for (let y = 0; y < height; y++) {
        const rowOffset = header.length + y * stride;
        const srcRow = y * width;
        for (let x = 0; x < width; x++) {
          if (gray[srcRow + x] < 128) {
            out[rowOffset + (x >> 3)] |= 1 << (7 - (x & 7));
          }
        }
      }
      return out;
    };

    for (const width of [1, 7, 8, 9, 15, 16, 17, 24, 31, 32, 33]) {
      const height = 3;
      for (const offset of [0, 1, 2, 3]) {
        const backing = new Uint8Array(offset + width * height + 5);
        for (let i = 0; i < width * height; i++) {
          const mod = i % 5;
          backing[offset + i] = mod === 0 ? 0 : mod === 1 ? 127 : mod === 2 ? 128 : mod === 3 ? 255 : 42;
        }
        const gray = backing.subarray(offset, offset + width * height);
        const actual = encodePbm(gray, width, height);
        const expected = referenceEncodePbm(gray, width, height);
        expect(actual.equals(expected)).toBe(true);
      }
    }
  });

  it('muxes valid Matroska/WebM EBML structure verified by independent EBML walker', () => {
    const opusHead = new Uint8Array(19);
    opusHead.set(Buffer.from('OpusHead', 'ascii'), 0);
    opusHead[8] = 1; // version
    opusHead[9] = 2; // channels
    new DataView(opusHead.buffer).setUint16(10, 312, true); // pre-skip
    new DataView(opusHead.buffer).setUint32(12, 48000, true); // sample rate

    const webm = muxWebm({
      video: {
        width: 320,
        height: 240,
        config: { codec: 'vp09.00.10.08' },
        chunks: [
          { data: Uint8Array.from([0x82, 0x49, 0x83, 0x42, 1, 2, 3]), timestampMicros: 0, isKeyFrame: true },
          { data: Uint8Array.from([0x82, 0x49, 0x83, 0x42, 4, 5]), timestampMicros: 33_000, isKeyFrame: false },
        ],
      },
      audio: {
        sampleRate: 48000,
        channels: 2,
        config: { codec: 'opus', description: opusHead },
        chunks: [{ data: Uint8Array.from([0xf8, 1, 2]), timestampMicros: 0, isKeyFrame: true }],
      },
    });
    const parsed = walkWebm(webm);
    expect(parsed.docType).toBe('webm');
    expect(parsed.tracks).toHaveLength(2);
    expect(parsed.tracks[0].codecId).toBe('V_VP9');
    expect(parsed.tracks[1].codecId).toBe('A_OPUS');
    expect(parsed.blocks.filter((b) => b.track === 1).map((b) => b.timecode)).toEqual([0, 33]);
    expect(parsed.cues).toHaveLength(1);
  });

  it('parses AAC AudioSpecificConfig standard and explicit sample rates with 32-bit MSB BitReader', () => {
    // 1) ObjectType=2 (AAC-LC), freqIdx=4 (44100 Hz), ch=2 -> 00010 0100 0010 000 = 0x12 0x10
    const ascStd = parseAacLcConfig(Uint8Array.from([0x12, 0x10]));
    expect(ascStd).toEqual({ sampleRate: 44100, channels: 2, samplingFrequencyIndex: 4, channelConfiguration: 2 });

    // 2) ObjectType=2, freqIdx=15 (explicit 24-bit sampleRate=48000), ch=1:
    // bits: 00010 (5) | 1111 (4) | 000000001011101110000000 (24b 48000 = 0x00bb80) | 0001 (4) = 37 bits (5 bytes)
    const bw = new MsbBitWriter();
    bw.writeBits(2, 5);
    bw.writeBits(15, 4);
    bw.writeBits(48000, 24);
    bw.writeBits(1, 4);
    const ascExplicit = parseAacLcConfig(bw.toBuffer());
    expect(ascExplicit.sampleRate).toBe(48000);
    expect(ascExplicit.channels).toBe(1);
    expect(() => parseAacLcConfig(Uint8Array.from([0x12]))).toThrow();
  });

  it('encodes bzip2 stream header BZh9 cleanly with expected framing', () => {
    const sample = Buffer.from('easyconvert parser bit hardening vector '.repeat(40), 'utf8');
    const bzOut = compressBzip2(sample);
    expect(bzOut.subarray(0, 4).toString('ascii')).toBe('BZh9');
    expect(bzOut.subarray(4, 10).toString('hex')).toBe('314159265359');
  });

  it('decodes independent reference bzip2 vector cleanly', () => {
    const sample = Buffer.from('easyconvert parser bit hardening vector '.repeat(40), 'utf8');
    const referenceBz2 = Buffer.from(
      'QlpoOTFBWSZTWctXyIAAAQORgEAAPuHdIDAAuAoaaYAChppgAClVPU0eiMm1OQn4JuJwJ0J8E9iaEwJkTyJoTkTQmBOxNhPAnQnYm4mhNCdiZE2E2E0EwJyJgTImBMiexOBPon8XckU4UJDLV8iA',
      'base64'
    );
    expect(decompressBzip2(referenceBz2).equals(sample)).toBe(true);
  });

  it('reads 1..32-bit LSB fields accurately via JXL BitReader and Zstd ForwardBitReader', () => {
    const raw = Uint8Array.from([0b1010_0101, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
    const jxlBits = new JxlBitReader(raw);
    expect(jxlBits.bool()).toBe(true);
    expect(jxlBits.read(7)).toBe(0b0101_0010); // remaining 7 bits of 0xa5: (0xa5 >> 1) = 0x52
    expect(jxlBits.read(32)).toBe(0x9a785634);

    const zstdBits = new ForwardBitReader(raw, 0, raw.length);
    expect(zstdBits.peek(16)).toBe(0x34a5);
    expect(zstdBits.read(20)).toBe(0x634a5);
    expect(zstdBits.read(16)).toBe(0xa785);
    expect(zstdBits.overrun).toBe(false);
    zstdBits.skip(20);
    expect(zstdBits.overrun).toBe(true);
  });

  it('encodes multi-row PSD PackBits planes into a single growable buffer cleanly', () => {
    // 256-pixel alternating noise row triggers worst-case PackBits expansion (> width bytes per row)
    const width = 256;
    const height = 4;
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 53) & 0xff;
    const psd = encodePsd({ width, height, channels: 3, depth: 8, samples: rgb });
    expect(psd.subarray(0, 4).toString('ascii')).toBe('8BPS');
    expect(psd.readUInt32BE(14)).toBe(height);
    expect(psd.readUInt32BE(18)).toBe(width);
  });

  it('splits PNG alpha planes in batches while preserving exact color and alpha bytes', async () => {
    // 512 x 60 RGBA image = ~120 KB filtered scanlines -> exercises > 64 KiB batch flush path cleanly
    const width = 512;
    const height = 60;
    const rawScanlines = Buffer.alloc((width * 4 + 1) * height);
    const expectedColor = Buffer.alloc(width * height * 3);
    const expectedAlpha = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      const rowStart = y * (width * 4 + 1);
      rawScanlines[rowStart] = 0; // filter 0
      for (let x = 0; x < width; x++) {
        const px = y * width + x;
        const r = x & 0xff;
        const g = y & 0xff;
        const b = 0x55;
        const a = (x * 7 + y * 13) & 0xff;
        rawScanlines[rowStart + 1 + x * 4 + 0] = r;
        rawScanlines[rowStart + 1 + x * 4 + 1] = g;
        rawScanlines[rowStart + 1 + x * 4 + 2] = b;
        rawScanlines[rowStart + 1 + x * 4 + 3] = a;
        expectedColor[px * 3 + 0] = r;
        expectedColor[px * 3 + 1] = g;
        expectedColor[px * 3 + 2] = b;
        expectedAlpha[px] = a;
      }
    }
    const idat = zlib.deflateSync(rawScanlines);
    const { color, alpha } = await splitAlphaPlanes([idat], width, height, 3, 8);
    expect(zlib.inflateSync(color).equals(expectedColor)).toBe(true);
    expect(zlib.inflateSync(alpha).equals(expectedAlpha)).toBe(true);
  });
});
