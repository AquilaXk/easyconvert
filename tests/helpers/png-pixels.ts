import zlib from 'node:zlib';

/**
 * The pixels of a non-interlaced PNG as 16-bit RGBA, read by this file alone (inflate, unfilter, expand): an oracle that shares no code with
 * the encoders under test, with the image library, or with the optimiser. Two PNGs show the same picture when their RGBA16 samples are equal,
 * whatever colour type or bit depth each one is stored in.
 */

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

const SIGNATURE_BYTES = 8;
const CHUNK_OVERHEAD_BYTES = 12;
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function chunksOf(png: Buffer): Array<{ type: string; data: Buffer }> {
  const chunks: Array<{ type: string; data: Buffer }> = [];
  for (let at = SIGNATURE_BYTES; at + CHUNK_OVERHEAD_BYTES <= png.length; ) {
    const length = png.readUInt32BE(at);
    chunks.push({ type: png.toString('latin1', at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += CHUNK_OVERHEAD_BYTES + length;
  }
  return chunks;
}

export function headerOf(png: Buffer): PngHeader {
  const ihdr = chunksOf(png)[0].data;
  return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), bitDepth: ihdr[8], colorType: ihdr[9], interlace: ihdr[12] };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** The unfiltered scanlines, one after the other, and the filter byte of each row. */
export function scanlinesOf(png: Buffer): { rows: Buffer; filters: number[]; header: PngHeader } {
  const header = headerOf(png);
  if (header.interlace !== 0) throw new Error('png-pixels reads non-interlaced pictures only');
  const idat = Buffer.concat(chunksOf(png).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  const raw = zlib.inflateSync(idat);
  const bitsPerPixel = CHANNELS[header.colorType] * header.bitDepth;
  const rowBytes = Math.ceil((header.width * bitsPerPixel) / 8);
  const step = Math.max(1, bitsPerPixel >> 3);
  const rows = Buffer.alloc(rowBytes * header.height);
  const filters: number[] = [];
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (rowBytes + 1)];
    filters.push(filter);
    for (let i = 0; i < rowBytes; i += 1) {
      const left = i >= step ? rows[y * rowBytes + i - step] : 0;
      const above = y > 0 ? rows[(y - 1) * rowBytes + i] : 0;
      const aboveLeft = y > 0 && i >= step ? rows[(y - 1) * rowBytes + i - step] : 0;
      const predicted = [0, left, above, (left + above) >> 1, paeth(left, above, aboveLeft)][filter];
      rows[y * rowBytes + i] = (raw[y * (rowBytes + 1) + 1 + i] + predicted) & 0xff;
    }
  }
  return { rows, filters, header };
}

const upTo16 = (value: number, bits: number): number => (bits === 16 ? value : Math.round((value * 65535) / ((1 << bits) - 1)));

/** Every pixel as four 16-bit numbers (red, green, blue, alpha), a sample of n bits scaled to 16 bits the way the specification does. */
export function rgba16Of(png: Buffer): Uint16Array {
  const { rows, header } = scanlinesOf(png);
  const chunks = chunksOf(png);
  const palette = chunks.find((chunk) => chunk.type === 'PLTE')?.data;
  const trns = chunks.find((chunk) => chunk.type === 'tRNS')?.data;
  const channels = CHANNELS[header.colorType];
  const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
  const out = new Uint16Array(header.width * header.height * 4);
  const sample = (y: number, index: number): number => {
    const row = y * rowBytes;
    if (header.bitDepth === 16) return rows.readUInt16BE(row + index * 2);
    if (header.bitDepth === 8) return rows[row + index];
    const bit = index * header.bitDepth;
    return (rows[row + (bit >> 3)] >> (8 - header.bitDepth - (bit & 7))) & ((1 << header.bitDepth) - 1);
  };
  const keyed = (values: number[]): boolean => trns !== undefined && values.every((value, i) => value === trns.readUInt16BE(i * 2));
  for (let y = 0; y < header.height; y += 1) {
    for (let x = 0; x < header.width; x += 1) {
      const at = (y * header.width + x) * 4;
      const s = (c: number): number => sample(y, x * channels + c);
      let rgba: number[];
      if (header.colorType === 3) {
        const index = s(0);
        rgba = [palette![index * 3] * 257, palette![index * 3 + 1] * 257, palette![index * 3 + 2] * 257, (trns !== undefined && index < trns.length ? trns[index] : 255) * 257];
      } else {
        const bits = header.bitDepth;
        const v = Array.from({ length: channels }, (_, c) => s(c));
        const scaled = v.map((value) => upTo16(value, bits));
        if (header.colorType === 0) rgba = [scaled[0], scaled[0], scaled[0], keyed([v[0]]) ? 0 : 65535];
        else if (header.colorType === 2) rgba = [scaled[0], scaled[1], scaled[2], keyed(v) ? 0 : 65535];
        else if (header.colorType === 4) rgba = [scaled[0], scaled[0], scaled[0], scaled[1]];
        else rgba = scaled;
      }
      out.set(rgba, at);
    }
  }
  return out;
}

export const sameCriticalChunks = (png: Buffer): string[] => chunksOf(png).map((chunk) => chunk.type);
