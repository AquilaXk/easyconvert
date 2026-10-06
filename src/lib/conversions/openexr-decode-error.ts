import { ConversionFailedError } from '../types';

/**
 * Why an OpenEXR input was rejected.
 * - malformed: the bytes contradict the OpenEXR file layout (bad header, bad chunk, bad codec stream)
 * - truncated: the file ends before data the header or offset table promises
 * - unsupported: valid OpenEXR that this decoder does not implement (codec, deep, multipart, channel set)
 * - too-large: the image exceeds a decoder resource cap
 */
export type OpenExrErrorKind = 'malformed' | 'truncated' | 'unsupported' | 'too-large';

/** Typed OpenEXR decode failure; extends ConversionFailedError so the API answers HTTP 400. */
export class OpenExrDecodeError extends ConversionFailedError {
  readonly kind: OpenExrErrorKind;
  constructor(message: string, kind: OpenExrErrorKind = 'malformed') {
    super(message);
    this.name = 'OpenExrDecodeError';
    this.kind = kind;
  }
}
