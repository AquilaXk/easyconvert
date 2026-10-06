import zlib from 'node:zlib';
import { CorruptStreamError, DecompressionLimitError } from '../types';

/**
 * Bounded zlib/deflate decoding shared by the PDF, HWP and WOFF readers. Every inflate of
 * attacker-controlled data goes through `inflateBounded`, so no stream can expand past the
 * per-stream cap and no document can expand past its decoded-byte budget.
 */

/** Most bytes a single compressed stream may decode to (64 MiB). */
export const MAX_STREAM_INFLATE_BYTES = 64 * 1024 * 1024;
/** Most bytes all compressed streams of one document may decode to together (256 MiB). */
export const MAX_DOCUMENT_INFLATE_BYTES = 256 * 1024 * 1024;

const ERR_BUFFER_TOO_LARGE = 'ERR_BUFFER_TOO_LARGE';

/** Running total of decoded bytes for one document, shared by every stream decoded from it. */
export class InflateBudget {
  private used = 0;

  constructor(readonly limit: number = MAX_DOCUMENT_INFLATE_BYTES) {}

  get remaining(): number {
    return this.limit - this.used;
  }

  /** Counts `bytes` against the budget, throwing when they do not fit. */
  charge(bytes: number, label: string): void {
    if (bytes > this.remaining) {
      throw new DecompressionLimitError(
        `${label} would exceed the decoded-byte budget of ${this.limit} bytes for the whole document.`
      );
    }
    this.used += bytes;
  }
}

export interface InflateOptions {
  /** What is being decoded, for error messages (for example "PDF stream 7" or "WOFF table 'glyf'"). */
  label: string;
  /** `zlib` for RFC 1950 streams, `raw` for bare RFC 1951 deflate. */
  format: 'zlib' | 'raw';
  /** Tighter cap than the per-stream constant, for formats whose decoded size is bounded but not declared. */
  maxOutputLength?: number;
  /**
   * Decoded size the container declares (WOFF origLength). It is the cap, and any other output size
   * is a CorruptStreamError, since the declaration then lies about the stream.
   */
  expectedLength?: number;
  /** Document budget the decoded bytes are charged to. */
  budget?: InflateBudget;
}

function isTooLarge(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === ERR_BUFFER_TOO_LARGE;
}

/**
 * Inflates `data`, never producing more than the cap. Output past the cap throws a
 * DecompressionLimitError (HTTP 413); data that is not a valid stream throws a CorruptStreamError (HTTP 400).
 */
export function inflateBounded(data: Buffer, options: InflateOptions): Buffer {
  const declared = options.expectedLength;
  if (declared !== undefined && declared > MAX_STREAM_INFLATE_BYTES) {
    throw new DecompressionLimitError(
      `${options.label} declares ${declared} decoded bytes, more than the limit of ${MAX_STREAM_INFLATE_BYTES} bytes.`
    );
  }
  const streamCap = Math.min(declared ?? options.maxOutputLength ?? MAX_STREAM_INFLATE_BYTES, MAX_STREAM_INFLATE_BYTES);
  const budgetRemaining = options.budget ? options.budget.remaining : Number.POSITIVE_INFINITY;
  const cap = Math.min(streamCap, budgetRemaining);

  if (streamCap < 1) {
    throw new CorruptStreamError(`${options.label} declares an empty decoded size but carries compressed data.`);
  }
  if (cap < 1) {
    throw new DecompressionLimitError(
      `${options.label} would exceed the decoded-byte budget of ${options.budget?.limit} bytes for the whole document.`
    );
  }

  let output: Buffer;
  try {
    output =
      options.format === 'raw'
        ? zlib.inflateRawSync(data, { maxOutputLength: cap })
        : zlib.inflateSync(data, { maxOutputLength: cap });
  } catch (err) {
    if (isTooLarge(err) && declared !== undefined && budgetRemaining >= declared) {
      throw new CorruptStreamError(`${options.label} decodes to more than the ${declared} bytes it declares.`);
    }
    if (isTooLarge(err)) {
      const budgetBound = budgetRemaining < streamCap;
      throw new DecompressionLimitError(
        budgetBound
          ? `${options.label} would exceed the decoded-byte budget of ${options.budget?.limit} bytes for the whole document.`
          : `${options.label} decodes to more than the limit of ${streamCap} bytes.`
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new CorruptStreamError(`${options.label} is not a valid compressed stream: ${reason}`);
  }

  if (declared !== undefined && output.length !== declared) {
    throw new CorruptStreamError(`${options.label} decodes to ${output.length} bytes but declares ${declared}.`);
  }
  options.budget?.charge(output.length, options.label);
  return output;
}
