import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireOracleTool } from './differential-oracle';

/**
 * The interpreter as a PostScript oracle: draws every page of a program to 8-bit RGB pixels at 72 dpi, so that one point is one
 * pixel and a page that holds a picture at one pixel to the point comes back sample for sample. The expected pixels of a test
 * come from another decoder of the source picture, never from the converter under test.
 */

const RENDER_TIMEOUT_MS = 120_000;
const MAX_RENDER_OUTPUT_BYTES = 1024 * 1024;

export interface RenderedPage {
  width: number;
  height: number;
  /** Interleaved 8-bit R,G,B samples, row-major, top row first. */
  rgb: Buffer;
}

const PPM_HEADER_BYTES = 128;
const RGB_CHANNELS = 3;

/** A binary PPM (P6, maxval 255, after the comment line the interpreter writes): the size from its header and the samples after it. */
function readPpm(bytes: Buffer): RenderedPage {
  const header = /^P6\s+(?:#[^\n]*\n\s*)?(\d+)\s+(\d+)\s+255\s/.exec(bytes.subarray(0, PPM_HEADER_BYTES).toString('latin1'));
  if (header === null) throw new Error('the interpreter wrote a page that is not an 8-bit PPM');
  const width = Number(header[1]);
  const height = Number(header[2]);
  const rgb = bytes.subarray(header[0].length);
  if (rgb.length !== width * height * RGB_CHANNELS) throw new Error(`the PPM page holds ${rgb.length} sample bytes for ${width} x ${height}`);
  return { width, height, rgb };
}

/** The pages `program` draws, in order. The default page size of the interpreter applies where the program sets none. */
export function renderPostscriptPages(program: Buffer, extraArguments: readonly string[] = []): RenderedPage[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-pages-'));
  try {
    const input = path.join(dir, 'in.ps');
    fs.writeFileSync(input, program);
    execFileSync(
      requireOracleTool('gs'),
      ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-sDEVICE=ppmraw', '-r72', '-dTextAlphaBits=1', '-dGraphicsAlphaBits=1', ...extraArguments, `-sOutputFile=${path.join(dir, 'page-%d.ppm')}`, input],
      { timeout: RENDER_TIMEOUT_MS, maxBuffer: MAX_RENDER_OUTPUT_BYTES, stdio: 'pipe' }
    );
    const pages = fs.readdirSync(dir).filter((name) => name.endsWith('.ppm'));
    return pages
      .map((name) => ({ name, number: Number(/page-(\d+)\.ppm/.exec(name)?.[1]) }))
      .sort((a, b) => a.number - b.number)
      .map((page) => readPpm(fs.readFileSync(path.join(dir, page.name))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const RGBA_CHANNELS = 4;

/** The colour samples of 8-bit RGBA pixels (a decoder's output), without the alpha channel. */
export function rgbOfRgba(rgba: Buffer): Buffer {
  const pixels = rgba.length / RGBA_CHANNELS;
  const rgb = Buffer.alloc(pixels * RGB_CHANNELS);
  for (let pixel = 0; pixel < pixels; pixel += 1) rgba.copy(rgb, pixel * RGB_CHANNELS, pixel * RGBA_CHANNELS, pixel * RGBA_CHANNELS + RGB_CHANNELS);
  return rgb;
}

/** How many samples of the drawn page differ from the expected RGB samples of the same size. */
export function differingSamples(drawn: RenderedPage, expectedRgb: Buffer): number {
  if (drawn.rgb.length !== expectedRgb.length) throw new Error(`the page holds ${drawn.rgb.length} sample bytes, the expected picture ${expectedRgb.length}`);
  let differing = 0;
  for (let sample = 0; sample < expectedRgb.length; sample += 1) if (drawn.rgb[sample] !== expectedRgb[sample]) differing += 1;
  return differing;
}
