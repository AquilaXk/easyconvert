import zlib from 'node:zlib';
import { CompressionCodec, ParquetCodecUnavailableError, ParquetFormatError } from './parquet-format';
import { compressSnappy, decompressSnappy, decompressSnappySlice } from './parquet-snappy';
import { decompressZstd } from './zstd';

/**
 * Page compression for Parquet column chunks (the codec applies to each page body).
 * ZSTD compression needs a runtime that ships zstd in node:zlib (Node 22.15+/23.8+); older
 * runtimes can still read ZSTD pages through the in-repo decoder but cannot write them.
 *
 * Raw and Hadoop-framed LZ4 block decompression match `lz4/lz4` (`lib/lz4.c`,
 * commit `6b589e8053bd9c524138d78adec78fcaefa35cab`,
 * SHA-256 `6befbbafe8d8f2fe6a8cb2d04572c3adb9a7fd01a00179f9bdf1a598616c6c52`, BSD-2-Clause):
 *
 * LZ4 Library
 * Copyright (c) 2011-2020, Yann Collet
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 * * Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 * * Redistributions in binary form must reproduce the above copyright notice, this
 *   list of conditions and the following disclaimer in the documentation and/or
 *   other materials provided with the distribution.
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/** zstd level used when writing (the library default). */
const ZSTD_WRITE_LEVEL = 3;

interface ZstdZlib {
  zstdCompressSync(buf: Uint8Array, opts: { params: Record<number, number> }): Buffer;
  zstdDecompressSync(buf: Uint8Array, opts: { maxOutputLength: number }): Buffer;
  constants: { ZSTD_c_compressionLevel?: number };
}

function nativeZstd(): ZstdZlib | null {
  const candidate = zlib as unknown as Partial<ZstdZlib>;
  const level = candidate.constants?.ZSTD_c_compressionLevel;
  const hasZstd =
    typeof candidate.zstdCompressSync === 'function' &&
    typeof candidate.zstdDecompressSync === 'function' &&
    typeof level === 'number';
  return hasZstd ? (zlib as unknown as ZstdZlib) : null;
}

/** True when this runtime can write ZSTD-compressed pages. */
export function isZstdWriteAvailable(): boolean {
  return nativeZstd() !== null;
}

export function codecName(codec: CompressionCodec): string {
  return CompressionCodec[codec] ?? String(codec);
}

const LZ4_TOKEN_MASK = 0x0f;
const LZ4_TOKEN_SHIFT = 4;
const LZ4_EXTENDED_LENGTH = 15;
const LZ4_CONTINUATION_BYTE = 255;
const LZ4_MIN_MATCH = 4;
const LZ4_OFFSET_BYTES = 2;

/** Compresses one page body with a codec the writer supports. */
export function compressPage(codec: CompressionCodec, data: Uint8Array): Buffer {
  if (codec === CompressionCodec.UNCOMPRESSED) {
    // Copy: callers reuse their page buffers, and the result is retained until the file is assembled.
    return Buffer.from(data);
  }
  if (codec === CompressionCodec.SNAPPY) return compressSnappy(data);
  if (codec === CompressionCodec.GZIP) return zlib.gzipSync(data);
  if (codec === CompressionCodec.ZSTD) {
    const native = nativeZstd();
    if (!native) {
      throw new ParquetCodecUnavailableError(
        'ZSTD compression requires a Node.js runtime with zstd support in node:zlib (22.15 or newer); use SNAPPY instead.'
      );
    }
    const level = native.constants.ZSTD_c_compressionLevel as number;
    return native.zstdCompressSync(data, { params: { [level]: ZSTD_WRITE_LEVEL } });
  }
  throw new ParquetCodecUnavailableError(
    `Unsupported Parquet write codec: ${codecName(codec)}. Supported: UNCOMPRESSED, SNAPPY, GZIP, ZSTD.`
  );
}

function gunzip(data: Buffer, expectedBytes: number): Buffer {
  try {
    return zlib.gunzipSync(data, { maxOutputLength: expectedBytes });
  } catch (gzipError) {
    if ((gzipError as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ParquetFormatError(`GZIP page exceeds its declared size of ${expectedBytes} bytes`);
    }
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: expectedBytes });
    } catch {
      throw new ParquetFormatError('Corrupted Parquet page: GZIP data is not valid');
    }
  }
}

function copyLz4Match(out: Buffer, outPos: number, offset: number, matchLen: number): void {
  const matchPos = outPos - offset;
  if (offset >= matchLen) {
    out.copyWithin(outPos, matchPos, matchPos + matchLen);
    return;
  }
  if (offset === 1) {
    out.fill(out[matchPos], outPos, outPos + matchLen);
    return;
  }
  out.copyWithin(outPos, matchPos, matchPos + offset);
  let copied = offset;
  while (copied < matchLen) {
    const step = copied <= matchLen - copied ? copied : matchLen - copied;
    out.copyWithin(outPos + copied, outPos, outPos + step);
    copied += step;
  }
}

/**
 * Decodes one raw LZ4 block `src[srcStart..srcEnd)` directly into `out[outStart..outStart + expectedBytes)`.
 * Throws `ParquetFormatError` unless every byte in `[outStart, outStart + expectedBytes)` is written, so a caller
 * using `Buffer.allocUnsafe(expectedBytes)` can never expose uninitialized memory.
 */
function decodeLz4RawInto(
  src: Buffer,
  srcStart: number,
  srcEnd: number,
  out: Buffer,
  outStart: number,
  expectedBytes: number
): void {
  if (expectedBytes === 0) {
    if (srcStart !== srcEnd) {
      throw new ParquetFormatError('Corrupted Parquet page: non-empty LZ4_RAW block for 0 uncompressed bytes');
    }
    return;
  }
  const outLimit = outStart + expectedBytes;
  let pos = srcStart;
  let outPos = outStart;
  while (pos < srcEnd) {
    const token = src[pos++];
    let literalLen = token >>> LZ4_TOKEN_SHIFT;
    if (literalLen === LZ4_EXTENDED_LENGTH) {
      for (;;) {
        if (pos >= srcEnd) {
          throw new ParquetFormatError('Corrupted Parquet page: truncated LZ4_RAW literal length');
        }
        const extra = src[pos++];
        literalLen += extra;
        if (extra !== LZ4_CONTINUATION_BYTE) break;
      }
    }
    if (pos + literalLen > srcEnd || outPos + literalLen > outLimit) {
      throw new ParquetFormatError('Corrupted Parquet page: LZ4_RAW literal exceeds bounds');
    }
    if (literalLen <= 16) {
      for (let i = 0; i < literalLen; i++) out[outPos + i] = src[pos + i];
    } else {
      src.copy(out, outPos, pos, pos + literalLen);
    }
    pos += literalLen;
    outPos += literalLen;
    if (pos === srcEnd) break;

    if (pos + LZ4_OFFSET_BYTES > srcEnd) {
      throw new ParquetFormatError('Corrupted Parquet page: truncated LZ4_RAW match offset');
    }
    const offset = src[pos] | (src[pos + 1] << 8);
    pos += LZ4_OFFSET_BYTES;
    if (offset === 0 || offset > outPos - outStart) {
      throw new ParquetFormatError(`Corrupted Parquet page: invalid LZ4_RAW match offset ${offset}`);
    }
    let matchLen = (token & LZ4_TOKEN_MASK) + LZ4_MIN_MATCH;
    if ((token & LZ4_TOKEN_MASK) === LZ4_EXTENDED_LENGTH) {
      for (;;) {
        if (pos >= srcEnd) {
          throw new ParquetFormatError('Corrupted Parquet page: truncated LZ4_RAW match length');
        }
        const extra = src[pos++];
        matchLen += extra;
        if (extra !== LZ4_CONTINUATION_BYTE) break;
      }
    }
    if (outPos + matchLen > outLimit) {
      throw new ParquetFormatError('Corrupted Parquet page: LZ4_RAW match exceeds declared size');
    }
    copyLz4Match(out, outPos, offset, matchLen);
    outPos += matchLen;
  }
  if (outPos !== outLimit) {
    throw new ParquetFormatError(
      `Corrupted Parquet page: LZ4_RAW page decoded to ${outPos - outStart} bytes, header declares ${expectedBytes}`
    );
  }
}

function decompressLz4RawSlice(data: Buffer, start: number, end: number, expectedBytes: number): Buffer {
  if (expectedBytes < 0) {
    throw new ParquetFormatError(`Corrupted Parquet page: negative LZ4_RAW size ${expectedBytes}`);
  }
  if (expectedBytes === 0) {
    if (start !== end) {
      throw new ParquetFormatError('Corrupted Parquet page: non-empty LZ4_RAW block for 0 uncompressed bytes');
    }
    return Buffer.alloc(0);
  }
  const out = Buffer.allocUnsafe(expectedBytes);
  decodeLz4RawInto(data, start, end, out, 0, expectedBytes);
  return out;
}

/**
 * Decompresses an LZ4 raw block (Parquet LZ4_RAW codec) into a buffer of `expectedBytes` bytes.
 */
export function decompressLz4Raw(data: Buffer, expectedBytes: number): Buffer {
  return decompressLz4RawSlice(data, 0, data.length, expectedBytes);
}

const HADOOP_LZ4_PREFIX_BYTES = 8;

/**
 * Decodes the Hadoop framing of the Parquet LZ4 codec: repeated blocks of a big-endian uncompressed
 * size, a big-endian compressed size and one raw LZ4 block. Returns null when the data is not framed
 * that way or a block does not decode to its declared size, so the caller can try a bare raw block.
 * A block that declares more than the bytes still allowed by the page size is never allocated.
 */
function decodeLz4HadoopSlice(data: Buffer, start: number, end: number, expectedBytes: number): Buffer | null {
  if (expectedBytes < 0) return null;
  if (expectedBytes === 0) return start === end ? Buffer.alloc(0) : null;
  if (end - start < HADOOP_LZ4_PREFIX_BYTES) return null;
  const firstBlock = data.readUInt32BE(start);
  const firstCompressed = data.readUInt32BE(start + 4);
  if (firstBlock > expectedBytes || firstCompressed > end - start - HADOOP_LZ4_PREFIX_BYTES) return null;
  const out = Buffer.allocUnsafe(expectedBytes);
  let pos = start;
  let outPos = 0;
  while (pos < end) {
    if (end - pos < HADOOP_LZ4_PREFIX_BYTES) return null;
    const blockBytes = data.readUInt32BE(pos);
    const compressedBytes = data.readUInt32BE(pos + 4);
    pos += HADOOP_LZ4_PREFIX_BYTES;
    if (blockBytes > expectedBytes - outPos || compressedBytes > end - pos) return null;
    try {
      decodeLz4RawInto(data, pos, pos + compressedBytes, out, outPos, blockBytes);
    } catch (blockError) {
      if (blockError instanceof ParquetFormatError) return null;
      throw blockError;
    }
    pos += compressedBytes;
    outPos += blockBytes;
  }
  return outPos === expectedBytes ? out : null;
}

/**
 * Decompresses a page of the deprecated Parquet LZ4 codec: Hadoop framing first, then a bare raw
 * block, as parquet-mr and Arrow read it. The page's declared size bounds both attempts.
 */
export function decompressLz4(data: Buffer, expectedBytes: number): Buffer {
  return decodeLz4HadoopSlice(data, 0, data.length, expectedBytes) ?? decompressLz4RawSlice(data, 0, data.length, expectedBytes);
}

/**
 * Pure TypeScript zstd decoding, used where node:zlib has no zstd (Node 20). The page's declared size
 * is the output bound (the generic archive ratio guard does not apply), and the result must match it.
 */
export function decodeZstdFallback(data: Buffer, expectedBytes: number): Buffer {
  let out: Buffer;
  try {
    out = decompressZstd(data, { maxOutputBytes: expectedBytes });
  } catch (zstdError) {
    throw new ParquetFormatError(
      `Corrupted Parquet page: ZSTD data is not valid (${zstdError instanceof Error ? zstdError.message : 'decode failed'})`
    );
  }
  if (out.length !== expectedBytes) {
    throw new ParquetFormatError(`Corrupted Parquet page: ZSTD page decoded to ${out.length} bytes, header declares ${expectedBytes}`);
  }
  return out;
}

function zstdDecode(data: Buffer, expectedBytes: number): Buffer {
  const native = nativeZstd();
  if (native) {
    try {
      // node:zlib rejects a limit of 0; a frame of an empty page still has to decode, and the exact-size check follows.
      return native.zstdDecompressSync(data, { maxOutputLength: Math.max(expectedBytes, 1) });
    } catch (zstdError) {
      const code = (zstdError as { code?: string }).code;
      const reason = code === 'ERR_BUFFER_TOO_LARGE' ? 'exceeds its declared size' : 'is not valid';
      throw new ParquetFormatError(`Corrupted Parquet page: ZSTD data ${reason}`);
    }
  }
  return decodeZstdFallback(data, expectedBytes);
}

/**
 * Decompresses one page body. The declared uncompressed size bounds the output and must match it
 * exactly, so a hostile page cannot expand beyond what its header promised.
 */
export function decompressPage(codec: CompressionCodec, data: Buffer, expectedBytes: number): Buffer {
  let out: Buffer;
  if (codec === CompressionCodec.UNCOMPRESSED) {
    out = data;
  } else if (codec === CompressionCodec.SNAPPY) {
    out = decompressSnappy(data, expectedBytes);
  } else if (codec === CompressionCodec.GZIP) {
    out = gunzip(data, expectedBytes);
  } else if (codec === CompressionCodec.ZSTD) {
    out = zstdDecode(data, expectedBytes);
  } else if (codec === CompressionCodec.LZ4_RAW) {
    out = decompressLz4Raw(data, expectedBytes);
  } else if (codec === CompressionCodec.LZ4) {
    out = decompressLz4(data, expectedBytes);
  } else {
    throw new ParquetFormatError(
      `Unsupported Parquet compression codec: ${codecName(codec)}. Supported codecs: UNCOMPRESSED, SNAPPY, GZIP, ZSTD, LZ4, LZ4_RAW.`
    );
  }
  if (out.length !== expectedBytes) {
    throw new ParquetFormatError(
      `Corrupted Parquet page: ${codecName(codec)} page decoded to ${out.length} bytes, header declares ${expectedBytes}`
    );
  }
  return out;
}

/**
 * Decompresses one page body from `data[start..end]` without slicing `data` for raw Snappy pages.
 */
export function decompressPageSlice(
  codec: CompressionCodec,
  data: Buffer,
  start: number,
  end: number,
  expectedBytes: number
): Buffer {
  if (codec === CompressionCodec.SNAPPY) {
    const out = decompressSnappySlice(data, start, end, expectedBytes);
    if (out.length !== expectedBytes) {
      throw new ParquetFormatError(
        `Corrupted Parquet page: SNAPPY page decoded to ${out.length} bytes, header declares ${expectedBytes}`
      );
    }
    return out;
  }
  if (codec === CompressionCodec.LZ4_RAW) {
    return decompressLz4RawSlice(data, start, end, expectedBytes);
  }
  if (codec === CompressionCodec.LZ4) {
    return decodeLz4HadoopSlice(data, start, end, expectedBytes) ?? decompressLz4RawSlice(data, start, end, expectedBytes);
  }
  return decompressPage(codec, data.subarray(start, end), expectedBytes);
}
