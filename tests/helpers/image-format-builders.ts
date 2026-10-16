/**
 * Writers of tiny pictures in the legacy raster formats, written from the layouts in the format documents, never from the
 * decoder under test. Every picture is a few pixels whose values the test knows, so a decode is judged against those values.
 *
 * - Truevision TGA 2.0 (image type 2 uncompressed true-colour, 10 run-length true-colour, 1 and 9 colour-mapped)
 * - ZSoft PCX version 5 (run-length 8-bit planes with a 256-colour palette, 1-bit planes)
 * - Netpbm P1 to P6 (netpbm.sourceforge.net/doc/pbm.html, pgm.html, ppm.html)
 * - Microsoft DDS (DirectDraw Surface programming guide: DDS_HEADER, DDS_PIXELFORMAT, DXT1 blocks)
 */

export interface RgbaPixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

const TGA_HEADER_BYTES = 18;
const TGA_TRUE_COLOUR = 2;
const TGA_TRUE_COLOUR_RLE = 10;
/** Image descriptor bit 5: the first row in the file is the top row. */
const TGA_TOP_LEFT = 0x20;
const TGA_ALPHA_BITS_32 = 8;

/** An uncompressed 24- or 32-bit TGA, rows stored top-down; samples are stored blue, green, red, (alpha). */
export function buildTga(width: number, height: number, pixels: readonly RgbaPixel[], withAlpha: boolean): Buffer {
  const header = Buffer.alloc(TGA_HEADER_BYTES);
  header[2] = TGA_TRUE_COLOUR;
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = withAlpha ? 32 : 24;
  header[17] = TGA_TOP_LEFT | (withAlpha ? TGA_ALPHA_BITS_32 : 0);
  const body = pixels.flatMap((p) => (withAlpha ? [p.b, p.g, p.r, p.a] : [p.b, p.g, p.r]));
  return Buffer.concat([header, Buffer.from(body)]);
}

/** A run-length TGA: one run packet per row holding that row's first pixel repeated `width` times (rows of one colour). */
export function buildRleTga(width: number, rows: readonly RgbaPixel[]): Buffer {
  const header = Buffer.alloc(TGA_HEADER_BYTES);
  header[2] = TGA_TRUE_COLOUR_RLE;
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(rows.length, 14);
  header[16] = 24;
  header[17] = TGA_TOP_LEFT;
  const packets = rows.flatMap((p) => [0x80 | (width - 1), p.b, p.g, p.r]);
  return Buffer.concat([header, Buffer.from(packets)]);
}

const PCX_HEADER_BYTES = 128;
const PCX_MANUFACTURER = 0x0a;
const PCX_VERSION_WITH_PALETTE = 5;
const PCX_ENCODING_RLE = 1;
const PCX_PALETTE_MARKER = 0x0c;
const PCX_PALETTE_ENTRIES = 256;
const PCX_RUN_FLAG = 0xc0;
const PCX_MAX_RUN = 63;

/** PCX run-length coding (one byte `0xC0 | count` then the value; a value below 0xC0 stands for itself). */
function pcxRunLength(row: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && row[i + run] === row[i] && run < PCX_MAX_RUN) run += 1;
    if (run > 1 || row[i] >= PCX_RUN_FLAG) out.push(PCX_RUN_FLAG | run);
    out.push(row[i]);
    i += run;
  }
  return out;
}

/** An 8-bit, one-plane PCX whose 256-colour palette follows the pixel data; `indices` are row-major palette indices. */
export function buildPcx(width: number, height: number, indices: readonly number[], palette: readonly RgbaPixel[]): Buffer {
  const header = Buffer.alloc(PCX_HEADER_BYTES);
  header[0] = PCX_MANUFACTURER;
  header[1] = PCX_VERSION_WITH_PALETTE;
  header[2] = PCX_ENCODING_RLE;
  header[3] = 8;
  header.writeUInt16LE(width - 1, 8);
  header.writeUInt16LE(height - 1, 10);
  header.writeUInt16LE(72, 12);
  header.writeUInt16LE(72, 14);
  header[65] = 1;
  const bytesPerLine = width % 2 === 0 ? width : width + 1;
  header.writeUInt16LE(bytesPerLine, 66);
  header.writeUInt16LE(1, 68);
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = indices.slice(y * width, (y + 1) * width);
    while (row.length < bytesPerLine) row.push(0);
    rows.push(...pcxRunLength(row));
  }
  const table = Buffer.alloc(PCX_PALETTE_ENTRIES * 3);
  palette.forEach((p, index) => table.set([p.r, p.g, p.b], index * 3));
  return Buffer.concat([header, Buffer.from(rows), Buffer.from([PCX_PALETTE_MARKER]), table]);
}

/** Plain-text (P1, P2, P3) or raw (P4, P5, P6) Netpbm file; `samples` are row-major, one value per channel per pixel. */
export function buildPnm(kind: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6', width: number, height: number, maxValue: number, samples: readonly number[]): Buffer {
  const bitmap = kind === 'P1' || kind === 'P4';
  const header = bitmap ? `${kind}\n${width} ${height}\n` : `${kind}\n${width} ${height}\n${maxValue}\n`;
  if (kind === 'P1' || kind === 'P2' || kind === 'P3') {
    return Buffer.from(`${header}${samples.join(' ')}\n`, 'ascii');
  }
  if (kind === 'P4') {
    const rowBytes = Math.ceil(width / 8);
    const body = Buffer.alloc(rowBytes * height);
    samples.forEach((bit, index) => {
      if (bit === 1) body[Math.floor(index / width) * rowBytes + Math.floor((index % width) / 8)] |= 0x80 >> (index % width) % 8;
    });
    return Buffer.concat([Buffer.from(header, 'ascii'), body]);
  }
  const wide = maxValue > 255;
  const body = Buffer.alloc(samples.length * (wide ? 2 : 1));
  samples.forEach((value, index) => (wide ? body.writeUInt16BE(value, index * 2) : body.writeUInt8(value, index)));
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

const DDS_MAGIC = 'DDS ';
const DDS_HEADER_SIZE = 124;
const DDS_PIXELFORMAT_SIZE = 32;
const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSD_PIXELFORMAT = 0x1000;
const DDSD_LINEARSIZE = 0x80000;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDSCAPS_TEXTURE = 0x1000;
const DDS_FILE_HEADER_BYTES = 4 + DDS_HEADER_SIZE;
const PIXELFORMAT_OFFSET = 4 + 72;

function ddsBase(width: number, height: number, flags: number, pitchOrLinearSize: number): Buffer {
  const file = Buffer.alloc(DDS_FILE_HEADER_BYTES);
  file.write(DDS_MAGIC, 0, 'ascii');
  file.writeUInt32LE(DDS_HEADER_SIZE, 4);
  file.writeUInt32LE(flags, 8);
  file.writeUInt32LE(height, 12);
  file.writeUInt32LE(width, 16);
  file.writeUInt32LE(pitchOrLinearSize, 20);
  file.writeUInt32LE(DDS_PIXELFORMAT_SIZE, PIXELFORMAT_OFFSET);
  file.writeUInt32LE(DDSCAPS_TEXTURE, 4 + 104);
  return file;
}

/** An uncompressed A8R8G8B8 surface (alpha, red, green, blue masks in a 32-bit little-endian word), top row first. */
export function buildDdsArgb(width: number, height: number, pixels: readonly RgbaPixel[]): Buffer {
  const file = ddsBase(width, height, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT | 0x8, width * 4);
  file.writeUInt32LE(DDPF_RGB | DDPF_ALPHAPIXELS, PIXELFORMAT_OFFSET + 4);
  file.writeUInt32LE(32, PIXELFORMAT_OFFSET + 12);
  file.writeUInt32LE(0x00ff0000, PIXELFORMAT_OFFSET + 16);
  file.writeUInt32LE(0x0000ff00, PIXELFORMAT_OFFSET + 20);
  file.writeUInt32LE(0x000000ff, PIXELFORMAT_OFFSET + 24);
  file.writeUInt32LE(0xff000000, PIXELFORMAT_OFFSET + 28);
  const body = Buffer.alloc(pixels.length * 4);
  pixels.forEach((p, index) => body.writeUInt32LE(((p.a << 24) | (p.r << 16) | (p.g << 8) | p.b) >>> 0, index * 4));
  return Buffer.concat([file, body]);
}

/** One DXT1 (BC1) block: two RGB565 end points, then sixteen 2-bit indices, row by row, least significant bits first. */
export function buildDdsDxt1(color0: number, color1: number, indices: readonly number[]): Buffer {
  const file = ddsBase(4, 4, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT | DDSD_LINEARSIZE, 8);
  file.writeUInt32LE(DDPF_FOURCC, PIXELFORMAT_OFFSET + 4);
  file.write('DXT1', PIXELFORMAT_OFFSET + 8, 'ascii');
  const block = Buffer.alloc(8);
  block.writeUInt16LE(color0, 0);
  block.writeUInt16LE(color1, 2);
  let bits = 0;
  indices.forEach((index, position) => {
    bits |= index << (2 * position);
  });
  block.writeUInt32LE(bits >>> 0, 4);
  return Buffer.concat([file, block]);
}

/** The four colours of a DXT1 block with `color0 > color1` (four-colour mode), as the format document defines them. */
export function dxt1Palette(color0: number, color1: number): RgbaPixel[] {
  const expand = (value: number): [number, number, number] => [
    Math.round(((value >> 11) & 0x1f) * 255 / 31),
    Math.round(((value >> 5) & 0x3f) * 255 / 63),
    Math.round((value & 0x1f) * 255 / 31),
  ];
  const c0 = expand(color0);
  const c1 = expand(color1);
  const mix = (a: number, b: number, weightA: number, weightB: number): number => Math.floor((weightA * a + weightB * b) / 3);
  const rgba = (rgb: readonly number[]): RgbaPixel => ({ r: rgb[0], g: rgb[1], b: rgb[2], a: 255 });
  return [
    rgba(c0),
    rgba(c1),
    rgba(c0.map((v, i) => mix(v, c1[i], 2, 1))),
    rgba(c0.map((v, i) => mix(v, c1[i], 1, 2))),
  ];
}
