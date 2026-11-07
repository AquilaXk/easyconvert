import zlib from 'node:zlib';

/** A PNG written by hand, so that its colour type, bit depth, palette, tRNS chunk and the filter of each row are the ones a test names. */

export interface CraftedPng {
  width: number;
  height: number;
  /** Bits per sample: 1, 2, 4, 8 or 16. */
  bits: number;
  /** PNG colour type: 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  colorType: number;
  /** The unfiltered rows, each `ceil(width * channels * bits / 8)` bytes, one after the other. */
  rows: Buffer;
  palette?: Buffer;
  transparency?: Buffer;
  /** Zero bytes after the last row inside the zlib stream (a decompression bomb when large). */
  trailingBytes?: number;
}

export const CHANNELS_OF: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** The row filtered with PNG filter `type` (0 none, 1 sub, 2 up, 3 average, 4 Paeth), the filter byte in front. */
function filterRow(type: number, row: Buffer, prior: Buffer, step: number): Buffer {
  const out = Buffer.alloc(row.length + 1);
  out[0] = type;
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= step ? row[i - step] : 0;
    const above = prior[i];
    const aboveLeft = i >= step ? prior[i - step] : 0;
    const predicted = [0, left, above, (left + above) >> 1, paeth(left, above, aboveLeft)][type];
    out[i + 1] = (row[i] - predicted) & 0xff;
  }
  return out;
}

/** The PNG file; the rows use the filter types 0 to 4 in turn, so that every filter is read. */
export function craftPng(png: CraftedPng): Buffer {
  const channels = CHANNELS_OF[png.colorType];
  const rowBytes = Math.ceil((png.width * channels * png.bits) / 8);
  const step = Math.max(1, (channels * png.bits) >> 3);
  const filtered: Buffer[] = [];
  let prior: Buffer = Buffer.alloc(rowBytes);
  for (let y = 0; y < png.height; y += 1) {
    const row = png.rows.subarray(y * rowBytes, (y + 1) * rowBytes);
    filtered.push(filterRow(y % 5, row, prior, step));
    prior = row;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(png.width, 0);
  header.writeUInt32BE(png.height, 4);
  header[8] = png.bits;
  header[9] = png.colorType;
  const compressed = zlib.deflateSync(Buffer.concat([...filtered, Buffer.alloc(png.trailingBytes ?? 0)]));
  // Two IDAT chunks, as a decoder meets them in a file from a streaming encoder.
  const half = compressed.length >> 1;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(png.palette ? [chunk('PLTE', png.palette)] : []),
    ...(png.transparency ? [chunk('tRNS', png.transparency)] : []),
    chunk('IDAT', compressed.subarray(0, half)),
    chunk('IDAT', compressed.subarray(half)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
