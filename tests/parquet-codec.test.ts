import { describe, expect, it } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import { pyarrowCompress } from './helpers/parquet-oracle';
import { decodeZstdFallback, decompressLz4Raw, decompressPage } from '../src/lib/conversions/parquet-codec';
import { CompressionCodec, ParquetFormatError } from '../src/lib/conversions/parquet';

const MIB = 1024 * 1024;

/**
 * The pure TypeScript zstd decoder is what Node 20 (no zstd in node:zlib) falls back to. A page's
 * declared size is the only bound it needs, so the archive ratio guard must not apply.
 */
describe('zstd fallback decoding of parquet pages', () => {
  oracleTest('decodes a 4 MiB zero page produced by the reference compressor, ratio guard notwithstanding', ['python3'], () => {
    const zeros = Buffer.alloc(4 * MIB);
    const frame = pyarrowCompress('zstd', zeros);
    expect(frame.length).toBeLessThan(zeros.length / 1000);
    const decoded = decodeZstdFallback(frame, zeros.length);
    expect(decoded.length).toBe(zeros.length);
    expect(decoded.equals(zeros)).toBe(true);
  });

  oracleTest('rejects output beyond the declared page size and output shorter than it', ['python3'], () => {
    const payload = Buffer.alloc(2 * MIB, 7);
    const frame = pyarrowCompress('zstd', payload);
    expect(() => decodeZstdFallback(frame, MIB)).toThrow(ParquetFormatError);
    expect(() => decodeZstdFallback(frame, 3 * MIB)).toThrow(/decoded to 2097152 bytes/);
  });

  it('rejects a truncated frame', () => {
    const truncated = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x10]);
    expect(() => decodeZstdFallback(truncated, 16)).toThrow(ParquetFormatError);
  });
});

describe('LZ4_RAW decoding of parquet pages', () => {
  it('decodes literal runs, overlapping matches, and extended lengths', () => {
    // Token 0x42: 4 literal bytes ("abcd"), match length 2 + 4 = 6 at offset 4 -> "abcdabcdab",
    // followed by final token 0x20: 2 literal bytes ("Z!") -> "abcdabcdabZ!" (12 bytes).
    const block = Buffer.from([0x42, 0x61, 0x62, 0x63, 0x64, 0x04, 0x00, 0x20, 0x5a, 0x21]);
    expect(decompressLz4Raw(block, 12).toString('utf-8')).toBe('abcdabcdabZ!');
    expect(decompressPage(CompressionCodec.LZ4_RAW, block, 12).toString('utf-8')).toBe('abcdabcdabZ!');
  });

  it('rejects truncated blocks, zero offsets, and size mismatches', () => {
    const valid = Buffer.from([0x40, 0x61, 0x62, 0x63, 0x64]);
    expect(() => decompressLz4Raw(valid, 5)).toThrow(ParquetFormatError);
    expect(() => decompressLz4Raw(Buffer.from([0x11, 0x61, 0x00, 0x00]), 6)).toThrow(/invalid LZ4_RAW match offset/);
    expect(() => decompressLz4Raw(Buffer.from([0x40, 0x61, 0x62]), 4)).toThrow(/LZ4_RAW literal exceeds bounds/);
  });
});

describe('LZ4 (Hadoop-framed, then raw) decoding of parquet pages', () => {
  const rawBlock = Buffer.from([0x42, 0x61, 0x62, 0x63, 0x64, 0x04, 0x00, 0x20, 0x5a, 0x21]);
  const decoded = 'abcdabcdabZ!';

  function framed(...blocks: { size: number; body: Buffer }[]): Buffer {
    return Buffer.concat(
      blocks.map(({ size, body }) => {
        const prefix = Buffer.alloc(8);
        prefix.writeUInt32BE(size, 0);
        prefix.writeUInt32BE(body.length, 4);
        return Buffer.concat([prefix, body]);
      })
    );
  }

  it('decodes consecutive Hadoop-framed blocks', () => {
    const data = framed({ size: 12, body: rawBlock }, { size: 12, body: rawBlock });
    expect(decompressPage(CompressionCodec.LZ4, data, 24).toString('utf-8')).toBe(decoded + decoded);
  });

  it('falls back to a bare raw block when the data is not framed', () => {
    expect(decompressPage(CompressionCodec.LZ4, rawBlock, 12).toString('utf-8')).toBe(decoded);
  });

  it('refuses a framed block that claims more than the page size, without allocating it', () => {
    const hostile = framed({ size: 0xffffffff, body: rawBlock });
    expect(() => decompressPage(CompressionCodec.LZ4, hostile, 12)).toThrow(ParquetFormatError);
  });

  it('refuses framed blocks that decode to fewer or more bytes than the page declares', () => {
    const data = framed({ size: 12, body: rawBlock });
    expect(() => decompressPage(CompressionCodec.LZ4, data, 24)).toThrow(ParquetFormatError);
    expect(() => decompressPage(CompressionCodec.LZ4, data, 6)).toThrow(ParquetFormatError);
  });

  it('refuses a raw block that expands beyond the page size', () => {
    expect(() => decompressPage(CompressionCodec.LZ4, rawBlock, 8)).toThrow(/exceeds|bounds/);
  });
});

describe('zstd frame of an empty page', () => {
  const emptyFrame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x01, 0x00, 0x00]);

  it('decodes to no bytes through both decoders', () => {
    expect(decompressPage(CompressionCodec.ZSTD, emptyFrame, 0).length).toBe(0);
    expect(decodeZstdFallback(emptyFrame, 0).length).toBe(0);
  });
});
