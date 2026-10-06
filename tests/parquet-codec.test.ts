import { describe, expect, it } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import { pyarrowCompress } from './helpers/parquet-oracle';
import { decodeZstdFallback } from '../src/lib/conversions/parquet-codec';
import { ParquetFormatError } from '../src/lib/conversions/parquet';

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
