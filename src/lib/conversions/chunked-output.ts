import { DataLimitExceededError } from '../types';

/** Largest output a direct route builds: the offset range of one buffer, as for the input of the byte scanners. */
export const MAX_CHUNKED_OUTPUT_BYTES = 0x7f_ff_ff_f0;
const CHUNK_BYTES = 4 * 1024 * 1024;
const MIN_FIRST_CHUNK_BYTES = 64 * 1024;

export interface ChunkedOutputOptions {
  /** Size of the output when it is known roughly: the first chunk is sized by it, so a small table is one chunk. */
  expectedBytes?: number;
  chunkBytes?: number;
  maxBytes?: number;
}

/**
 * Output of a direct table route, collected in chunks of a few MiB instead of one string or one buffer sized in
 * advance: the table can be written while it is read, and the JavaScript heap holds none of it. {@link toBuffer}
 * joins the chunks once at the end.
 */
export class ChunkedOutput {
  private readonly chunkBytes: number;
  private readonly maxBytes: number;
  private readonly sealed: Buffer[] = [];
  private current: Buffer;
  private used = 0;
  private sealedBytes = 0;

  constructor({ expectedBytes = CHUNK_BYTES, chunkBytes = CHUNK_BYTES, maxBytes = MAX_CHUNKED_OUTPUT_BYTES }: ChunkedOutputOptions = {}) {
    this.chunkBytes = chunkBytes;
    this.maxBytes = maxBytes;
    this.current = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(MIN_FIRST_CHUNK_BYTES, expectedBytes)));
  }

  get length(): number {
    return this.sealedBytes + this.used;
  }

  /** Appends a string whose every UTF-16 unit is one byte (code points up to U+00FF). */
  writeLatin1(text: string): void {
    this.reserve(text.length);
    this.used += this.current.write(text, this.used, text.length, 'latin1');
  }

  /** Appends a string as UTF-8. */
  writeUtf8(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    this.reserve(bytes);
    this.used += this.current.write(text, this.used, bytes, 'utf8');
  }

  /** The bytes written so far, as one buffer. */
  toBuffer(): Buffer {
    this.seal();
    return this.sealed.length === 1 ? this.sealed[0] : Buffer.concat(this.sealed, this.sealedBytes);
  }

  private reserve(bytes: number): void {
    if (this.length + bytes > this.maxBytes) {
      throw new DataLimitExceededError(`The converted table exceeds ${this.maxBytes} bytes.`);
    }
    if (bytes <= this.current.length - this.used) return;
    // Chunks double in size up to the full chunk size, so a small table is a few small buffers, not one of 4 MiB.
    const next = Math.min(this.chunkBytes, this.current.length * 2);
    this.seal();
    this.current = Buffer.allocUnsafe(Math.max(next, bytes, MIN_FIRST_CHUNK_BYTES));
  }

  private seal(): void {
    if (this.used === 0 && this.sealed.length > 0) return;
    this.sealed.push(this.current.subarray(0, this.used));
    this.sealedBytes += this.used;
    this.current = Buffer.alloc(0);
    this.used = 0;
  }
}
