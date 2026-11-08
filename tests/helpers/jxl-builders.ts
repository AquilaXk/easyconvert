import { JXL_CODESTREAM_SIGNATURE, JXL_CONTAINER_SIGNATURE } from '../../src/lib/format-signatures';

/**
 * JPEG XL headers written bit by bit from the layout of ISO/IEC 18181-1 (the SizeHeader, section 6.2: `small`, the height, a 3-bit
 * aspect ratio, the width when the ratio is 0) and 18181-2 (the box layout of the container). Bits are packed least significant first.
 */

export interface SizeHeaderFields {
  small: boolean;
  /** Pixels per side; a small picture's sides are multiples of 8 up to 256. */
  height: number;
  /** Stated when `ratio` is 0 or absent. */
  width?: number;
  /** 0 states the width, 1 to 7 derive it from the height (1:1, 12:10, 4:3, 3:2, 16:9, 5:4, 2:1). */
  ratio?: number;
}

const SIDE_FIELD_BITS = [9, 13, 18, 30] as const;
const SELECTOR_BITS = 2;
const SMALL_SIDE_BITS = 5;
const RATIO_BITS = 3;
const PIXELS_PER_SMALL_STEP = 8;

class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, count: number): void {
    for (let i = 0; i < count; i += 1) this.bits.push(Math.floor(value / 2 ** i) % 2);
  }

  /** U32(BitsOffset(9, 1), BitsOffset(13, 1), BitsOffset(18, 1), BitsOffset(30, 1)): a selector, then the value less 1 in the smallest field it fits. */
  side(value: number): void {
    const selector = SIDE_FIELD_BITS.findIndex((bits) => value - 1 < 2 ** bits);
    this.write(selector, SELECTOR_BITS);
    this.write(value - 1, SIDE_FIELD_BITS[selector]);
  }

  bytes(): Buffer {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      out[index >> 3] |= bit << (index & 7);
    });
    return out;
  }
}

/** The SizeHeader bytes of a picture, padded with the zero bits the image metadata that follows would start with. */
export function jxlSizeHeader(fields: SizeHeaderFields): Buffer {
  const writer = new BitWriter();
  const ratio = fields.ratio ?? 0;
  writer.write(fields.small ? 1 : 0, 1);
  if (fields.small) writer.write(fields.height / PIXELS_PER_SMALL_STEP - 1, SMALL_SIDE_BITS);
  else writer.side(fields.height);
  writer.write(ratio, RATIO_BITS);
  if (ratio === 0) {
    const width = fields.width ?? 0;
    if (fields.small) writer.write(width / PIXELS_PER_SMALL_STEP - 1, SMALL_SIDE_BITS);
    else writer.side(width);
  }
  return writer.bytes();
}

/** A bare codestream: the signature, the header, and zero bytes so that the header never ends the buffer. */
export function jxlCodestream(sizeHeader: Buffer, paddingBytes = 16): Buffer {
  return Buffer.concat([Buffer.from(JXL_CODESTREAM_SIGNATURE), sizeHeader, Buffer.alloc(paddingBytes)]);
}

export interface JxlBox {
  type: string;
  content: Buffer;
  /** Write the 64-bit length form. */
  largeSize?: boolean;
  /** Write a length of 0 (the box runs to the end of the file). */
  toEnd?: boolean;
}

function box({ type, content, largeSize, toEnd }: JxlBox): Buffer {
  const head = Buffer.alloc(largeSize === true ? 16 : 8);
  if (largeSize === true) {
    head.writeUInt32BE(1, 0);
    head.writeBigUInt64BE(BigInt(head.length + content.length), 8);
  } else {
    head.writeUInt32BE(toEnd === true ? 0 : head.length + content.length, 0);
  }
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, content]);
}

/** A container: the signature box, an `ftyp` box, then `boxes` in order. */
export function jxlContainer(boxes: readonly JxlBox[]): Buffer {
  const ftyp = box({ type: 'ftyp', content: Buffer.concat([Buffer.from('jxl '), Buffer.alloc(4), Buffer.from('jxl ')]) });
  return Buffer.concat([Buffer.from(JXL_CONTAINER_SIGNATURE), ftyp, ...boxes.map(box)]);
}
