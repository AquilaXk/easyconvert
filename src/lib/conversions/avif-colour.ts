import { type Cicp, ColourTagError } from './cicp';

/**
 * Reads and rewrites the colour description of an AVIF still (ISO/IEC 23008-12 HEIF, AV1-ISOBMFF, AVIF 1.1).
 *
 * The description lives in one of two places: a `colr` property of type `nclx` in `ipco`, or, when no such property
 * exists, the colour_config of the AV1 sequence header OBU of the primary item (AVIF 1.1 section 4.2.1). Encoders
 * built on libaom (including the one behind the image library) write only the latter. Rewriting changes the three
 * fixed 8-bit code points in place, so no box or offset moves; it needs a sequence header that already carries a
 * colour description.
 */

/** Boxes examined in total, and the deepest nesting followed; a still image has fewer than 40 and 4. */
export const AVIF_MAX_BOXES = 512;
export const AVIF_MAX_BOX_DEPTH = 6;
/** OBUs examined in the primary item before giving up on finding its sequence header. */
export const AV1_MAX_OBUS = 16;

const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;
const FULL_BOX_EXTRA_BYTES = 4;
const NCLX_BYTES = 7;
const OBU_SEQUENCE_HEADER = 1;
const BITS_PER_BYTE = 8;
const LEB128_MAX_BYTES = 8;
const UVLC_MAX_LEADING_ZEROS = 32;
const CONTAINER_BOXES: ReadonlySet<string> = new Set(['meta', 'iprp', 'ipco']);
const FULL_CONTAINER_BOXES: ReadonlySet<string> = new Set(['meta']);

interface Box {
  readonly type: string;
  readonly start: number;
  readonly payload: number;
  readonly end: number;
}

interface ScanState {
  boxes: number;
}

function failure(message: string): never {
  throw new ColourTagError(`Invalid AVIF: ${message}`);
}

function readBoxes(buf: Buffer, from: number, to: number, depth: number, state: ScanState, visit: (box: Box) => void): void {
  if (depth > AVIF_MAX_BOX_DEPTH) failure('boxes nest too deeply');
  let offset = from;
  while (offset + BOX_HEADER_BYTES <= to) {
    state.boxes += 1;
    if (state.boxes > AVIF_MAX_BOXES) failure(`more than ${AVIF_MAX_BOXES} boxes`);
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let header = BOX_HEADER_BYTES;
    if (size === 1) {
      if (offset + LARGE_BOX_HEADER_BYTES > to) failure('truncated box header');
      const large = buf.readBigUInt64BE(offset + BOX_HEADER_BYTES);
      if (large > BigInt(to - offset)) failure(`box "${type}" runs past its parent`);
      size = Number(large);
      header = LARGE_BOX_HEADER_BYTES;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) failure(`box "${type}" runs past its parent`);
    const payload = offset + header + (FULL_CONTAINER_BOXES.has(type) ? FULL_BOX_EXTRA_BYTES : 0);
    const box: Box = { type, start: offset, payload, end: offset + size };
    visit(box);
    if (CONTAINER_BOXES.has(type)) readBoxes(buf, payload, box.end, depth + 1, state, visit);
    offset += size;
  }
}

function leb128(buf: Buffer, offset: number, end: number): { value: number; length: number } {
  let value = 0;
  for (let i = 0; i < LEB128_MAX_BYTES; i += 1) {
    if (offset + i >= end) failure('truncated OBU size');
    const byte = buf[offset + i];
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) return { value, length: i + 1 };
  }
  return failure('OBU size is too long');
}

class BitCursor {
  position: number;
  constructor(
    private readonly buf: Buffer,
    private readonly startByte: number,
    private readonly endByte: number,
  ) {
    this.position = startByte * BITS_PER_BYTE;
  }

  bit(): number {
    const byteIndex = this.position >> 3;
    if (byteIndex >= this.endByte) failure('sequence header is truncated');
    const value = (this.buf[byteIndex] >> (7 - (this.position & 7))) & 1;
    this.position += 1;
    return value;
  }

  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = value * 2 + this.bit();
    return value;
  }

  uvlc(): number {
    let leadingZeros = 0;
    while (this.bit() === 0) {
      leadingZeros += 1;
      if (leadingZeros >= UVLC_MAX_LEADING_ZEROS) return 2 ** UVLC_MAX_LEADING_ZEROS - 1;
    }
    return this.bits(leadingZeros) + 2 ** leadingZeros - 1;
  }
}

interface SequenceColour {
  readonly described: boolean;
  /** Bit position of the three 8-bit code points (primaries, transfer, matrix) when described. */
  readonly codePointBit: number;
  readonly cicp: Cicp;
  readonly fullRangeBit: number;
}

/** AV1 specification 5.5: sequence_header_obu up to and including color_config. */
function parseSequenceHeader(buf: Buffer, start: number, end: number): SequenceColour {
  const r = new BitCursor(buf, start, end);
  const profile = r.bits(3);
  r.bit(); // still_picture
  const reduced = r.bit() === 1;
  let decoderModelInfoPresent = 0;
  let bufferDelayLength = 0;
  if (reduced) {
    r.bits(5); // seq_level_idx[0]
  } else {
    const timingInfoPresent = r.bit();
    if (timingInfoPresent) {
      r.bits(32); // num_units_in_display_tick
      r.bits(32); // time_scale
      if (r.bit()) r.uvlc(); // equal_picture_interval, num_ticks_per_picture_minus_1
      decoderModelInfoPresent = r.bit();
      if (decoderModelInfoPresent) {
        bufferDelayLength = r.bits(5) + 1;
        r.bits(32); // num_units_in_decoding_tick
        r.bits(5); // buffer_removal_time_length_minus_1
        r.bits(5); // frame_presentation_time_length_minus_1
      }
    }
    const initialDisplayDelayPresent = r.bit();
    const operatingPoints = r.bits(5) + 1;
    for (let i = 0; i < operatingPoints; i += 1) {
      r.bits(12); // operating_point_idc
      const level = r.bits(5);
      if (level > 7) r.bit(); // seq_tier
      if (decoderModelInfoPresent && r.bit()) {
        r.bits(bufferDelayLength); // decoder_buffer_delay
        r.bits(bufferDelayLength); // encoder_buffer_delay
        r.bit(); // low_delay_mode_flag
      }
      if (initialDisplayDelayPresent && r.bit()) r.bits(4);
    }
  }
  const widthBits = r.bits(4) + 1;
  const heightBits = r.bits(4) + 1;
  r.bits(widthBits);
  r.bits(heightBits);
  let frameIdNumbersPresent = 0;
  if (!reduced) frameIdNumbersPresent = r.bit();
  if (frameIdNumbersPresent) {
    r.bits(4);
    r.bits(3);
  }
  r.bits(3); // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
  if (!reduced) {
    r.bits(4); // interintra, masked compound, warped motion, dual filter
    const orderHint = r.bit();
    if (orderHint) r.bits(2); // enable_jnt_comp, enable_ref_frame_mvs
    const chooseScreenContentTools = r.bit();
    const forceScreenContentTools = chooseScreenContentTools ? 2 : r.bit();
    if (forceScreenContentTools > 0) {
      if (!r.bit()) r.bit(); // seq_choose_integer_mv ? (skip) : seq_force_integer_mv
    }
    if (orderHint) r.bits(3);
  }
  r.bits(3); // enable_superres, enable_cdef, enable_restoration
  // color_config()
  const highBitdepth = r.bit();
  if (profile === 2 && highBitdepth) r.bit(); // twelve_bit
  const monochrome = profile === 1 ? 0 : r.bit();
  const described = r.bit() === 1;
  const codePointBit = r.position;
  let primaries = 2;
  let transfer = 2;
  let matrix = 2;
  if (described) {
    primaries = r.bits(8);
    transfer = r.bits(8);
    matrix = r.bits(8);
  }
  const fullRangeBit = r.position;
  let fullRange = false;
  if (monochrome) {
    fullRange = r.bit() === 1;
  } else if (primaries === 1 && transfer === 13 && matrix === 0) {
    fullRange = true;
  } else {
    fullRange = r.bit() === 1;
  }
  return { described, codePointBit, cicp: { primaries, transfer, matrix, fullRange }, fullRangeBit };
}

interface PrimaryItem {
  readonly offset: number;
  readonly length: number;
}

function readPrimaryItemExtent(buf: Buffer, pitm: Box, iloc: Box): PrimaryItem {
  if (pitm.end - pitm.payload < FULL_BOX_EXTRA_BYTES + 2) failure('truncated pitm box');
  const itemId = buf[pitm.payload] === 0 ? buf.readUInt16BE(pitm.payload + FULL_BOX_EXTRA_BYTES) : buf.readUInt32BE(pitm.payload + FULL_BOX_EXTRA_BYTES);

  if (iloc.end - iloc.payload < FULL_BOX_EXTRA_BYTES + 2) failure('truncated iloc box');
  const ilocVersion = buf[iloc.payload];
  let at = iloc.payload + FULL_BOX_EXTRA_BYTES;
  const sizes = buf.readUInt16BE(at);
  at += 2;
  const offsetSize = (sizes >> 12) & 0xf;
  const lengthSize = (sizes >> 8) & 0xf;
  const baseOffsetSize = (sizes >> 4) & 0xf;
  const indexSize = ilocVersion === 1 || ilocVersion === 2 ? sizes & 0xf : 0;
  const readUnsigned = (size: number): number => {
    if (size === 0) return 0;
    if (size > LEB128_MAX_BYTES || at + size > iloc.end) failure('iloc field is truncated');
    let value = 0;
    for (let i = 0; i < size; i += 1) value = value * 256 + buf[at + i];
    at += size;
    return value;
  };
  const itemCount = ilocVersion < 2 ? readUnsigned(2) : readUnsigned(4);
  for (let item = 0; item < itemCount; item += 1) {
    const id = ilocVersion < 2 ? readUnsigned(2) : readUnsigned(4);
    let method = 0;
    if (ilocVersion === 1 || ilocVersion === 2) method = readUnsigned(2) & 0xf;
    readUnsigned(2); // data_reference_index
    const base = readUnsigned(baseOffsetSize);
    const extents = readUnsigned(2);
    let first: PrimaryItem | null = null;
    for (let e = 0; e < extents; e += 1) {
      readUnsigned(indexSize);
      const offset = readUnsigned(offsetSize);
      const length = readUnsigned(lengthSize);
      if (first === null) first = { offset: base + offset, length };
    }
    if (id === itemId) {
      if (method !== 0 || first === null) failure('the primary item is not stored at a file offset');
      return first;
    }
  }
  return failure('the primary item has no location');
}

interface Located {
  readonly nclx: Cicp | null;
  readonly sequence: SequenceColour | null;
  readonly sequenceStart: number;
}

function locate(buf: Buffer): Located {
  let ftyp = false;
  let pitm: Box | null = null;
  let iloc: Box | null = null;
  let nclx: Cicp | null = null;
  readBoxes(buf, 0, buf.length, 0, { boxes: 0 }, (box) => {
    if (box.type === 'ftyp') ftyp = true;
    else if (box.type === 'pitm') pitm = box;
    else if (box.type === 'iloc') iloc = box;
    else if (box.type === 'colr' && nclx === null && box.end - box.payload >= 4 + NCLX_BYTES) {
      if (buf.toString('latin1', box.payload, box.payload + 4) === 'nclx') {
        const at = box.payload + 4;
        nclx = {
          primaries: buf.readUInt16BE(at),
          transfer: buf.readUInt16BE(at + 2),
          matrix: buf.readUInt16BE(at + 4),
          fullRange: (buf[at + 6] & 0x80) !== 0,
        };
      }
    }
  });
  if (!ftyp) failure('missing the ftyp box');
  if (pitm === null || iloc === null) return { nclx, sequence: null, sequenceStart: -1 };
  const item = readPrimaryItemExtent(buf, pitm, iloc);
  const itemEnd = item.offset + item.length;
  if (itemEnd > buf.length) failure('the primary item runs past the end of the file');
  let offset = item.offset;
  for (let scanned = 0; scanned < AV1_MAX_OBUS && offset < itemEnd; scanned += 1) {
    const header = buf[offset];
    const type = (header >> 3) & 0xf;
    const hasExtension = (header & 0x04) !== 0;
    const hasSize = (header & 0x02) !== 0;
    let at = offset + 1 + (hasExtension ? 1 : 0);
    let size = itemEnd - at;
    if (hasSize) {
      const decoded = leb128(buf, at, itemEnd);
      size = decoded.value;
      at += decoded.length;
    }
    if (at + size > itemEnd) failure('an OBU runs past the primary item');
    if (type === OBU_SEQUENCE_HEADER) {
      return { nclx, sequence: parseSequenceHeader(buf, at, at + size), sequenceStart: at };
    }
    offset = at + size;
  }
  return { nclx, sequence: null, sequenceStart: -1 };
}

/** The colour description of an AVIF: its nclx property if any, otherwise the AV1 sequence header's. */
export function readAvifColour(avif: Buffer): Cicp | null {
  const found = locate(avif);
  if (found.nclx) return found.nclx;
  return found.sequence?.described ? found.sequence.cicp : null;
}

function writeBits(buf: Buffer, bitPosition: number, count: number, value: number): void {
  for (let i = 0; i < count; i += 1) {
    const bit = Math.floor(value / 2 ** (count - 1 - i)) & 1;
    const byteIndex = (bitPosition + i) >> 3;
    const mask = 1 << (7 - ((bitPosition + i) & 7));
    buf[byteIndex] = bit ? buf[byteIndex] | mask : buf[byteIndex] & ~mask;
  }
}

/**
 * Returns a copy of the AVIF whose colour primaries and transfer characteristics are the given code points. The
 * matrix coefficients stay as the encoder wrote them, because they describe how the encoder produced the YCbCr
 * samples. An nclx property, when present, is rewritten too. Throws ColourTagError when the file has no AV1
 * sequence header with a colour description to rewrite.
 */
export function setAvifColour(avif: Buffer, primaries: number, transfer: number): Buffer {
  const found = locate(avif);
  if (!found.sequence?.described) failure('the AV1 sequence header carries no colour description to rewrite');
  const out = Buffer.from(avif);
  writeBits(out, found.sequence.codePointBit, 8, primaries);
  writeBits(out, found.sequence.codePointBit + 8, 8, transfer);
  if (found.nclx) {
    readBoxes(out, 0, out.length, 0, { boxes: 0 }, (box) => {
      if (box.type === 'colr' && out.toString('latin1', box.payload, box.payload + 4) === 'nclx') {
        out.writeUInt16BE(primaries, box.payload + 4);
        out.writeUInt16BE(transfer, box.payload + 6);
      }
    });
  }
  return out;
}
