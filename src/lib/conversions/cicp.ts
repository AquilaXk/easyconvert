import zlib from 'node:zlib';
import { ConversionFailedError } from '../types';
import { type Chromaticities, BT2020_PRIMARIES, BT709_PRIMARIES, DISPLAY_P3_PRIMARIES } from './colour-primaries';

/**
 * Coding-independent code points (ITU-T H.273, the values carried by PNG `cICP` and AVIF/HEIF `colr` nclx) and
 * the PNG chunk that holds them (PNG Third Edition, section 11.3.2.5).
 */

export interface Cicp {
  readonly primaries: number;
  readonly transfer: number;
  readonly matrix: number;
  readonly fullRange: boolean;
}

/** H.273 colour primaries. */
export const CICP_PRIMARIES_BT709 = 1;
export const CICP_PRIMARIES_BT2020 = 9;
export const CICP_PRIMARIES_DISPLAY_P3 = 12;
/** H.273 transfer characteristics. */
export const CICP_TRANSFER_BT709 = 1;
export const CICP_TRANSFER_LINEAR = 8;
export const CICP_TRANSFER_SRGB = 13;
export const CICP_TRANSFER_PQ = 16;
export const CICP_TRANSFER_HLG = 18;
/** H.273 matrix coefficients: identity (RGB) and BT.2020 non-constant luminance. */
export const CICP_MATRIX_IDENTITY = 0;

const HDR_TRANSFERS: ReadonlySet<number> = new Set([CICP_TRANSFER_PQ, CICP_TRANSFER_HLG]);

export function isHdrTransfer(transfer: number): boolean {
  return HDR_TRANSFERS.has(transfer);
}

/** Chromaticities for the primaries code points this project converts; null for any other. */
export function primariesOfCicp(code: number): Chromaticities | null {
  if (code === CICP_PRIMARIES_BT709) return BT709_PRIMARIES;
  if (code === CICP_PRIMARIES_BT2020) return BT2020_PRIMARIES;
  if (code === CICP_PRIMARIES_DISPLAY_P3) return DISPLAY_P3_PRIMARIES;
  return null;
}

/** A container whose colour tag cannot be read or written; a typed 400. */
export class ColourTagError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'ColourTagError';
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_OVERHEAD = 12;
const PNG_IHDR_END = PNG_SIGNATURE.length + PNG_CHUNK_OVERHEAD + 13;
/** Chunks examined before the image data: real files carry fewer than ten ahead of IDAT. */
export const PNG_MAX_CHUNKS_SCANNED = 64;
const CICP_BYTES = 4;

/** The `cICP` chunk of a PNG, or null when it has none. Throws ColourTagError for a malformed chunk. */
export function readPngCicp(png: Buffer): Cicp | null {
  if (png.length < PNG_IHDR_END || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  let offset = PNG_SIGNATURE.length;
  for (let scanned = 0; scanned < PNG_MAX_CHUNKS_SCANNED && offset + PNG_CHUNK_OVERHEAD <= png.length; scanned += 1) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT' || type === 'IEND') return null;
    if (offset + PNG_CHUNK_OVERHEAD + length > png.length) throw new ColourTagError('PNG chunk runs past the end of the file');
    if (type === 'cICP') {
      if (length !== CICP_BYTES) throw new ColourTagError(`PNG cICP chunk has ${length} bytes, expected ${CICP_BYTES}`);
      const data = png.subarray(offset + 8, offset + 8 + CICP_BYTES);
      return { primaries: data[0], transfer: data[1], matrix: data[2], fullRange: data[3] === 1 };
    }
    offset += PNG_CHUNK_OVERHEAD + length;
  }
  return null;
}

/** The PNG with a `cICP` chunk right after IHDR, replacing any existing one. */
export function writePngCicp(png: Buffer, cicp: Cicp): Buffer {
  if (png.length < PNG_IHDR_END || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new ColourTagError('not a PNG file');
  }
  const body = Buffer.alloc(PNG_CHUNK_OVERHEAD + CICP_BYTES);
  body.writeUInt32BE(CICP_BYTES, 0);
  body.write('cICP', 4, 'latin1');
  body[8] = cicp.primaries;
  body[9] = cicp.transfer;
  body[10] = cicp.matrix;
  body[11] = cicp.fullRange ? 1 : 0;
  body.writeUInt32BE(zlib.crc32(body.subarray(4, 12)), 12);

  // One pass over the chunk list (linear in the file size); an existing cICP is dropped.
  const kept: Buffer[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + PNG_CHUNK_OVERHEAD <= png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + PNG_CHUNK_OVERHEAD + length;
    if (end > png.length) throw new ColourTagError('PNG chunk runs past the end of the file');
    if (png.toString('latin1', offset + 4, offset + 8) !== 'cICP') kept.push(png.subarray(offset, end));
    offset = end;
  }
  const [ihdr, ...rest] = kept;
  return Buffer.concat([PNG_SIGNATURE, ihdr, body, ...rest]);
}
