/**
 * Hand-written multi-page TIFF 6.0 writer (little-endian, uncompressed, one strip per page) for the page
 * selection tests. Pages may differ in size, and a page can declare a huge size with a matching zero-filled
 * strip. It shares no code with the converter or with sharp.
 */

const HEADER_BYTES = 8;
const ENTRY_BYTES = 12;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const ENTRIES = 9;
const TAGS = {
  width: 256,
  length: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
} as const;
const BLACK_IS_ZERO = 1;
const NO_COMPRESSION = 1;

export interface BilevelPage {
  width: number;
  height: number;
}

/** Bilevel (1 bit per pixel, all pixels 0) pages, each its own IFD in one chain. */
export function buildBilevelTiff(pages: BilevelPage[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  parts.push(header);
  let offset = HEADER_BYTES;
  let previousNextPointer = 4; // the header's first-IFD pointer
  const joined: Array<{ at: number; value: number }> = [];
  for (const page of pages) {
    const stripBytes = Math.ceil(page.width / 8) * page.height;
    const strip = Buffer.alloc(stripBytes);
    const stripAt = offset;
    parts.push(strip);
    offset += stripBytes;
    if (offset % 2 !== 0) {
      parts.push(Buffer.alloc(1));
      offset += 1;
    }
    const ifdAt = offset;
    joined.push({ at: previousNextPointer, value: ifdAt });
    const ifd = Buffer.alloc(2 + ENTRIES * ENTRY_BYTES + 4);
    ifd.writeUInt16LE(ENTRIES, 0);
    const entry = (index: number, tag: number, type: number, value: number) => {
      const at = 2 + index * ENTRY_BYTES;
      ifd.writeUInt16LE(tag, at);
      ifd.writeUInt16LE(type, at + 2);
      ifd.writeUInt32LE(1, at + 4);
      if (type === TYPE_SHORT) ifd.writeUInt16LE(value, at + 8);
      else ifd.writeUInt32LE(value, at + 8);
    };
    entry(0, TAGS.width, TYPE_LONG, page.width);
    entry(1, TAGS.length, TYPE_LONG, page.height);
    entry(2, TAGS.bitsPerSample, TYPE_SHORT, 1);
    entry(3, TAGS.compression, TYPE_SHORT, NO_COMPRESSION);
    entry(4, TAGS.photometric, TYPE_SHORT, BLACK_IS_ZERO);
    entry(5, TAGS.stripOffsets, TYPE_LONG, stripAt);
    entry(6, TAGS.samplesPerPixel, TYPE_SHORT, 1);
    entry(7, TAGS.rowsPerStrip, TYPE_LONG, page.height);
    entry(8, TAGS.stripByteCounts, TYPE_LONG, stripBytes);
    parts.push(ifd);
    previousNextPointer = ifdAt + 2 + ENTRIES * ENTRY_BYTES;
    offset += ifd.length;
  }
  const file = Buffer.concat(parts);
  for (const link of joined) file.writeUInt32LE(link.value, link.at);
  return file;
}
