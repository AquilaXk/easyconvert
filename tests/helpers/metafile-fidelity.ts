import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { requireOracleTool } from './differential-oracle';

/**
 * How faithfully an EMF or WMF page draws the PDF page it came from, judged by a reader other than the writer. The page is compared with
 * the picture Poppler draws of the same PDF page, after both are blurred (which absorbs the font a viewer picks and the edge pixels of a
 * thin line): the share of the pixels inked in either picture whose colour differs by more than `COLOUR_DIFFERENCE`. The older
 * acceptance (an SSIM of 0.3 after both are cut to their drawing) passes a page drawn in the wrong colour, since most of a page is white
 * (it passed 7 of the 13 wrong Illustrator and EPS files that entry 458 lists); this share is above 0.2 for each of those 13 and below
 * 0.03 for a page drawn right.
 */

const DPI = 50;
const TEXT_BLUR_SIGMA = 1.5;
/** A blurred pixel is inked when its mean channel is below this. */
const TEXT_INK_LEVEL = 235;
/** The difference of one channel, of 255, that makes two inked pixels differ. */
const TEXT_COLOUR_DIFFERENCE = 60;
const TOOL_TIMEOUT_MS = 120_000;
const INKSCAPE_TIMEOUT_MS = 90_000;
const SOFFICE_TIMEOUT_MS = 180_000;
const CHANNELS = 3;

/** Above this share of differing pixels a page is drawn wrong (the readers measured 0.2 to 0.9 on wrong pages and 0 to 0.03 on right ones). */
export const MAX_DIFFERING_SHARE = 0.1;
/**
 * The same bound for a blur wide enough (9 pixels at 50 dpi) to dissolve text, so that the font a reader picks does not count and only
 * areas do: a lost gradient, background or picture. Measured 0.2 to 0.7 on pages that lost one and under 0.15 on pages that kept all.
 */
export const MAX_FRAMED_DIFFERING_SHARE = 0.15;

export interface ComparisonOptions {
  /** Crops both pictures to what they draw first, for a reader (the office suite) whose picture is cropped to the drawing and not framed on the page. */
  cutToDrawing?: boolean;
  blurSigma?: number;
  inkLevel?: number;
  colourDifference?: number;
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metafile-fidelity-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Page `page` of a PDF as Poppler draws it at 50 dpi. */
export function pdfPagePicture(pdf: Buffer, page: number): Buffer {
  return withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    execFileSync(requireOracleTool('pdftoppm'), ['-png', '-r', String(DPI), '-f', String(page), '-l', String(page), '-singlefile', path.join(dir, 'in.pdf'), path.join(dir, 'page')], {
      timeout: TOOL_TIMEOUT_MS,
      stdio: 'ignore',
    });
    return fs.readFileSync(path.join(dir, 'page.png'));
  });
}

/** The metafile as the office suite draws it (cropped to its drawing, as the suite's PNG export is); undefined when it reads no file. */
export function officeSuitePicture(metafile: Buffer, target: string): Buffer | undefined {
  return withTempDir((dir) => {
    const input = path.join(dir, `out.${target}`);
    fs.writeFileSync(input, metafile);
    spawnSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'png', '--outdir', path.join(dir, 'o'), input], { timeout: SOFFICE_TIMEOUT_MS, stdio: 'ignore' });
    const file = path.join(dir, 'o', 'out.png');
    return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  });
}

/** The metafile as Inkscape draws it, on the frame of the file at 50 dpi; undefined when it reads no file. */
export function inkscapePicture(metafile: Buffer, target: string): Buffer | undefined {
  return withTempDir((dir) => {
    const input = path.join(dir, `input.${target}`);
    const out = path.join(dir, 'inkscape.png');
    fs.writeFileSync(input, metafile);
    spawnSync(requireOracleTool('inkscape'), [input, '--export-type=png', `--export-filename=${out}`, '-d', String(DPI)], { timeout: INKSCAPE_TIMEOUT_MS, stdio: 'ignore' });
    return fs.existsSync(out) ? fs.readFileSync(out) : undefined;
  });
}

async function cutToDrawing(image: Buffer): Promise<Buffer> {
  const flat = await sharp(image).flatten({ background: '#ffffff' }).png().toBuffer();
  return sharp(flat).trim({ background: '#ffffff', threshold: 24 }).png().toBuffer().catch(() => flat);
}

async function blurred(image: Buffer, width: number, height: number, sigma: number): Promise<Buffer> {
  return sharp(image).flatten({ background: '#ffffff' }).resize(width, height, { fit: 'fill' }).blur(sigma).removeAlpha().raw().toBuffer();
}

/** The share of the pixels inked in either picture on which `redraw` differs from `reference`. */
export async function differingShare(reference: Buffer, redraw: Buffer, options: ComparisonOptions = {}): Promise<number> {
  const { blurSigma = TEXT_BLUR_SIGMA, inkLevel = TEXT_INK_LEVEL, colourDifference = TEXT_COLOUR_DIFFERENCE } = options;
  const expected = options.cutToDrawing ? await cutToDrawing(reference) : reference;
  const actual = options.cutToDrawing ? await cutToDrawing(redraw) : redraw;
  const { width = 0, height = 0 } = await sharp(expected).metadata();
  const a = await blurred(expected, width, height, blurSigma);
  const b = await blurred(actual, width, height, blurSigma);
  let inked = 0;
  let differing = 0;
  for (let at = 0; at < width * height * CHANNELS; at += CHANNELS) {
    const inkedA = (a[at] + a[at + 1] + a[at + 2]) / CHANNELS < inkLevel;
    const inkedB = (b[at] + b[at + 1] + b[at + 2]) / CHANNELS < inkLevel;
    if (!inkedA && !inkedB) continue;
    inked++;
    if (Math.max(Math.abs(a[at] - b[at]), Math.abs(a[at + 1] - b[at + 1]), Math.abs(a[at + 2] - b[at + 2])) > colourDifference) differing++;
  }
  return inked === 0 ? 0 : differing / inked;
}
