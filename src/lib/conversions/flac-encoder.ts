/**
 * FLAC encoder input contract (RFC 9639).
 *
 * Everything the encoder accepts is bounded here with named limits; anything else is
 * rejected with a FlacInputError (a ConversionFailedError, so the API answers HTTP 400).
 */

import { ConversionFailedError } from '../types';

/** Channel counts the subframe writer implements: mono and stereo. */
export const FLAC_SUPPORTED_CHANNELS: ReadonlySet<number> = new Set([1, 2]);
/** Sample sizes with a frame header code (RFC 9639 section 9.1.4) that the encoder implements. */
export const FLAC_SUPPORTED_BITS_PER_SAMPLE: ReadonlySet<number> = new Set([16]);
export const FLAC_DEFAULT_BITS_PER_SAMPLE = 16;
/** STREAMINFO stores the sample rate in 20 bits and forbids 0 (RFC 9639 section 8.2). */
export const FLAC_MAX_SAMPLE_RATE = (1 << 20) - 1;
export const FLAC_MIN_SAMPLE_RATE = 1;

export class FlacInputError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'FlacInputError';
  }
}

export interface FlacEncodeOptions {
  /** Bits per sample of the values in the input array; defaults to 16. */
  bitsPerSample?: number;
}

/**
 * Validates the encoder inputs and returns the number of sample frames (samples per channel).
 */
export function validateFlacInput(
  samples: Int16Array | Int32Array,
  sampleRate: number,
  channels: number,
  bitsPerSample: number
): number {
  if (!(samples instanceof Int16Array) && !(samples instanceof Int32Array)) {
    throw new FlacInputError('FLAC encoder input must be an Int16Array or Int32Array of PCM samples.');
  }
  if (!Number.isInteger(channels) || !FLAC_SUPPORTED_CHANNELS.has(channels)) {
    throw new FlacInputError(
      `FLAC encoder supports only mono and stereo input, received ${channels} channels (Fail-Closed).`
    );
  }
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < FLAC_MIN_SAMPLE_RATE ||
    sampleRate > FLAC_MAX_SAMPLE_RATE
  ) {
    throw new FlacInputError(
      `FLAC sample rate must be an integer from ${FLAC_MIN_SAMPLE_RATE} to ${FLAC_MAX_SAMPLE_RATE} Hz, received ${sampleRate}.`
    );
  }
  if (!FLAC_SUPPORTED_BITS_PER_SAMPLE.has(bitsPerSample)) {
    throw new FlacInputError(
      `FLAC encoder does not support ${bitsPerSample} bits per sample (supported: ${[...FLAC_SUPPORTED_BITS_PER_SAMPLE].join(', ')}).`
    );
  }
  if (samples.length % channels !== 0) {
    throw new FlacInputError(
      `FLAC input holds ${samples.length} samples, which is not a whole number of ${channels}-channel frames.`
    );
  }
  return samples.length / channels;
}
