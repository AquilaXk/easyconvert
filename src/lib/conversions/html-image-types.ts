/**
 * What the fetcher child process and the session that drives it share: the limits, the refusal error, the image types
 * a signature can name. Nothing here touches the network.
 */

export interface ImageFetchLimits {
  /** Largest single image, in bytes. */
  maxImageBytes: number;
  /** Largest sum of all fetched images of one session, in bytes. */
  maxTotalBytes: number;
  /** Most fetches (successful or not) of one session. */
  maxImages: number;
  /** Longest one fetch, redirects included, in milliseconds. */
  perFetchMs: number;
  /** Longest all fetches of a session together, in milliseconds. */
  totalMs: number;
  /** Most redirects followed for one image. */
  maxRedirects: number;
}

const MEBIBYTE = 1024 * 1024;

export const IMAGE_FETCH_LIMITS: Readonly<ImageFetchLimits> = {
  maxImageBytes: 10 * MEBIBYTE,
  maxTotalBytes: 50 * MEBIBYTE,
  maxImages: 100,
  perFetchMs: 10_000,
  totalMs: 30_000,
  maxRedirects: 3,
};

/** A fetch that was refused or failed; the message is the reason a warning or a 400 reports. */
export class ImageFetchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageFetchRefusal';
  }
}

export type FetchedImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface FetchedImage {
  bytes: Buffer;
  /** The type of the signature the bytes start with, never the one the server declared. */
  mime: FetchedImageType;
}

export const SUPPORTED_TYPES_TEXT = 'PNG, JPEG, GIF or WebP';

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

/** The image type a byte sequence starts as, or null. */
export function sniffImageType(bytes: Buffer): FetchedImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const head = bytes.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Test-only rules that can cross the process boundary: fixed name-server answers and extra permitted addresses. */
export interface ImageFetchTestRules {
  /** Host name to the addresses a name server would answer; a host that is not listed does not resolve. */
  hosts?: Record<string, string[]>;
  /** Addresses permitted although they are not public. */
  permitAddresses?: string[];
  /** Any port instead of 80 and 443. */
  anyPort?: boolean;
}

/** What the session sends the fetcher child on stdin. */
export interface ImageFetchRequest {
  url: string;
  maxBytes: number;
  tooLargeReason: string;
  timeoutMs: number;
  maxRedirects: number;
  testRules?: ImageFetchTestRules;
}

/** First line of what the child writes to stdout; on success the image bytes follow it. */
export type ImageFetchReply = { ok: true; mime: FetchedImageType } | { ok: false; reason: string };
