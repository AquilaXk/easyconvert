import fs from 'node:fs';
import { RawDecodeError } from '../lib/types';
import { RAW_DECODE_MAX_PIXELS } from '../lib/conversions/raw-formats';

const TIFF_HEADER_READ_BYTES = 8192;
const TIFF_IFD_ENTRY_BYTES = 12;
const TIFF_BYTE_ORDER_LITTLE = 0x4949;
const TIFF_BYTE_ORDER_BIG = 0x4d4d;
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TYPE_SHORT = 3;
const BITS_PER_BYTE = 8;
/** dcraw_emu writes one contiguous strip of 16-bit RGB samples. */
const EXPECTED_BITS_PER_SAMPLE = 16;
const EXPECTED_SAMPLES_PER_PIXEL = 3;

export { RAW_DECODE_MAX_PIXELS };
const DECODED_BYTES_PER_PIXEL = (EXPECTED_BITS_PER_SAMPLE / BITS_PER_BYTE) * EXPECTED_SAMPLES_PER_PIXEL;
const TIFF_HEADER_SLACK_BYTES = 64 * 1024;
/** Upper bound for the decoder's output file, derived from the pixel cap. */
export const RAW_DECODE_MAX_OUTPUT_BYTES = RAW_DECODE_MAX_PIXELS * DECODED_BYTES_PER_PIXEL + TIFF_HEADER_SLACK_BYTES;

/** Fraction of the image height, counted from the bottom, that the truncation probe examines. */
const TAIL_WINDOW_FRACTION = 0.12;
const TAIL_SKIP_BORDER_ROWS = 4;
const TAIL_MIN_PAIRS = 8;
/** Rows are compared two apart: the Bayer pattern repeats every second row, so the filler repeats at that period. */
const TAIL_ROW_PERIOD = 2;
/** Share of examined row pairs that must be byte-identical to call the tail a repeated fill. */
const TAIL_REPEATED_RATIO = 0.9;

export interface DecodedTiffLayout {
  width: number;
  height: number;
  dataOffset: number;
  rowBytes: number;
}

function invalid(detail: string): RawDecodeError {
  return new RawDecodeError(`Native RAW decoder produced an unreadable intermediate image: ${detail}`);
}

/** Reads the geometry of the decoder's 16-bit TIFF from its header, without loading the pixels. */
export function readDecodedTiffLayout(filePath: string): DecodedTiffLayout {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(TIFF_HEADER_READ_BYTES);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const order = head.readUInt16BE(0);
    if (read < TIFF_IFD_ENTRY_BYTES || (order !== TIFF_BYTE_ORDER_LITTLE && order !== TIFF_BYTE_ORDER_BIG)) {
      throw invalid('not a TIFF file');
    }
    const little = order === TIFF_BYTE_ORDER_LITTLE;
    const u16 = (at: number) => (little ? head.readUInt16LE(at) : head.readUInt16BE(at));
    const u32 = (at: number) => (little ? head.readUInt32LE(at) : head.readUInt32BE(at));
    const ifd = u32(4);
    if (ifd + 2 > read) throw invalid('directory outside the header');
    const entries = u16(ifd);
    if (ifd + 2 + entries * TIFF_IFD_ENTRY_BYTES > read) throw invalid('directory outside the header');
    const tags = new Map<number, number>();
    for (let index = 0; index < entries; index += 1) {
      const at = ifd + 2 + index * TIFF_IFD_ENTRY_BYTES;
      const type = u16(at + 2);
      tags.set(u16(at), type === TYPE_SHORT ? u16(at + 8) : u32(at + 8));
    }
    const width = tags.get(TAG_IMAGE_WIDTH);
    const height = tags.get(TAG_IMAGE_LENGTH);
    const dataOffset = tags.get(TAG_STRIP_OFFSETS);
    if (!width || !height || dataOffset === undefined) throw invalid('missing dimensions or strip offset');
    // BitsPerSample holds three SHORTs stored out of line; the first one is representative.
    const bitsPointer = tags.get(TAG_BITS_PER_SAMPLE);
    const bits = bitsPointer !== undefined && bitsPointer + 2 <= read ? u16(bitsPointer) : EXPECTED_BITS_PER_SAMPLE;
    const samples = tags.get(TAG_SAMPLES_PER_PIXEL) ?? EXPECTED_SAMPLES_PER_PIXEL;
    if (bits !== EXPECTED_BITS_PER_SAMPLE || samples !== EXPECTED_SAMPLES_PER_PIXEL) {
      throw invalid(`unexpected sample layout ${samples}x${bits} bit`);
    }
    return { width, height, dataOffset, rowBytes: width * DECODED_BYTES_PER_PIXEL };
  } finally {
    fs.closeSync(fd);
  }
}

/** Rejects an image above the pixel cap before its pixels are read. */
export function assertWithinPixelCap(layout: DecodedTiffLayout): void {
  if (layout.width * layout.height > RAW_DECODE_MAX_PIXELS) {
    throw new RawDecodeError(
      `Decoded RAW image of ${layout.width}x${layout.height} pixels exceeds the ${RAW_DECODE_MAX_PIXELS} pixel limit`
    );
  }
}

/**
 * A RAW file cut short decodes to its full size, with the rows after the cut repeating one row
 * (the decoder reads zero deltas past the end of file). Camera images never repeat a whole row of
 * 16-bit samples across most of a window at the bottom, so such a tail marks a truncated file.
 */
export function hasRepeatedTail(filePath: string, layout: DecodedTiffLayout): boolean {
  const windowRows = Math.floor(layout.height * TAIL_WINDOW_FRACTION);
  const lastRow = layout.height - 1 - TAIL_SKIP_BORDER_ROWS;
  const firstRow = lastRow - windowRows - TAIL_ROW_PERIOD;
  if (windowRows < TAIL_MIN_PAIRS || firstRow < 0) return false;
  const fd = fs.openSync(filePath, 'r');
  try {
    const rows = Buffer.alloc((windowRows + TAIL_ROW_PERIOD) * layout.rowBytes);
    fs.readSync(fd, rows, 0, rows.length, layout.dataOffset + firstRow * layout.rowBytes);
    let repeated = 0;
    for (let row = 0; row < windowRows; row += 1) {
      const current = rows.subarray(row * layout.rowBytes, (row + 1) * layout.rowBytes);
      const next = rows.subarray((row + TAIL_ROW_PERIOD) * layout.rowBytes, (row + TAIL_ROW_PERIOD + 1) * layout.rowBytes);
      if (current.equals(next)) repeated += 1;
    }
    return repeated / windowRows >= TAIL_REPEATED_RATIO;
  } finally {
    fs.closeSync(fd);
  }
}

/** Rejects an intermediate image whose file is shorter than its header says, before it is read. */
export function assertCompleteDecodedImage(filePath: string, layout: DecodedTiffLayout): void {
  if (fs.statSync(filePath).size < layout.dataOffset + layout.height * layout.rowBytes) {
    throw invalid('the pixel data is shorter than its header declares');
  }
}
