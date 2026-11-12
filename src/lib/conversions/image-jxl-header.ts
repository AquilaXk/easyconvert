import { JXL_CODESTREAM_SIGNATURE, JXL_CONTAINER_SIGNATURE, startsWithBytes } from '../format-signatures';
import { ConversionFailedError } from '../types';

/**
 * The headers of a JPEG XL file that are read here without decoding a pixel: the container's boxes (ISO/IEC 18181-2) and the
 * SizeHeader at the start of the codestream (18181-1). Bits are read least significant first.
 */

const JXL_LABEL = 'JPEG XL';

const BOX_HEADER_BYTES = 8;
const BOX_LARGE_HEADER_BYTES = 16;
const BOX_LENGTH_LARGE = 1;
const BOX_LENGTH_TO_END = 0;
const CODESTREAM_BOX_TYPE = 'jxlc';
const PARTIAL_CODESTREAM_BOX_TYPE = 'jxlp';
/** A partial codestream box starts with a 32-bit index, whose top bit marks the last box. */
const PARTIAL_INDEX_BYTES = 4;

/** The SizeHeader is at most 68 bits: `small`, a 2-bit selector and 30 bits twice, and the 3-bit ratio. */
const SIZE_HEADER_BYTES = 9;
const HEADER_BYTES_READ = JXL_CODESTREAM_SIGNATURE.length + SIZE_HEADER_BYTES;
/** `small` pictures state their sides in multiples of 8 (5 bits each); the others in one of four fields after a 2-bit selector. */
const SMALL_SIDE_BITS = 5;
const SMALL_SIDE_STEP = 8;
const SIDE_SELECTOR_BITS = 2;
const SIDE_FIELD_BITS: readonly number[] = [9, 13, 18, 30];
const RATIO_BITS = 3;
const U32_SELECTOR_BITS = 2;
/** The aspect ratios a header can name instead of the width (18181-1): width = height * numerator / denominator. */
const ASPECT_RATIOS: readonly (readonly [number, number])[] = [[1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];

export const headerError = (): ConversionFailedError => new ConversionFailedError(`Invalid image: the ${JXL_LABEL} header could not be decoded`);

/** One of the four ways a U32 field is coded: a value without bits, or a number of bits added to an offset. */
export type U32Choice = number | { bits: number; offset: number };

/** Reads fields of a bit string, least significant bit first; a read past its end is a header that cannot be decoded. */
export class BitReader {
  private position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get bitPosition(): number {
    return this.position;
  }

  bool(): boolean {
    return this.read(1) === 1;
  }

  /** A U32 field (18181-1, 9.2.3): a 2-bit selector, then the value of the choice it names. */
  u32(choices: readonly [U32Choice, U32Choice, U32Choice, U32Choice]): number {
    const choice = choices[this.read(U32_SELECTOR_BITS)];
    return typeof choice === 'number' ? choice : this.read(choice.bits) + choice.offset;
  }

  /** The bits from `from` up to the position, as a string of 0 and 1: what two headers must share to describe the same metadata. */
  bitsSince(from: number): string {
    let text = '';
    for (let at = from; at < this.position; at += 1) text += (this.bytes[at >> 3] >> (at & 7)) & 1;
    return text;
  }

  read(count: number): number {
    if (this.position + count > this.bytes.length * 8) throw headerError();
    let value = 0;
    for (let i = 0; i < count; i += 1, this.position += 1) {
      value += ((this.bytes[this.position >> 3] >> (this.position & 7)) & 1) * 2 ** i;
    }
    return value;
  }

  /** U32(BitsOffset(9, 1), BitsOffset(13, 1), BitsOffset(18, 1), BitsOffset(30, 1)): the side less 1, in the field a 2-bit selector names. */
  side(): number {
    return this.read(SIDE_FIELD_BITS[this.read(SIDE_SELECTOR_BITS)]) + 1;
  }
}

/** Where a box ends: its length field, the 64-bit length that follows a 1, or the end of the file for a 0. */
function boxEnd(file: Buffer, offset: number): number {
  const length = file.readUInt32BE(offset);
  if (length === BOX_LENGTH_LARGE) return offset + Number(file.readBigUInt64BE(offset + BOX_HEADER_BYTES));
  return length === BOX_LENGTH_TO_END ? file.length : offset + length;
}

/** The first bytes (at least `wanted`, when the file has them) of the codestream of a container: the contents of its `jxlc` box, or of its `jxlp` boxes in order; null when there is none. */
function containerHead(file: Buffer, wanted: number): Buffer | null {
  const parts: Buffer[] = [];
  let have = 0;
  let offset = JXL_CONTAINER_SIGNATURE.length;
  while (offset + BOX_HEADER_BYTES <= file.length && have < wanted) {
    const type = file.toString('latin1', offset + 4, offset + 8);
    const header = file.readUInt32BE(offset) === BOX_LENGTH_LARGE ? BOX_LARGE_HEADER_BYTES : BOX_HEADER_BYTES;
    if (offset + header > file.length) return null;
    const end = boxEnd(file, offset);
    // A length that cannot hold its own header is no box: no codestream follows.
    if (end < offset + header) return null;
    const content = file.subarray(offset + header, Math.min(end, file.length));
    if (type === CODESTREAM_BOX_TYPE || type === PARTIAL_CODESTREAM_BOX_TYPE) {
      const bytes = type === CODESTREAM_BOX_TYPE ? content : content.subarray(PARTIAL_INDEX_BYTES);
      parts.push(bytes);
      have += bytes.length;
      if (type === CODESTREAM_BOX_TYPE) break;
    }
    offset = end;
  }
  return parts.length === 0 ? null : Buffer.concat(parts);
}

/** The first bytes (at least `wanted`, when the file has them) of the codestream of a file, or null when the bytes are neither a bare codestream nor a container that holds one. */
export function codestreamHead(file: Buffer, wanted = HEADER_BYTES_READ): Buffer | null {
  const head = startsWithBytes(file, JXL_CONTAINER_SIGNATURE) ? containerHead(file, wanted) : file;
  return head !== null && startsWithBytes(head, JXL_CODESTREAM_SIGNATURE) ? head : null;
}

/** The SizeHeader at the reader's position (18181-1, 6.2): the sides, and the width from the ratio when one is named. */
export function readSizeHeader(bits: BitReader): { width: number; height: number } {
  const small = bits.bool();
  const height = small ? (bits.read(SMALL_SIDE_BITS) + 1) * SMALL_SIDE_STEP : bits.side();
  const ratio = bits.read(RATIO_BITS);
  if (ratio > 0) {
    const [numerator, denominator] = ASPECT_RATIOS[ratio - 1];
    return { width: Math.floor((height * numerator) / denominator), height };
  }
  return { width: small ? (bits.read(SMALL_SIDE_BITS) + 1) * SMALL_SIDE_STEP : bits.side(), height };
}

/**
 * Width and height the SizeHeader of a JPEG XL picture states, read without decoding anything. The picture
 * `djxl` writes has the sides swapped when the header's orientation is a quarter turn, which changes neither the pixel count nor the limit.
 */
export function declaredJxlSize(file: Buffer): { width: number; height: number } {
  const head = codestreamHead(file);
  if (head === null) throw headerError();
  return readSizeHeader(new BitReader(head.subarray(JXL_CODESTREAM_SIGNATURE.length, HEADER_BYTES_READ)));
}

/** The types of the boxes of a container, in order; an empty list for a bare codestream, null for a container whose boxes cannot be walked. */
export function containerBoxTypes(file: Buffer): string[] | null {
  const types: string[] = [];
  if (!startsWithBytes(file, JXL_CONTAINER_SIGNATURE)) return types;
  let offset = 0;
  while (offset < file.length) {
    if (offset + BOX_HEADER_BYTES > file.length) return null;
    const header = file.readUInt32BE(offset) === BOX_LENGTH_LARGE ? BOX_LARGE_HEADER_BYTES : BOX_HEADER_BYTES;
    if (offset + header > file.length) return null;
    const end = boxEnd(file, offset);
    if (end < offset + header) return null;
    types.push(file.toString('latin1', offset + 4, offset + 8));
    offset = end;
  }
  return types;
}
