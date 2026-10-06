import zlib from 'node:zlib';
import { CompressionCodec, ParquetCodecUnavailableError, ParquetFormatError } from './parquet-format';
import { compressSnappy, decompressSnappy } from './parquet-snappy';
import { decompressZstd } from './zstd';

/**
 * Page compression for Parquet column chunks (the codec applies to each page body).
 * ZSTD compression needs a runtime that ships zstd in node:zlib (Node 22.15+/23.8+); older
 * runtimes can still read ZSTD pages through the in-repo decoder but cannot write them.
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

/** Compresses one page body with a codec the writer supports. */
export function compressPage(codec: CompressionCodec, data: Uint8Array): Buffer {
  if (codec === CompressionCodec.UNCOMPRESSED) {
    // Copy: callers reuse their page buffers, and the result is retained until the file is assembled.
    return Buffer.from(data);
  }
  if (codec === CompressionCodec.SNAPPY) return compressSnappy(data);
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
    `Unsupported Parquet write codec: ${codecName(codec)}. Supported: UNCOMPRESSED, SNAPPY, ZSTD.`
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

function zstdDecode(data: Buffer, expectedBytes: number): Buffer {
  const native = nativeZstd();
  if (native) {
    try {
      return native.zstdDecompressSync(data, { maxOutputLength: expectedBytes });
    } catch (zstdError) {
      const code = (zstdError as { code?: string }).code;
      const reason = code === 'ERR_BUFFER_TOO_LARGE' ? 'exceeds its declared size' : 'is not valid';
      throw new ParquetFormatError(`Corrupted Parquet page: ZSTD data ${reason}`);
    }
  }
  try {
    return decompressZstd(data);
  } catch (zstdError) {
    throw new ParquetFormatError(
      `Corrupted Parquet page: ZSTD data is not valid (${zstdError instanceof Error ? zstdError.message : 'decode failed'})`
    );
  }
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
  } else {
    throw new ParquetFormatError(
      `Unsupported Parquet compression codec: ${codecName(codec)}. Supported codecs: UNCOMPRESSED, SNAPPY, GZIP, ZSTD.`
    );
  }
  if (out.length !== expectedBytes) {
    throw new ParquetFormatError(
      `Corrupted Parquet page: ${codecName(codec)} page decoded to ${out.length} bytes, header declares ${expectedBytes}`
    );
  }
  return out;
}
