import { ConversionFailedError } from '../types';
import { BmpDecodeError, decodeDib, type DecodedBmp } from './bmp';
import { LegacyIcnsError, decodeLegacyIcns, type LegacyIcnsPicture } from './icns-legacy';
import type { PixelBudget } from './image-input-limits';

/**
 * Icon containers: ICO and CUR (Microsoft icon directory, each entry a PNG or a headerless DIB with an AND
 * mask) and ICNS (Apple icon family, chunks of type, big-endian length and payload). Every directory entry and
 * chunk is checked against the file before it is used.
 */

/** A malformed or truncated ICO/CUR file (HTTP 400). */
export class IcoDecodeError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'IcoDecodeError';
  }
}

/** A malformed or truncated ICNS file, or one with no picture element this converter reads (HTTP 400). */
export class IcnsDecodeError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'IcnsDecodeError';
  }
}

const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const ICO_TYPE_ICON = 1;
const ICO_TYPE_CURSOR = 2;
/** A directory side of 0 stands for 256 pixels. */
const ICO_SIDE_ZERO_MEANS = 256;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const ICNS_HEADER_BYTES = 8;
const ICNS_SIGNATURE = 'icns';

interface IcoEntry {
  width: number;
  height: number;
  bitCount: number;
  size: number;
  offset: number;
  index: number;
}

export type DecodedIcon =
  | { kind: 'png'; png: Buffer }
  | { kind: 'raster'; bitmap: DecodedBmp };

/** The size the caller will resize to, if any: the smallest entry that does not need upscaling is chosen. */
export interface IconSizeRequest {
  width?: number;
  height?: number;
}

function readDirectory(buf: Buffer): IcoEntry[] {
  if (buf.length < ICO_HEADER_BYTES || buf.readUInt16LE(0) !== 0) {
    throw new IcoDecodeError('Invalid ICO file: missing the icon directory header.');
  }
  const type = buf.readUInt16LE(2);
  if (type !== ICO_TYPE_ICON && type !== ICO_TYPE_CURSOR) {
    throw new IcoDecodeError(`Invalid ICO file: the directory type ${type} is neither icon (1) nor cursor (2).`);
  }
  const count = buf.readUInt16LE(4);
  if (count === 0) throw new IcoDecodeError('Invalid ICO file: the directory has no images.');
  const directoryEnd = ICO_HEADER_BYTES + count * ICO_ENTRY_BYTES;
  if (directoryEnd > buf.length) {
    throw new IcoDecodeError(`Invalid ICO file: ${count} directory entries do not fit in ${buf.length} bytes.`);
  }
  const entries: IcoEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (size === 0 || offset < directoryEnd || offset + size > buf.length) {
      throw new IcoDecodeError(
        `Invalid ICO file: image ${index + 1} (${size} bytes at offset ${offset}) lies outside the ${buf.length}-byte file.`
      );
    }
    entries.push({
      width: buf[at] === 0 ? ICO_SIDE_ZERO_MEANS : buf[at],
      height: buf[at + 1] === 0 ? ICO_SIDE_ZERO_MEANS : buf[at + 1],
      // A cursor reuses the planes and bit count fields for its hotspot, so only icons report a depth.
      bitCount: type === ICO_TYPE_ICON ? buf.readUInt16LE(at + 6) : 0,
      size,
      offset,
      index,
    });
  }
  return entries;
}

/** The smallest entry at least as large as the request in both sides, else the largest entry. */
function chooseEntry(entries: IcoEntry[], request: IconSizeRequest | undefined): IcoEntry {
  const area = (e: IcoEntry): number => e.width * e.height;
  const largest = entries.reduce((best, e) => (area(e) > area(best) || (area(e) === area(best) && e.bitCount > best.bitCount) ? e : best), entries[0]);
  const wantedWidth = request?.width ?? 0;
  const wantedHeight = request?.height ?? 0;
  if (wantedWidth <= 0 && wantedHeight <= 0) return largest;
  const fitting = entries.filter((e) => e.width >= wantedWidth && e.height >= wantedHeight);
  if (fitting.length === 0) return largest;
  return fitting.reduce((best, e) => (area(e) < area(best) || (area(e) === area(best) && e.bitCount > best.bitCount) ? e : best), fitting[0]);
}

/**
 * Decodes the best image of an ICO or CUR file. PNG entries are returned as the PNG bytes for the image
 * library; DIB entries are decoded here to RGBA, with transparency from the 32-bit alpha or the AND mask.
 */
export function decodeIco(buf: Buffer, request?: IconSizeRequest, budget?: PixelBudget): DecodedIcon {
  const entry = chooseEntry(readDirectory(buf), request);
  const data = buf.subarray(entry.offset, entry.offset + entry.size);
  if (data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return { kind: 'png', png: data };
  try {
    return { kind: 'raster', bitmap: decodeDib(data, { icon: true }, budget) };
  } catch (err) {
    if (err instanceof BmpDecodeError) {
      throw new IcoDecodeError(`Invalid ICO file: image ${entry.index + 1} is neither PNG nor a valid DIB (${err.message}).`);
    }
    throw err;
  }
}

/** A JPEG 2000 file opens with the signature box (T.800 Annex I.5.1); Apple stores it in the elements from 128x128 up. */
const JPEG_2000_SIGNATURE = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);

/** The picture an ICNS file is read as: encoded bytes for the image library or the JPEG 2000 decoder, or decoded pixels. */
export type IcnsPicture =
  | { kind: 'encoded'; data: Buffer; jpeg2000: boolean }
  | { kind: 'raster'; width: number; height: number; rgba: Buffer };

function isEncodedIcnsPayload(chunk: Buffer): boolean {
  return (
    chunk.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    chunk.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE) ||
    chunk.subarray(0, JPEG_2000_SIGNATURE.length).equals(JPEG_2000_SIGNATURE)
  );
}

/**
 * Returns the picture of an ICNS file: the PNG, JPEG or JPEG 2000 payload of its largest chunk or, when there is none, the
 * largest old-style picture (RLE colour elements with their masks, and the ARGB elements). Every chunk length is checked
 * against the file length the header declares; a file with no picture, or an element that does not add up, is refused
 * rather than guessed at.
 */
export function decodeIcns(buf: Buffer): IcnsPicture {
  if (buf.length < ICNS_HEADER_BYTES || buf.toString('ascii', 0, 4) !== ICNS_SIGNATURE) {
    throw new IcnsDecodeError('Invalid ICNS file: missing the icns header.');
  }
  const total = buf.readUInt32BE(4);
  if (total < ICNS_HEADER_BYTES || total > buf.length) {
    throw new IcnsDecodeError(`Invalid ICNS file: the header declares ${total} bytes but the file has ${buf.length}.`);
  }
  let best: Buffer | null = null;
  const elements: Array<{ type: string; data: Buffer }> = [];
  let offset = ICNS_HEADER_BYTES;
  while (offset + ICNS_HEADER_BYTES <= total) {
    const size = buf.readUInt32BE(offset + 4);
    if (size < ICNS_HEADER_BYTES || offset + size > total) {
      throw new IcnsDecodeError(`Invalid ICNS file: the chunk at offset ${offset} declares ${size} bytes, past the end of the file.`);
    }
    const payload = buf.subarray(offset + ICNS_HEADER_BYTES, offset + size);
    if (isEncodedIcnsPayload(payload)) {
      if (best === null || payload.length > best.length) best = payload;
    } else {
      elements.push({ type: buf.toString('latin1', offset, offset + 4), data: payload });
    }
    offset += size;
  }
  if (best !== null) return { kind: 'encoded', data: best, jpeg2000: best.subarray(0, JPEG_2000_SIGNATURE.length).equals(JPEG_2000_SIGNATURE) };
  let legacy: LegacyIcnsPicture | null;
  try {
    legacy = decodeLegacyIcns(elements);
  } catch (err) {
    if (err instanceof LegacyIcnsError) throw new IcnsDecodeError(`Invalid ICNS file: ${err.message}.`);
    throw err;
  }
  if (legacy === null) throw new IcnsDecodeError('Invalid ICNS file: it holds no picture element this converter reads (PNG, JPEG, JPEG 2000, RLE colour or ARGB).');
  return { kind: 'raster', ...legacy };
}
