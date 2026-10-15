import fs from 'node:fs';
import path from 'node:path';
import { OutputIntegrityError } from './errors';
import { runTool } from './tools';

/**
 * Rendering of vector outputs to pixels with reference tools, for the vector and CAD families: librsvg for SVG,
 * Poppler for PDF pages and the office suite for metafiles. Pixels are read back with ffmpeg, so none of this touches
 * the conversion engines.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_HEADER_BYTES = 24;
const BYTE_MAX = 255;
const RGBA_CHANNELS = 4;
const POINTS_PER_INCH = 72;

export interface Raster {
  width: number;
  height: number;
  /** 8-bit RGB, three bytes per pixel, alpha composited on white. */
  rgb: Buffer;
}

/** Width and height of a PNG file from its header. */
export function pngSize(file: string): { width: number; height: number } {
  const head = Buffer.alloc(PNG_HEADER_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, PNG_HEADER_BYTES, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new OutputIntegrityError(`${path.basename(file)} is not a PNG file`);
  return { width: head.readUInt32BE(PNG_IHDR_WIDTH_OFFSET), height: head.readUInt32BE(PNG_IHDR_WIDTH_OFFSET + 4) };
}

/** An SVG drawn by librsvg `width` pixels wide at its aspect ratio on a white page. */
export function renderSvg(rsvg: string, svg: string, png: string, width: number): string {
  runTool(rsvg, ['--format', 'png', '--background-color', 'white', '--width', String(width), '--output', png, svg]);
  return png;
}

/** The first page of a PDF drawn by Poppler `width` pixels wide at the page's aspect ratio. */
export function renderPdfPage(pdftoppm: string, pdf: string, png: string, width: number): string {
  const stem = png.replace(/\.png$/, '');
  runTool(pdftoppm, ['-png', '-singlefile', '-f', '1', '-l', '1', '-r', String(POINTS_PER_INCH), '-scale-to-x', String(width), '-scale-to-y', '-1', pdf, stem]);
  if (!fs.existsSync(png)) throw new OutputIntegrityError(`pdftoppm wrote no picture for ${path.basename(pdf)}`);
  return png;
}

/** A PNG cropped to the box of everything that is not the corner colour and resized to the given size, ignoring aspect ratio. */
export function cropToContent(magick: string, input: string, output: string, width: number, height: number): string {
  runTool(magick, [input, '-background', 'white', '-alpha', 'remove', '-trim', '+repage', '-resize', `${width}x${height}!`, output]);
  return output;
}

/** The pixels of an image file, transparent areas composited on white. */
export function readRaster(ffmpeg: string, file: string, size = pngSize(file)): Raster {
  const raw = runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']).stdout;
  const pixels = size.width * size.height;
  if (raw.length !== pixels * RGBA_CHANNELS) throw new OutputIntegrityError(`${path.basename(file)} decoded to ${raw.length} bytes, expected ${pixels * RGBA_CHANNELS}`);
  const rgb = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    const alpha = raw[i * RGBA_CHANNELS + 3] / BYTE_MAX;
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(raw[i * RGBA_CHANNELS + c] * alpha + BYTE_MAX * (1 - alpha));
  }
  return { width: size.width, height: size.height, rgb };
}
