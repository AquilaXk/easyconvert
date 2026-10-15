import { EdgeUnsupportedError } from './workers/worker-errors';

/**
 * What a browser canvas can honestly encode, and a check that the bytes it returned are the format asked for.
 *
 * `canvas.toBlob(type)` is a request, not a promise: a type the browser does not encode comes back as a PNG
 * (WebP on Safari, every other type everywhere), and a canvas that is too large or lost its context yields an
 * empty blob. Delivering either under the target's name would be a substitute result, so each is refused with an
 * EdgeUnsupportedError, which the tier router answers by running the server tier on the original file.
 */

/** Targets a canvas encodes, with the media type that is asked for (HTML Living Standard, canvas toBlob). */
const CANVAS_TARGET_MIME = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
]);

/** Bytes needed to tell the formats below apart: RIFF (4) + size (4) + WEBP (4) is the longest signature. */
const SIGNATURE_BYTES = 12;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const BMP_SIGNATURE = [0x42, 0x4d];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];
const RIFF_SIZE_BYTES = 4;
export const BMP_MIME_TYPE = 'image/bmp';

/** The media type to ask a canvas for when producing `target`; throws EdgeUnsupportedError when it cannot. */
export function canvasMimeType(target: string): string {
  const mime = CANVAS_TARGET_MIME.get(target.toLowerCase());
  if (!mime) {
    throw new EdgeUnsupportedError(`A browser canvas cannot encode .${target}; the server converts it.`);
  }
  return mime;
}

function startsWith(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

/** The format whose file signature `bytes` start with: `png`, `jpeg`, `webp` or `bmp`; null for anything else. */
export function detectEncodedFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'bmp' | null {
  if (startsWith(bytes, 0, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, 0, JPEG_SIGNATURE)) return 'jpeg';
  if (startsWith(bytes, 0, RIFF_SIGNATURE) && startsWith(bytes, RIFF_SIGNATURE.length + RIFF_SIZE_BYTES, WEBP_TAG)) return 'webp';
  if (startsWith(bytes, 0, BMP_SIGNATURE)) return 'bmp';
  return null;
}

const TARGET_FORMAT: ReadonlyMap<string, 'png' | 'jpeg' | 'webp' | 'bmp'> = new Map([
  ['png', 'png'],
  ['jpg', 'jpeg'],
  ['jpeg', 'jpeg'],
  ['webp', 'webp'],
  ['bmp', 'bmp'],
]);

function signatureMatches(bytes: Uint8Array, target: string): boolean {
  const expected = TARGET_FORMAT.get(target.toLowerCase());
  return expected !== undefined && detectEncodedFormat(bytes) === expected;
}

/**
 * Throws EdgeUnsupportedError unless `bytes` start with the file signature of `target` (PNG, JPEG, WebP or BMP).
 * An empty array, a different format and a target without a known signature are all refused.
 */
export function assertEncodedSignature(bytes: Uint8Array, target: string): void {
  if (bytes.length === 0) {
    throw new EdgeUnsupportedError(`The browser produced no image data for .${target}; the server converts it.`);
  }
  if (!signatureMatches(bytes, target)) {
    throw new EdgeUnsupportedError(
      `The browser produced an image that is not a .${target} file (signature ${Array.from(bytes.subarray(0, 4), (byte) => byte.toString(16).padStart(2, '0')).join('')}); the server converts it.`
    );
  }
}

/** Reads the head of `blob` and applies assertEncodedSignature; also refuses a blob typed as another format. */
export async function assertEncodedBlob(blob: Blob, target: string): Promise<void> {
  const expectedMime = target.toLowerCase() === 'bmp' ? BMP_MIME_TYPE : canvasMimeType(target);
  if (blob.type !== '' && blob.type !== expectedMime) {
    throw new EdgeUnsupportedError(`The browser returned ${blob.type} where ${expectedMime} was requested; the server converts it.`);
  }
  assertEncodedSignature(new Uint8Array(await blob.slice(0, SIGNATURE_BYTES).arrayBuffer()), target);
}
