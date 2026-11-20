import type { ConversionRefusalCode } from '../refusal-codes';
import { ConversionFailedError } from '../types';

/** The first bytes of an HWP 3.x file (Hangul Word Processor 97 and earlier), which is no compound file. */
export const HWP3_SIGNATURE = 'HWP Document File V3';

/**
 * An HWP document of the 3.x generation: the in-process reader reads HWP 5.0 only and the office suite is the one that imports the older format.
 * The file is understood but cannot be read here, so the routes answer HTTP 422 (through `status`); another worker with the suite would read it,
 * so this is not an `EngineMissingError`.
 */
export class UnsupportedHwpVersionError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'unsupported_input';
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedHwpVersionError';
  }
}

/** Refuses an HWP 3.x file in words, where a reader that reads HWP 5.0 only is handed one. */
export function assertNotHwp3(input: Buffer): void {
  if (input.toString('latin1', 0, HWP3_SIGNATURE.length) === HWP3_SIGNATURE) {
    throw new UnsupportedHwpVersionError('HWP 3.0 files are not supported: this reader opens HWP 5.0 documents only.');
  }
}
