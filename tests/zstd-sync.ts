import zlib from 'node:zlib';
import { parseZstdDictionary } from '../src/lib/conversions/zstd-decoder';
import { decompressZstdWithDictionary } from '../src/lib/conversions/zstd';
import { nativeZstdZlib } from '../src/lib/conversions/zstd-native';

/**
 * Synchronous Zstandard helpers for tests. Frames are made by libzstd (node:zlib); they are read back by the in-repo
 * dictionary-frame decoder with an empty raw dictionary, so the decoder that serves the built-in dictionaries is
 * exercised on plain frames and its guards (block maximum, declared size, size and ratio caps) stay under test.
 */
const EMPTY_DICTIONARY = parseZstdDictionary(Buffer.alloc(0));

export interface TestZstdCompressOptions {
  level?: number;
  checksum?: boolean;
}

export function compressZstd(input: Buffer, options: TestZstdCompressOptions = {}): Buffer {
  const native = nativeZstdZlib().constants;
  return zlib.zstdCompressSync(input, {
    params: {
      [native.ZSTD_c_compressionLevel]: options.level ?? 3,
      [native.ZSTD_c_checksumFlag]: options.checksum === false ? 0 : 1,
    },
  });
}

export function decompressZstd(frame: Buffer): Buffer {
  return decompressZstdWithDictionary(frame, EMPTY_DICTIONARY);
}
