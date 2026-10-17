import zlib from 'node:zlib';
import { ConversionFailedError, CpuTaskAbortedError, DecompressionLimitError } from '../types';
import { ARCHIVE_RATIO_FLOOR_BYTES } from './archive-extraction-safety';
import { parseZstdFrameHeader, ZSTD_SECURITY_LIMITS, type ZstdFrameHeader } from './zstd';
import {
  ZSTD_BLOCK_SIZE_MAX,
  ZSTD_DECODER_WINDOW_SIZE_MAX,
  ZSTD_LEVEL_DEFAULT,
  ZSTD_LEVEL_MAX,
  ZSTD_LEVEL_MIN,
} from './zstd-tables';

/**
 * Zstandard through libzstd as node:zlib ships it, for the archive conversions. The frames are the reference library's:
 * the content checksum is on (the CLI default) and the content size is written, so the reference CLI tests and lists them.
 *
 * node:zlib's decoder cannot be handed a stream as it is: it stops after the first frame, takes a leading skippable frame
 * for the end of the input and returns the prefix of a truncated frame without an error. So the stream is walked here first
 * (frame headers and block headers only, no decoding) and libzstd is given one complete frame at a time. The walk is what
 * keeps the guards of the pure decoder (zstd.ts): a malformed or truncated frame, a window beyond the decoder limit and a
 * frame that names a dictionary are refused before libzstd runs, a declared size is held against the byte and ratio caps
 * before anything is allocated, and a frame that declares none is bounded by the output length it is decoded under.
 */

interface DecodeOptions {
  maxOutputLength: number;
  params: Record<number, number>;
  chunkSize: number;
}

/** The zstd half of node:zlib, which the pinned Node typings (20) do not declare; the runtime requires Node 24, where it exists. */
export interface ZstdZlib {
  zstdCompress(
    buffer: Uint8Array,
    options: { params: Record<number, number>; pledgedSrcSize: number; chunkSize: number },
    callback: (error: Error | null, result: Buffer) => void
  ): void;
  zstdDecompress(
    buffer: Uint8Array,
    options: DecodeOptions,
    callback: (error: Error | null, result: Buffer) => void
  ): void;
  zstdDecompressSync(buffer: Uint8Array, options: DecodeOptions): Buffer;
  constants: { ZSTD_c_compressionLevel: number; ZSTD_c_checksumFlag: number; ZSTD_d_windowLogMax: number };
}

export function nativeZstdZlib(): ZstdZlib {
  return zlib as unknown as ZstdZlib;
}

const BLOCK_HEADER_BYTES = 3;
const BLOCK_TYPE_RAW = 0;
const BLOCK_TYPE_RLE = 1;
const BLOCK_TYPE_COMPRESSED = 2;
const BLOCK_TYPE_RESERVED = 3;
const BLOCK_LAST_BIT = 0x01;
const BLOCK_TYPE_SHIFT = 1;
const BLOCK_TYPE_MASK = 0x03;
const BLOCK_SIZE_SHIFT = 3;
const BYTE_BITS = 8;
const THIRD_BYTE_SHIFT = 16;
const RLE_BLOCK_PAYLOAD_BYTES = 1;
const CONTENT_CHECKSUM_BYTES = 4;
const MAGIC_BYTES = 4;
const SKIPPABLE_FRAME_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_FRAME_MAGIC_MAX = 0x184d2a5f;
const SKIPPABLE_HEADER_BYTES = 8;
const ZSTD_FRAME_MAGIC = 0xfd2fb528;
/** A frame this small to decode is decoded on the calling thread; a thread-pool round trip costs more than the work. */
const SYNC_DECODE_MAX_DECLARED_BYTES = 1024 * 1024;
/**
 * node:zlib collects its output in chunks of 16 KiB unless told otherwise, and a chunk is a round trip between the thread that
 * runs libzstd and the event loop: a 5 MB frame decodes in 11 ms that way and in 2.4 ms with chunks of 1 MiB or more (4 vCPU
 * Linux, Node 24); compression is 25 percent faster with 1 MiB chunks.
 */
const COMPRESS_CHUNK_BYTES = 1024 * 1024;
const DECODE_CHUNK_MIN_BYTES = 64 * 1024;
const DECODE_CHUNK_MAX_BYTES = 16 * 1024 * 1024;
/** Chunk for a frame that declares no size. */
const DECODE_CHUNK_UNDECLARED_BYTES = 1024 * 1024;
const DECODER_WINDOW_LOG_MAX = Math.log2(ZSTD_DECODER_WINDOW_SIZE_MAX);
const BUFFER_TOO_LARGE_CODE = 'ERR_BUFFER_TOO_LARGE';

interface FrameSpan {
  start: number;
  end: number;
  /** Content size the header declares, or null when it carries none. */
  declaredSize: number | null;
}

export interface ZstdNativeOptions {
  signal?: AbortSignal;
}

export interface ZstdNativeCompressOptions extends ZstdNativeOptions {
  /** Compression level 1 to 19 (default 3, the level the engine has always used). */
  level?: number;
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new CpuTaskAbortedError('zstd'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CpuTaskAbortedError('zstd');
}

/**
 * Compresses `input` into one Zstandard frame, on a thread of libuv's pool. The product has always written level 3, the
 * library default, and writes the content checksum and the content size as the reference CLI does.
 */
export async function compressZstdNative(input: Buffer, options: ZstdNativeCompressOptions = {}): Promise<Buffer> {
  const level = options.level ?? ZSTD_LEVEL_DEFAULT;
  if (!Number.isInteger(level) || level < ZSTD_LEVEL_MIN || level > ZSTD_LEVEL_MAX) {
    throw new ConversionFailedError(
      `Unsupported zstd compression level ${String(level)}: expected an integer from ${ZSTD_LEVEL_MIN} to ${ZSTD_LEVEL_MAX}.`
    );
  }
  throwIfAborted(options.signal);
  const native = nativeZstdZlib();
  const compressed = new Promise<Buffer>((resolve, reject) => {
    native.zstdCompress(
      input,
      {
        params: { [native.constants.ZSTD_c_compressionLevel]: level, [native.constants.ZSTD_c_checksumFlag]: 1 },
        pledgedSrcSize: input.length,
        chunkSize: COMPRESS_CHUNK_BYTES,
      },
      (error, result) => (error ? reject(new ConversionFailedError(`Zstandard compression failed: ${error.message}`)) : resolve(result))
    );
  });
  return raceAbort(compressed, options.signal);
}

function skippableFrameEnd(src: Buffer, offset: number): number {
  if (offset + SKIPPABLE_HEADER_BYTES > src.length) {
    throw new ConversionFailedError('Malformed skippable frame: header truncated.');
  }
  const end = offset + SKIPPABLE_HEADER_BYTES + src.readUInt32LE(offset + MAGIC_BYTES);
  if (end > src.length) throw new ConversionFailedError('Malformed skippable frame: payload truncated.');
  return end;
}

/** Offset just past the blocks (and the content checksum, if the frame has one) of the frame whose header ends at `offset`. */
function dataFrameEnd(src: Buffer, header: ZstdFrameHeader, headerEnd: number): number {
  let offset = headerEnd;
  let isLast = false;
  while (!isLast) {
    if (offset + BLOCK_HEADER_BYTES > src.length) {
      throw new ConversionFailedError('Malformed Zstandard frame: truncated block header.');
    }
    const value = src[offset] | (src[offset + 1] << BYTE_BITS) | (src[offset + 2] << THIRD_BYTE_SHIFT);
    offset += BLOCK_HEADER_BYTES;
    isLast = (value & BLOCK_LAST_BIT) === 1;
    const blockType = (value >> BLOCK_TYPE_SHIFT) & BLOCK_TYPE_MASK;
    const blockSize = value >>> BLOCK_SIZE_SHIFT;
    if (blockType === BLOCK_TYPE_RESERVED) {
      throw new ConversionFailedError('Malformed Zstandard block: reserved block type 3 encountered.');
    }
    if (blockSize > ZSTD_BLOCK_SIZE_MAX) {
      throw new ConversionFailedError('Malformed Zstandard block: size exceeds the block maximum.');
    }
    const payloadBytes = blockType === BLOCK_TYPE_RLE ? RLE_BLOCK_PAYLOAD_BYTES : blockSize;
    if (offset + payloadBytes > src.length) {
      throw new ConversionFailedError(`Malformed Zstandard ${blockTypeName(blockType)} block: truncated data.`);
    }
    offset += payloadBytes;
  }
  if (!header.contentChecksumFlag) return offset;
  if (offset + CONTENT_CHECKSUM_BYTES > src.length) {
    throw new ConversionFailedError('Malformed Zstandard frame: missing content checksum.');
  }
  return offset + CONTENT_CHECKSUM_BYTES;
}

function blockTypeName(blockType: number): string {
  if (blockType === BLOCK_TYPE_RAW) return 'raw';
  if (blockType === BLOCK_TYPE_RLE) return 'RLE';
  return blockType === BLOCK_TYPE_COMPRESSED ? 'compressed' : 'reserved';
}

/** The frames of a stream in order, skippable frames left out; throws what the pure decoder throws for a stream it cannot walk. */
function scanFrames(src: Buffer): FrameSpan[] {
  if (src.length < MAGIC_BYTES) {
    throw new ConversionFailedError('Decompress error: input buffer too small for Zstandard stream.');
  }
  const frames: FrameSpan[] = [];
  let offset = 0;
  while (offset < src.length) {
    if (offset + MAGIC_BYTES > src.length) {
      throw new ConversionFailedError('Malformed Zstandard stream: trailing bytes after the last frame.');
    }
    const magic = src.readUInt32LE(offset);
    if (magic >= SKIPPABLE_FRAME_MAGIC_MIN && magic <= SKIPPABLE_FRAME_MAGIC_MAX) {
      offset = skippableFrameEnd(src, offset);
      continue;
    }
    if (magic !== ZSTD_FRAME_MAGIC) {
      throw new ConversionFailedError(`Invalid Zstandard magic signature: 0x${magic.toString(16).toUpperCase()} at offset ${offset}`);
    }
    const header = parseZstdFrameHeader(src, offset);
    if (header.windowSize > ZSTD_DECODER_WINDOW_SIZE_MAX) {
      throw new ConversionFailedError(
        `Zstandard frame window size ${header.windowSize} exceeds the decoder limit of ${ZSTD_DECODER_WINDOW_SIZE_MAX} bytes.`
      );
    }
    if (header.dictionaryId !== 0) {
      throw new ConversionFailedError(`Zstandard frame requires dictionary ${header.dictionaryId}; use the dictionary decoder.`);
    }
    const end = dataFrameEnd(src, header, offset + header.headerSize);
    frames.push({ start: offset, end, declaredSize: header.frameContentSize });
    offset = end;
  }
  return frames;
}

/** How much one stream may unpack to, and which cap that is: the byte cap, or the ratio cap when it is the smaller. */
interface OutputBound {
  bytes: number;
  limitedByRatio: boolean;
}

function outputBoundFor(compressedBytes: number): OutputBound {
  const byRatio = Math.max(ARCHIVE_RATIO_FLOOR_BYTES, Math.floor(compressedBytes * ZSTD_SECURITY_LIMITS.MAX_RATIO));
  const limitedByRatio = byRatio < ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE;
  return { bytes: limitedByRatio ? byRatio : ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE, limitedByRatio };
}

function bombError(bound: OutputBound): DecompressionLimitError {
  if (bound.limitedByRatio) {
    return new DecompressionLimitError(`Archive bomb detected: compression ratio exceeds ${ZSTD_SECURITY_LIMITS.MAX_RATIO}:1 limit`);
  }
  return new DecompressionLimitError(`Archive bomb detected: uncompressed size exceeds limit of ${ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes`);
}

function decodeFailure(error: unknown, bound: OutputBound): Error {
  if ((error as NodeJS.ErrnoException).code === BUFFER_TOO_LARGE_CODE) return bombError(bound);
  return new ConversionFailedError(`Malformed Zstandard frame: ${error instanceof Error ? error.message : String(error)}`);
}

/** Output chunk for a frame: its declared size when it has one (already held against the caps), within sane bounds. */
function decodeChunkBytes(declaredSize: number | null): number {
  if (declaredSize === null) return DECODE_CHUNK_UNDECLARED_BYTES;
  return Math.min(Math.max(declaredSize, DECODE_CHUNK_MIN_BYTES), DECODE_CHUNK_MAX_BYTES);
}

/** One complete frame through libzstd, its output bounded by `maxOutputLength`. */
function decodeFrame(frame: Buffer, span: FrameSpan, maxOutputLength: number, bound: OutputBound): Promise<Buffer> {
  const native = nativeZstdZlib();
  const options: DecodeOptions = {
    maxOutputLength: Math.max(1, maxOutputLength),
    params: { [native.constants.ZSTD_d_windowLogMax]: DECODER_WINDOW_LOG_MAX },
    chunkSize: decodeChunkBytes(span.declaredSize),
  };
  if (span.declaredSize !== null && span.declaredSize <= SYNC_DECODE_MAX_DECLARED_BYTES) {
    try {
      return Promise.resolve(native.zstdDecompressSync(frame, options));
    } catch (error) {
      return Promise.reject(decodeFailure(error, bound));
    }
  }
  return new Promise<Buffer>((resolve, reject) => {
    native.zstdDecompress(frame, options, (error, result) => (error ? reject(decodeFailure(error, bound)) : resolve(result)));
  });
}

/** Refuses a declared size that the caps would refuse anyway, before libzstd reserves memory for it. */
function assertDeclaredSizeWithinBound(produced: number, declared: number, bound: OutputBound): void {
  const total = produced + declared;
  if (total > ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) throw bombError({ bytes: bound.bytes, limitedByRatio: false });
  if (total > bound.bytes) throw bombError(bound);
}

/**
 * Decompresses a Zstandard stream of any number of frames (skippable frames are skipped) with the archive bomb guards of
 * the pure decoder: 500 MB in all, and at most 100 times the compressed size once past the 32 MiB floor. Every failure is a
 * ConversionFailedError; there is no second decoder behind it.
 */
export async function decompressZstdNative(input: Buffer, options: ZstdNativeOptions = {}): Promise<Buffer> {
  const frames = scanFrames(input);
  const bound = outputBoundFor(input.length);
  const outputs: Buffer[] = [];
  let produced = 0;
  for (const span of frames) {
    throwIfAborted(options.signal);
    if (span.declaredSize !== null) assertDeclaredSizeWithinBound(produced, span.declaredSize, bound);
    const decoded = await raceAbort(decodeFrame(input.subarray(span.start, span.end), span, bound.bytes - produced, bound), options.signal);
    if (span.declaredSize !== null && decoded.length !== span.declaredSize) {
      throw new ConversionFailedError(`Zstandard frame content size mismatch: header declares ${span.declaredSize}, decoded ${decoded.length}.`);
    }
    produced += decoded.length;
    if (produced > bound.bytes) throw bombError(bound);
    outputs.push(decoded);
  }
  return outputs.length === 1 ? outputs[0] : Buffer.concat(outputs, produced);
}
