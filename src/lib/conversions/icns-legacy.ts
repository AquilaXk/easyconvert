/**
 * The old-style pictures of an ICNS file: the 24-bit RLE colour elements (`is32`, `il32`, `ih32`, `it32`) with their
 * 8-bit masks (`s8mk`, `l8mk`, `h8mk`, `t8mk`), and the `ARGB` elements (`ic04`, `ic05`).
 *
 * The run-length scheme and the extra header of the 128x128 element are adapted from python-pillow/Pillow
 * (`src/PIL/IcnsImagePlugin.py`, SHA-256 76bfe9ebc936102a0e36bc370eac372128a0dfdb97a37f586379d37ec854347c, `read_32`, `read_32t` and `read_mk`, at tag 12.0.0, commit
 * 693df7b42c666f88c719f9973be0ad71607328e0), MIT-CMU:
 *
 * The Python Imaging Library (PIL) is
 *     Copyright (c) 1997-2011 by Secret Labs AB
 *     Copyright (c) 1995-2011 by Fredrik Lundh and contributors
 * Pillow is the friendly PIL fork. It is
 *     Copyright (c) 2010 by Jeffrey A. Clark and contributors
 * Like PIL, Pillow is licensed under the open source MIT-CMU License:
 *
 * By obtaining, using, and/or copying this software and/or its associated documentation, you agree that you have read,
 * understood, and will comply with the following terms and conditions:
 *
 * Permission to use, copy, modify and distribute this software and its documentation for any purpose and without fee
 * is hereby granted, provided that the above copyright notice appears in all copies, and that both that copyright
 * notice and this permission notice appear in supporting documentation, and that the name of Secret Labs AB or the
 * author not be used in advertising or publicity pertaining to distribution of the software without specific, written
 * prior permission.
 *
 * SECRET LABS AB AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE, INCLUDING ALL IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL SECRET LABS AB OR THE AUTHOR BE LIABLE FOR ANY SPECIAL,
 * INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
 * AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 *
 * Pillow does not read the `ARGB` elements; they are four channels (alpha, red, green, blue) coded with the same
 * scheme after a four-byte `ARGB` tag, checked against the pictures macOS stores in its own icon files and in agreement with mdsteele/rust-icns
 * (`src/element.rs`, `decode_rle_argb_to_rgba` at commit daaa8b28536398e4e823cdb4765a4e27d8111c64, MIT), whose code is read for the layout and not copied.
 */

/** A decoded old-style picture: straight RGBA, row by row. */
export interface LegacyIcnsPicture {
  width: number;
  height: number;
  rgba: Buffer;
}

/** The input of an element ended or did not add up to the picture it declares. */
export class LegacyIcnsError extends Error {}

interface ColourElement {
  side: number;
  mask: string;
  /** The element holds a four-byte zero header before the channels (the 128x128 one). */
  header: boolean;
}

const COLOUR_ELEMENTS: ReadonlyMap<string, ColourElement> = new Map([
  ['is32', { side: 16, mask: 's8mk', header: false }],
  ['il32', { side: 32, mask: 'l8mk', header: false }],
  ['ih32', { side: 48, mask: 'h8mk', header: false }],
  ['it32', { side: 128, mask: 't8mk', header: true }],
]);
const ARGB_ELEMENTS: ReadonlyMap<string, number> = new Map([
  ['ic04', 16],
  ['ic05', 32],
]);
const ARGB_TAG = 'ARGB';
const TAG_BYTES = 4;
const RGB_CHANNELS = 3;
const ARGB_CHANNELS = 4;
const RGBA_CHANNELS = 4;
const OPAQUE = 0xff;
/** A control byte at or above this value repeats the next byte; below it, it counts literal bytes. */
const RUN_FLAG = 0x80;
/** A run of `control - RUN_BASE` bytes (3 to 130). */
const RUN_BASE = 125;

/**
 * Reads `channels` planes of `pixels` bytes each from the run-length data, one plane after the other. Returns the planes
 * and the offset after the last one.
 */
function readPlanes(data: Buffer, start: number, pixels: number, channels: number): { planes: Buffer[]; end: number } {
  const planes: Buffer[] = [];
  let position = start;
  for (let channel = 0; channel < channels; channel++) {
    const plane = Buffer.allocUnsafe(pixels);
    let filled = 0;
    while (filled < pixels) {
      if (position >= data.length) throw new LegacyIcnsError(`channel ${channel} ends ${pixels - filled} bytes short`);
      const control = data[position++];
      if ((control & RUN_FLAG) !== 0) {
        const run = control - RUN_BASE;
        if (position >= data.length) throw new LegacyIcnsError(`channel ${channel} ends inside a run`);
        if (run > pixels - filled) throw new LegacyIcnsError(`channel ${channel} has a run past its last pixel`);
        plane.fill(data[position++], filled, filled + run);
        filled += run;
      } else {
        const count = control + 1;
        if (count > pixels - filled) throw new LegacyIcnsError(`channel ${channel} has a literal block past its last pixel`);
        if (position + count > data.length) throw new LegacyIcnsError(`channel ${channel} ends inside a literal block`);
        data.copy(plane, filled, position, position + count);
        position += count;
        filled += count;
      }
    }
    planes.push(plane);
  }
  return { planes, end: position };
}

function interleave(planes: readonly Buffer[], channelOrder: readonly number[], pixels: number, alpha: Buffer | null): Buffer {
  const rgba = Buffer.allocUnsafe(pixels * RGBA_CHANNELS);
  const [red, green, blue] = channelOrder.map((index) => planes[index]);
  for (let i = 0, o = 0; i < pixels; i++, o += RGBA_CHANNELS) {
    rgba[o] = red[i];
    rgba[o + 1] = green[i];
    rgba[o + 2] = blue[i];
    rgba[o + 3] = alpha === null ? OPAQUE : alpha[i];
  }
  return rgba;
}

function decodeColourElement(spec: ColourElement, data: Buffer, mask: Buffer | undefined): LegacyIcnsPicture {
  const pixels = spec.side * spec.side;
  let start = 0;
  if (spec.header) {
    if (data.length < TAG_BYTES || data.readUInt32BE(0) !== 0) throw new LegacyIcnsError('the 128x128 element does not start with four zero bytes');
    start = TAG_BYTES;
  }
  let planes: Buffer[];
  if (data.length - start === pixels * RGB_CHANNELS) {
    // Uncompressed: the pixels follow as red, green, blue.
    const rgb = data.subarray(start);
    planes = [0, 1, 2].map((channel) => Buffer.from(rgb.filter((_, index) => index % RGB_CHANNELS === channel)));
  } else {
    const read = readPlanes(data, start, pixels, RGB_CHANNELS);
    if (read.end !== data.length) throw new LegacyIcnsError(`${data.length - read.end} bytes follow the last channel`);
    planes = read.planes;
  }
  let alpha: Buffer | null = null;
  if (mask !== undefined) {
    // An alpha mask is uncompressed; a mask of another size is not this picture's.
    if (mask.length !== pixels) throw new LegacyIcnsError(`the mask holds ${mask.length} bytes, not ${pixels}`);
    alpha = mask;
  }
  return { width: spec.side, height: spec.side, rgba: interleave(planes, [0, 1, 2], pixels, alpha) };
}

function decodeArgbElement(side: number, data: Buffer): LegacyIcnsPicture {
  if (data.length < TAG_BYTES || data.toString('latin1', 0, TAG_BYTES) !== ARGB_TAG) throw new LegacyIcnsError('the element does not start with the ARGB tag');
  const pixels = side * side;
  const read = readPlanes(data, TAG_BYTES, pixels, ARGB_CHANNELS);
  if (read.end !== data.length) throw new LegacyIcnsError(`${data.length - read.end} bytes follow the last channel`);
  const [alpha, ...colour] = read.planes;
  return { width: side, height: side, rgba: interleave(colour, [0, 1, 2], pixels, alpha) };
}

/**
 * The largest old-style picture among the elements of an ICNS file (type and payload), or null when it holds none. An
 * element that does not add up to its picture is an error, never a guess.
 */
export function decodeLegacyIcns(elements: ReadonlyArray<{ type: string; data: Buffer }>): LegacyIcnsPicture | null {
  const byType = new Map(elements.map((element) => [element.type, element.data]));
  let best: LegacyIcnsPicture | null = null;
  const consider = (picture: LegacyIcnsPicture): void => {
    if (best === null || picture.width > best.width) best = picture;
  };
  for (const [type, spec] of COLOUR_ELEMENTS) {
    const data = byType.get(type);
    if (data !== undefined) consider(decodeColourElement(spec, data, byType.get(spec.mask)));
  }
  for (const [type, side] of ARGB_ELEMENTS) {
    const data = byType.get(type);
    // ic04 and ic05 also hold PNG or JPEG 2000 in newer files; only the tagged ones are old-style.
    if (data !== undefined && data.toString('latin1', 0, TAG_BYTES) === ARGB_TAG) consider(decodeArgbElement(side, data));
  }
  return best;
}
