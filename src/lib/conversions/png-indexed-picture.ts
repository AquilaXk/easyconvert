import { deflateIndexedRows, looksLikeNoise } from './png-indexed-deflate';
import { coOccurrenceOrder, edgeColourFirst, renumberIndices } from './png-palette-order';
import { filterRowsByEntropy } from './png-row-filter';

/**
 * The rows of an indexed PNG that the worker writes itself, and the palette order and filters they are written with (entry 263 has the
 * measurements; entry 258 the deflaters). A picture of 17 to 256 colours is written at 8 bits an index, and two things in front of the
 * deflater change its size:
 *
 * - **The order of the palette.** A graphic gets its background colour (the one that most often starts a row) at index 0, which the filter byte of 0 in
 *   front of every row then extends into a run. A photograph gets the order of oxipng's `-o2` (colours that sit next to each other in the picture
 *   next to each other in the palette), which makes the differences between neighbouring indices small.
 * - **The filter of each row**, for a photograph only: the entropy strategy of oxipng picks the PNG filter of each row. It wins 5 to 25 percent on
 *   some pictures and loses 2 to 15 on others, which no estimate from the rows told apart (the entropy of the rows, a sample deflated at the
 *   fastest levels of zlib and libdeflate agree with the real size for 41 to 47 of 55 files), so both versions are deflated, side by side, and the
 *   smaller is written.
 *
 * Pictures of 16 colours or fewer (depth 1, 2 or 4) keep the palette order and rows they always had.
 */

export interface IndexedPicture {
  width: number;
  height: number;
  /** The palette entries, four bytes (RGBA, straight alpha) each. */
  palette: Buffer;
  /** One palette index a pixel, row after row. */
  indices: Buffer;
}

export type BitDepth = 1 | 2 | 4 | 8;

const RGBA_CHANNELS = 4;
const MAX_PACKED_COLOURS = 16;

/** Bits a palette index takes in a PNG: the smallest of 1, 2, 4 and 8 that holds `colours` entries. */
export function bitDepthOf(colours: number): BitDepth {
  if (colours <= 2) return 1;
  if (colours <= 4) return 2;
  return colours <= MAX_PACKED_COLOURS ? 4 : 8;
}

/** The rows of the picture behind a filter byte of 0 each, with the indices packed into `depth` bits, high bits first. */
export function scanlinesOf(picture: IndexedPicture, depth: BitDepth): Buffer {
  const { width, height, indices } = picture;
  const rowBytes = Math.ceil((width * depth) / 8);
  const out = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (rowBytes + 1) + 1;
    if (depth === 8) {
      indices.copy(out, start, y * width, (y + 1) * width);
      continue;
    }
    const perByte = 8 / depth;
    for (let x = 0; x < width; x += 1) {
      const shift = 8 - depth * ((x % perByte) + 1);
      out[start + Math.floor(x / perByte)] |= indices[y * width + x] << shift;
    }
  }
  return out;
}

/** The same picture with its palette entry `order[i]` moved to `i` and the indices renumbered, so every pixel keeps its colour. */
function reordered(picture: IndexedPicture, order: Uint8Array): IndexedPicture {
  const palette = Buffer.alloc(picture.palette.length);
  order.forEach((old, index) => picture.palette.copy(palette, index * RGBA_CHANNELS, old * RGBA_CHANNELS, (old + 1) * RGBA_CHANNELS));
  return { ...picture, palette, indices: renumberIndices(picture.indices, order) };
}

/** The picture as it is written, and the deflate stream (zlib framing included) of its rows. */
export interface DeflatedPicture {
  picture: IndexedPicture;
  stream: Buffer;
}

export async function deflateIndexedPicture(picture: IndexedPicture, depth: BitDepth, signal?: AbortSignal): Promise<DeflatedPicture> {
  const plain = scanlinesOf(picture, depth);
  const noisy = looksLikeNoise(plain);
  if (depth !== 8) return { picture, stream: await deflateIndexedRows(plain, noisy, signal) };
  const { width, height, indices } = picture;
  const colours = picture.palette.length / RGBA_CHANNELS;
  const order = noisy ? coOccurrenceOrder(indices, width, height, colours) : edgeColourFirst(indices, width, height, colours);
  const arranged = order === null ? picture : reordered(picture, order);
  const rows = order === null ? plain : scanlinesOf(arranged, 8);
  if (!noisy) return { picture: arranged, stream: await deflateIndexedRows(rows, false, signal) };
  const [unfiltered, filtered] = await Promise.all([
    deflateIndexedRows(rows, true, signal),
    deflateIndexedRows(filterRowsByEntropy(arranged.indices, width, height), true, signal),
  ]);
  return { picture: arranged, stream: filtered.length < unfiltered.length ? filtered : unfiltered };
}
