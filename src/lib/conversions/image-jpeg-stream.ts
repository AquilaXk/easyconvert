import type { SharpOptions } from 'sharp';

/**
 * The segment structure of a JPEG stream: where it ends, where its first scan starts and how many 8x8 blocks its frame declares. A stream
 * that ends inside the entropy-coded data is decoded for the part it holds (`truncatedJpegDecodeOptions`); one that ends before the
 * first scan has no pixels.
 */

export const JPEG_SOI_MARKER = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_MARKER_PREFIX = 0xff;
const JPEG_EOI = 0xd9;
const JPEG_EOI_MARKER = Buffer.from([JPEG_MARKER_PREFIX, JPEG_EOI]);
const JPEG_SOS = 0xda;
const JPEG_TEM = 0x01;
const JPEG_RST_FIRST = 0xd0;
const JPEG_RST_LAST = 0xd7;
const JPEG_SOI = 0xd8;
const JPEG_MARKER_BYTES = 2;
const NO_OFFSET = -1;

const JPEG_SOF_FIRST = 0xc0;
const JPEG_SOF_LAST = 0xcf;
const JPEG_DHT = 0xc4;
const JPEG_JPG_EXTENSION = 0xc8;
const JPEG_DAC = 0xcc;
/** Offsets in a SOF segment from its marker: the marker (2), length (2), precision (1), height (2), width (2), component count (1), then 3 bytes per component. */
const SOF_HEIGHT_AT = 5;
const SOF_WIDTH_AT = 7;
const SOF_COMPONENT_COUNT_AT = 9;
const SOF_COMPONENTS_AT = 10;
const SOF_COMPONENT_BYTES = 3;
const SAMPLING_NIBBLE_BITS = 4;
const SAMPLING_NIBBLE_MASK = 0x0f;
const DCT_BLOCK_SIZE = 8;
const BITS_PER_BYTE = 8;

export interface JpegStreamWalk {
  /** Offset just past the EOI marker, or -1 when the stream ends without one. */
  end: number;
  /** Offset just past the first start-of-scan header, where the entropy-coded data begins, or -1 when no scan header was read in full. */
  scanStart: number;
  /** The 8x8 blocks of every component of the frame the SOF declares, or 0 when the stream holds no complete frame header. */
  frameBlocks: number;
}

function isRestartMarker(marker: number): boolean {
  return marker >= JPEG_RST_FIRST && marker <= JPEG_RST_LAST;
}

function isFrameMarker(marker: number): boolean {
  return marker >= JPEG_SOF_FIRST && marker <= JPEG_SOF_LAST && marker !== JPEG_DHT && marker !== JPEG_JPG_EXTENSION && marker !== JPEG_DAC;
}

/** The 8x8 blocks the SOF segment whose marker is at `at` declares: each component is sampled at its factors over the largest ones, and coded in whole blocks. */
function frameBlocksOf(buffer: Buffer, at: number): number {
  if (at + SOF_COMPONENTS_AT > buffer.length) return 0;
  const components = buffer[at + SOF_COMPONENT_COUNT_AT];
  if (components === 0 || at + SOF_COMPONENTS_AT + components * SOF_COMPONENT_BYTES > buffer.length) return 0;
  const width = buffer.readUInt16BE(at + SOF_WIDTH_AT);
  const height = buffer.readUInt16BE(at + SOF_HEIGHT_AT);
  const sampling: { h: number; v: number }[] = [];
  for (let component = 0; component < components; component += 1) {
    const packed = buffer[at + SOF_COMPONENTS_AT + component * SOF_COMPONENT_BYTES + 1];
    sampling.push({ h: packed >> SAMPLING_NIBBLE_BITS, v: packed & SAMPLING_NIBBLE_MASK });
  }
  const maxH = Math.max(...sampling.map(({ h }) => h));
  const maxV = Math.max(...sampling.map(({ v }) => v));
  if (maxH === 0 || maxV === 0 || sampling.some(({ h, v }) => h === 0 || v === 0)) return 0;
  let blocks = 0;
  for (const { h, v } of sampling) {
    const columns = Math.ceil(Math.ceil((width * h) / maxH) / DCT_BLOCK_SIZE);
    const rows = Math.ceil(Math.ceil((height * v) / maxV) / DCT_BLOCK_SIZE);
    blocks += columns * rows;
  }
  return blocks;
}

/** Offset of the next marker in the entropy-coded data that starts at `from` (a stuffed 0xFF00 and a restart marker belong to the data). */
function skipEntropyCodedData(buffer: Buffer, from: number): number {
  let pos = from;
  for (;;) {
    pos = buffer.indexOf(JPEG_MARKER_PREFIX, pos);
    if (pos === NO_OFFSET || pos + 1 >= buffer.length) return buffer.length;
    const next = buffer[pos + 1];
    if (next !== 0 && !isRestartMarker(next)) return pos;
    pos += JPEG_MARKER_BYTES;
  }
}

/**
 * Walks the segments of the JPEG stream that starts at `start`. Walking segments (instead of searching for the first EOI bytes)
 * keeps an Exif thumbnail nested inside an APPn segment from ending the stream early.
 */
export function walkJpegStream(buffer: Buffer, start: number): JpegStreamWalk {
  let pos = start + JPEG_MARKER_BYTES;
  let scanStart = NO_OFFSET;
  let frameBlocks = 0;
  while (pos + 1 < buffer.length) {
    if (buffer[pos] !== JPEG_MARKER_PREFIX) return { end: NO_OFFSET, scanStart, frameBlocks };
    const marker = buffer[pos + 1];
    if (marker === JPEG_MARKER_PREFIX) {
      pos += 1;
      continue;
    }
    if (marker === JPEG_EOI) return { end: pos + JPEG_MARKER_BYTES, scanStart, frameBlocks };
    if (marker === JPEG_TEM || marker === JPEG_SOI || isRestartMarker(marker)) {
      pos += JPEG_MARKER_BYTES;
      continue;
    }
    if (pos + 3 >= buffer.length) return { end: NO_OFFSET, scanStart, frameBlocks };
    const segment = pos;
    pos += JPEG_MARKER_BYTES + buffer.readUInt16BE(pos + JPEG_MARKER_BYTES);
    if (isFrameMarker(marker) && frameBlocks === 0) frameBlocks = frameBlocksOf(buffer, segment);
    if (marker === JPEG_SOS) {
      if (pos <= buffer.length && scanStart === NO_OFFSET) scanStart = pos;
      pos = skipEntropyCodedData(buffer, pos);
    }
  }
  return { end: NO_OFFSET, scanStart, frameBlocks };
}

/** Offset just past the EOI marker of the JPEG stream that starts at `start`, or -1 when the stream is truncated. */
export function findJpegEnd(buffer: Buffer, start: number): number {
  return walkJpegStream(buffer, start).end;
}

/** The fewest entropy-coded bytes a frame of `blocks` 8x8 blocks can hold: every block codes at least one bit, in any coding mode. */
export function minimumScanBytes(blocks: number): number {
  return Math.ceil(blocks / BITS_PER_BYTE);
}

/**
 * Decoder options for a JPEG that ends inside its scan data, which the reference service's decoder (libjpeg under ImageMagick) reads
 * as far as it goes and fills the rest of: libjpeg reports "Premature end of JPEG file" as a warning, not an error. The library's default
 * turns every warning into a failure, so this one case opens with `failOn: 'none'`.
 *
 * Truncated means the first scan started and no end-of-image marker follows it (a stuffed 0xFF00 keeps the marker bytes out of the scan
 * data, so a marker found there ends the stream). A complete stream keeps the default whatever its scan holds, so a corrupt file that
 * still ends with its marker is reported; a stream that ends before its first scan keeps it too, as does one whose scan holds fewer
 * bytes than one bit per block of the declared frame, which would let a few bytes stand for a full-size raster.
 */
export function truncatedJpegDecodeOptions(buffer: Buffer): SharpOptions {
  if (!buffer.subarray(0, JPEG_SOI_MARKER.length).equals(JPEG_SOI_MARKER)) return {};
  const { scanStart, frameBlocks } = walkJpegStream(buffer, 0);
  if (scanStart === NO_OFFSET || frameBlocks === 0) return {};
  if (buffer.indexOf(JPEG_EOI_MARKER, scanStart) !== NO_OFFSET) return {};
  return buffer.length - scanStart >= minimumScanBytes(frameBlocks) ? { failOn: 'none' } : {};
}
