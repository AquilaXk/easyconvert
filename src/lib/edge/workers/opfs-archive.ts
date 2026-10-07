/**
 * OPFS archive streams: tar to gzip, and gzip to tar.
 *
 * The gzip framing (RFC 1952: header, deflate data, CRC-32 and ISIZE trailer) is written and checked by the
 * platform's CompressionStream and DecompressionStream, so a tar that goes in comes out as a real `.tar.gz`
 * and a `.gz` is inflated, never copied. The tar side is a streaming reader of the POSIX ustar layout
 * (IEEE 1003.1): every 512-byte header must carry the `ustar` magic and a valid checksum, entry bodies are
 * skipped by their stated size, and the archive must end with two zero blocks. A tar that is cut short, has a
 * damaged header, or trails data after its end marker is a CorruptStreamError; bytes that are not a ustar
 * archive at all are an EdgeUnsupportedError, so the server engine decides what to do with them.
 */

import { ConversionFailedError, CorruptStreamError, DecompressionLimitError } from '../../types';
import { OPFS_MAX_FILE_BYTES } from '../opfs/limits';
import { type ChunkTransformerFn, isLastChunk } from './chunk-transformer';
import { EdgeUnsupportedError } from './worker-errors';

/**
 * Most bytes one gzip input may inflate to: the largest file the edge accepts at all. A bigger stream is refused
 * as a decompression bomb, so a small file cannot fill the user's disk.
 */
export const OPFS_MAX_DECOMPRESSED_BYTES = OPFS_MAX_FILE_BYTES;
/** Input bytes handed to the gzip stream at a time, which bounds how much one write can expand into. */
const GZIP_FEED_SLICE_BYTES = 64 * 1024;
/** Output the pump keeps queued before it stops reading, so a slow writer applies backpressure. */
const PUMP_QUEUE_LIMIT_BYTES = 1024 * 1024;

const TAR_BLOCK_BYTES = 512;
const TAR_SIZE_START = 124;
const TAR_SIZE_END = 136;
const TAR_CHECKSUM_START = 148;
const TAR_CHECKSUM_END = 156;
const TAR_TYPEFLAG_AT = 156;
const TAR_MAGIC_START = 257;
const TAR_MAGIC = 'ustar';
const ASCII_SPACE = 0x20;
const ASCII_ZERO = 0x30;
const ASCII_SEVEN = 0x37;
const OCTAL_RADIX = 8;
const BYTE_RADIX = 256;
const BASE256_MARKER = 0x80;
const BASE256_VALUE_MASK = 0x7f;
const END_MARKER_BLOCKS = 2;
/** Entry types that carry no body even when the size field is not zero (hard link, symlink, devices, directory, FIFO). */
const TAR_HEADER_ONLY_TYPES: ReadonlySet<string> = new Set(['1', '2', '3', '4', '5', '6']);

function corrupt(message: string): CorruptStreamError {
  return new CorruptStreamError(`The tar archive is damaged: ${message}.`);
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.byteLength; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/** Reads an octal numeric field of a ustar header (digits, padded with spaces or NULs). */
function readOctal(block: Uint8Array, start: number, end: number, what: string): number {
  let value = 0;
  let digits = 0;
  for (let i = start; i < end; i++) {
    const byte = block[i];
    if (byte === 0 || byte === ASCII_SPACE) {
      if (digits > 0) break;
      continue;
    }
    if (byte < ASCII_ZERO || byte > ASCII_SEVEN) throw corrupt(`the ${what} field is not an octal number`);
    value = value * OCTAL_RADIX + (byte - ASCII_ZERO);
    digits++;
  }
  return value;
}

/** Reads the entry size: octal, or the base-256 form (high bit of the first byte set) of the pax and GNU writers. */
function readEntrySize(block: Uint8Array): number {
  if ((block[TAR_SIZE_START] & BASE256_MARKER) === 0) return readOctal(block, TAR_SIZE_START, TAR_SIZE_END, 'size');
  let value = block[TAR_SIZE_START] & BASE256_VALUE_MASK;
  for (let i = TAR_SIZE_START + 1; i < TAR_SIZE_END; i++) {
    value = value * BYTE_RADIX + block[i];
    if (value > Number.MAX_SAFE_INTEGER) throw corrupt('an entry size is larger than any file');
  }
  return value;
}

/** Whether the header checksum matches the sum of its bytes taken with the checksum field as spaces (unsigned or signed). */
function hasValidChecksum(block: Uint8Array): boolean {
  const stored = readOctal(block, TAR_CHECKSUM_START, TAR_CHECKSUM_END, 'checksum');
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < TAR_BLOCK_BYTES; i++) {
    const byte = i >= TAR_CHECKSUM_START && i < TAR_CHECKSUM_END ? ASCII_SPACE : block[i];
    unsigned += byte;
    signed += byte > 0x7f ? byte - BYTE_RADIX : byte;
  }
  return stored === unsigned || stored === signed;
}

/** Walks a tar byte stream block by block and throws as soon as it stops being a well-formed ustar archive. */
export class TarStreamValidator {
  private readonly header = new Uint8Array(TAR_BLOCK_BYTES);
  private headerFill = 0;
  private bodyRemaining = 0;
  private zeroBlocks = 0;
  private entries = 0;

  feed(bytes: Uint8Array): void {
    let at = 0;
    while (at < bytes.byteLength) {
      if (this.bodyRemaining > 0) {
        const skipped = Math.min(this.bodyRemaining, bytes.byteLength - at);
        this.bodyRemaining -= skipped;
        at += skipped;
        continue;
      }
      if (this.zeroBlocks >= END_MARKER_BLOCKS) {
        // Past the end marker only the zero padding of the last record may follow.
        for (; at < bytes.byteLength; at++) {
          if (bytes[at] !== 0) throw corrupt('data follows the end-of-archive marker');
        }
        return;
      }
      const taken = Math.min(TAR_BLOCK_BYTES - this.headerFill, bytes.byteLength - at);
      this.header.set(bytes.subarray(at, at + taken), this.headerFill);
      this.headerFill += taken;
      at += taken;
      if (this.headerFill === TAR_BLOCK_BYTES) {
        this.headerFill = 0;
        this.acceptHeader();
      }
    }
  }

  /** Checks that the stream ended on an archive boundary, after the end marker. */
  finish(): void {
    if (this.bodyRemaining > 0 || this.headerFill > 0) throw corrupt('the archive ends inside an entry');
    if (this.zeroBlocks < END_MARKER_BLOCKS) throw corrupt('the end-of-archive marker is missing');
  }

  private acceptHeader(): void {
    if (isZeroBlock(this.header)) {
      this.zeroBlocks++;
      return;
    }
    if (this.zeroBlocks > 0) throw corrupt('a lone zero block is followed by another entry');
    const magic = String.fromCharCode(...this.header.subarray(TAR_MAGIC_START, TAR_MAGIC_START + TAR_MAGIC.length));
    if (magic !== TAR_MAGIC) {
      if (this.entries === 0) {
        throw new EdgeUnsupportedError('The data is not a POSIX ustar tar archive; the server engine converts it.');
      }
      throw corrupt(`entry ${this.entries + 1} has no ustar magic`);
    }
    if (!hasValidChecksum(this.header)) throw corrupt(`entry ${this.entries + 1} has a wrong header checksum`);
    const typeflag = String.fromCharCode(this.header[TAR_TYPEFLAG_AT]);
    const size = TAR_HEADER_ONLY_TYPES.has(typeflag) ? 0 : readEntrySize(this.header);
    this.bodyRemaining = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    this.entries++;
  }
}

interface GzipStreamPair {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/**
 * Drives a CompressionStream or DecompressionStream from sequential calls while a background reader drains its
 * output into a bounded queue. Output reaches the caller as it appears, so a window that inflates to far more
 * than its own size is written piece by piece instead of being held whole.
 */
class GzipStreamPump {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private readerFinished = false;
  private readerFailed = false;
  private readerError: unknown;
  private wake: (() => void) | null = null;
  private resumeReader: (() => void) | null = null;

  constructor(pair: GzipStreamPair) {
    this.writer = pair.writable.getWriter();
    this.reader = pair.readable.getReader();
    // A failure is delivered through write()/close()/the reader loop; these only keep the signals handled.
    this.writer.closed.catch(() => undefined);
    this.reader.closed.catch(() => undefined);
    void this.readOutput();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private async readOutput(): Promise<void> {
    try {
      for (;;) {
        while (this.queuedBytes >= PUMP_QUEUE_LIMIT_BYTES) {
          await new Promise<void>((resume) => {
            this.resumeReader = resume;
          });
        }
        const { done, value } = await this.reader.read();
        if (done) break;
        if (value.byteLength > 0) {
          this.queue.push(value);
          this.queuedBytes += value.byteLength;
        }
        this.notify();
      }
    } catch (error) {
      this.readerFailed = true;
      this.readerError = error;
    }
    this.readerFinished = true;
    this.notify();
  }

  private async *drain(operation: Promise<void>, untilOutputEnds: boolean): AsyncGenerator<Uint8Array> {
    let operationDone = false;
    let operationFailed = false;
    let operationError: unknown;
    operation.then(
      () => {
        operationDone = true;
        this.notify();
      },
      (error: unknown) => {
        operationDone = true;
        operationFailed = true;
        operationError = error;
        this.notify();
      }
    );
    for (;;) {
      while (this.queue.length > 0) {
        const piece = this.queue.shift() as Uint8Array;
        this.queuedBytes -= piece.byteLength;
        const resume = this.resumeReader;
        this.resumeReader = null;
        resume?.();
        yield piece;
      }
      if (this.readerFailed) throw this.readerError;
      if (operationFailed) throw operationError;
      if (operationDone && (!untilOutputEnds || this.readerFinished)) return;
      await new Promise<void>((resume) => {
        this.wake = resume;
      });
    }
  }

  /** Feeds `data` to the stream and yields the output that appears while it is processed. */
  async *write(data: Uint8Array): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < data.byteLength; at += GZIP_FEED_SLICE_BYTES) {
      yield* this.drain(this.writer.write(data.subarray(at, at + GZIP_FEED_SLICE_BYTES)), false);
    }
  }

  /** Ends the input and yields every remaining output byte, including the gzip trailer. */
  async *close(): AsyncGenerator<Uint8Array> {
    yield* this.drain(this.writer.close(), true);
  }

  /** Releases the stream after a failure so nothing keeps waiting on it. */
  abandon(): void {
    this.writer.abort().catch(() => undefined);
    this.reader.cancel().catch(() => undefined);
    const resume = this.resumeReader;
    this.resumeReader = null;
    resume?.();
  }
}

function requireGzipStreams(): void {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
    throw new EdgeUnsupportedError('This browser has no gzip streams; the server engine converts the archive.');
  }
}

function asCorruptGzip(error: unknown): Error {
  if (error instanceof ConversionFailedError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new CorruptStreamError(`The gzip stream is damaged: ${detail}.`);
}

/** tar to gzip: checks the tar as it streams past and writes it as one gzip member. */
export function createTarGzipTransformer(): ChunkTransformerFn {
  requireGzipStreams();
  const pump = new GzipStreamPump(new CompressionStream('gzip') as unknown as GzipStreamPair);
  const validator = new TarStreamValidator();
  return async function* (chunk, offset, totalSize) {
    try {
      validator.feed(chunk);
      yield* pump.write(chunk);
      if (isLastChunk(offset, chunk.byteLength, totalSize)) {
        validator.finish();
        yield* pump.close();
      }
    } catch (error) {
      pump.abandon();
      throw error;
    }
  };
}

/** gzip to tar: inflates the stream and checks that what comes out is a complete ustar archive. */
export function createGunzipTarTransformer(maxOutputBytes: number = OPFS_MAX_DECOMPRESSED_BYTES): ChunkTransformerFn {
  requireGzipStreams();
  const pump = new GzipStreamPump(new DecompressionStream('gzip') as unknown as GzipStreamPair);
  const validator = new TarStreamValidator();
  let produced = 0;

  async function* checked(pieces: AsyncGenerator<Uint8Array>): AsyncGenerator<Uint8Array> {
    for await (const piece of pieces) {
      produced += piece.byteLength;
      if (produced > maxOutputBytes) {
        throw new DecompressionLimitError(`The gzip stream inflates past ${maxOutputBytes} bytes (decompression limit).`);
      }
      validator.feed(piece);
      yield piece;
    }
  }

  return async function* (chunk, offset, totalSize) {
    try {
      yield* checked(pump.write(chunk));
      if (isLastChunk(offset, chunk.byteLength, totalSize)) {
        yield* checked(pump.close());
        validator.finish();
      }
    } catch (error) {
      pump.abandon();
      throw asCorruptGzip(error);
    }
  };
}
