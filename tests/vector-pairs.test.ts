import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { scoreInk, type CadTruth } from '../bench/cad-ink';
import { readRaster } from '../bench/vector-raster';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { UnsupportedOptionError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { runConvert, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { requireRealworldSample } from './helpers/realworld-sample';
import { sofficeConvert } from './helpers/soffice-convert';
import { skipWithoutTools } from './helpers/strict-skip';
import { compareImages } from './helpers/vrt-engine';

/**
 * The vector, image and CAD pairs of entry 187: Windows metafiles written as the raster formats, PostScript and SVG written as icons, Photoshop
 * files and drawing packages, DXF and DWG drawings written as BMP, GIF, TIFF and EPS, an Illustrator file written as SVG and DXF, and
 * the DXF of CorelDRAW, CGM and WMF drawings (checked on real files beside the other targets in tests/vector-sources-real-samples.test.ts).
 * Each class converts a real or authored input through the dispatcher and the output is read back by a program that is not the converter:
 * ImageMagick, `dwebp` and `avifdec` on the rasters, Ghostscript on EPS, librsvg on SVG, the office suite on the drawing package and on DXF.
 * The pairs that the entry leaves out are pinned at the end, with the refusals that justify them.
 */

const TIMEOUT_MS = 600_000;
const RENDER_DPI = 100;
/** Lowest SSIM of a raster against the picture the same route writes as PNG (the PNG is checked against the PDF page by tests/vector-sources-real-samples.test.ts). */
const MIN_SAME_PICTURE_SSIM = 0.85;
/** Lowest SSIM of a picture against another renderer's drawing of the same source (SVG: librsvg; EPS: Ghostscript). */
const MIN_OTHER_RENDERER_SSIM = 0.75;
/**
 * Formats that cannot hold the picture as it is lower the floor: an icon is at most 256 pixels on a side (measured 0.78 to 0.99 against the
 * full-size picture), a GIF has 256 colours (0.81 to 1), and WebP and AVIF are lossy (0.76 to 1 for the small picture of `tika-testemf.emf`).
 */
const FORMAT_SSIM_FLOOR: Readonly<Record<string, number>> = { ico: 0.7, gif: 0.75, webp: 0.7, avif: 0.7 };
const floorOf = (target: string, floor: number): number => Math.min(floor, FORMAT_SSIM_FLOOR[target] ?? floor);
/** The lowest ink recall and precision of a DXF drawn into a raster (the PNG of the same plates scores 0.99 to 1 on both). */
const MIN_INK_SCORE = 0.9;
const BENCH_CORPUS = path.join(__dirname, '..', 'bench', 'corpus');
/** The PostScript line of `shapes.eps` that paints the whole page white. */
const PAGE_BACKDROP = '1 1 1 setrgbcolor 0 0 400 300 rectfill\n';

const toolsMissing = skipWithoutTools('soffice', 'pdftoppm', 'pdftocairo', 'gs') || SKIP_WITHOUT_MAGICK;

function withTempDirectory<T>(run: (directory: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-pairs-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const tool = (name: Parameters<typeof getOracleToolPath>[0]): string => getOracleToolPath(name) ?? name;

/** The first picture of a raster file as a PNG, decoded by a program that is not the converter. */
function decodedPng(picture: Buffer, extension: string): Buffer {
  return withTempDirectory((directory) => {
    const file = path.join(directory, `picture.${extension}`);
    const png = path.join(directory, 'decoded.png');
    fs.writeFileSync(file, picture);
    if (extension === 'webp') execFileSync(tool('dwebp'), ['-nodither', '-quiet', file, '-o', png]);
    else if (extension === 'avif') execFileSync(tool('avifdec'), ['--ignore-icc', file, png], { stdio: 'ignore' });
    else runConvert([`${extension}:${file}[0]`, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', png]);
    return fs.readFileSync(png);
  });
}

/** An icon or other picture on a canvas larger than its drawing, cut to the drawing: the transparent border and the white border both go. */
function trimmedPng(png: Buffer): Promise<Buffer> {
  return sharp(png).flatten({ background: '#ffffff' }).trim({ background: '#ffffff', threshold: 8 }).png().toBuffer();
}

async function ssim(actual: Buffer, reference: Buffer): Promise<number> {
  const size = await sharp(reference).metadata();
  const resized = await sharp(actual).resize(size.width, size.height, { fit: 'fill' }).flatten({ background: '#ffffff' }).png().toBuffer();
  return (await compareImages(resized, await sharp(reference).flatten({ background: '#ffffff' }).png().toBuffer(), { includeDiffImage: false })).ssim;
}

async function expectDrawnPicture(png: Buffer, label: string): Promise<void> {
  const { channels } = await sharp(png).stats();
  expect(Math.max(...channels.map((channel) => channel.max - channel.min)), `${label} is one flat colour`).toBeGreaterThan(0);
}

/** The package of an `odd` output: a graphics document whose page holds the picture, read as a ZIP and drawn by the office suite. */
async function expectDrawingPackage(odd: Buffer, label: string): Promise<Buffer> {
  const archive = await JSZip.loadAsync(odd);
  expect(await archive.file('mimetype')?.async('string'), `${label} mimetype`).toBe('application/vnd.oasis.opendocument.graphics');
  const pictures = Object.keys(archive.files).filter((name) => name.startsWith('Pictures/'));
  expect(pictures.length, `${label} pictures`).toBeGreaterThan(0);
  return sofficeConvert(odd, 'out.odg', 'png', (output) => output.read());
}

/** The picture the product writes as PNG for the same input and options. */
async function pngOf(bytes: Buffer, source: string, name: string, options: Record<string, unknown> = {}): Promise<Buffer> {
  return (await dispatchConversion(bytes, source, 'png', options, name)).buffer;
}

const EMF_RASTERS = ['avif', 'bmp', 'gif', 'ico', 'odd', 'psd', 'tiff', 'webp'] as const;
const EMF_SAMPLES = ['lo-sine_wave.emf', 'lo-computer_mail.emf', 'tika-testemf.emf'] as const;

describe.skipIf(toolsMissing)('a Windows metafile written as a raster picture', () => {
  for (const id of EMF_SAMPLES) {
    it(
      `${id}: every raster draws the page the PNG draws`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const reference = await pngOf(bytes, 'emf', id);
        for (const target of EMF_RASTERS) {
          const result = await dispatchConversion(bytes, 'emf', target, {}, id);
          expect(result.engineUsed, `${id} -> ${target}`).toBe('native-poppler');
          const label = `${id} -> ${target}`;
          if (target !== 'odd') expect(result.buffer.subarray(0, 2).toString('latin1'), `${label} is one picture, not a ZIP`).not.toBe('PK');
          if (target === 'odd') {
            const drawn = await expectDrawingPackage(result.buffer, label);
            await expectDrawnPicture(drawn, label);
            continue;
          }
          const decoded = await trimmedPng(decodedPng(result.buffer, target));
          await expectDrawnPicture(decoded, label);
          expect(await ssim(decoded, await trimmedPng(reference)), `${label} against the PNG`).toBeGreaterThan(floorOf(target, MIN_SAME_PICTURE_SSIM));
        }
      },
      TIMEOUT_MS
    );
  }

  it('lo-sine_wave.emf: the axis numbers are still legible in the BMP, as Tesseract reads them', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'lo-sine_wave.emf');
    const bmp = (await dispatchConversion(bytes, 'emf', 'bmp', {}, 'sine_wave.emf')).buffer;
    const text = withTempDirectory((directory) => {
      const file = path.join(directory, 'page.png');
      fs.writeFileSync(file, decodedPng(bmp, 'bmp'));
      return execFileSync(tool('tesseract'), [file, '-', '--psm', '11'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    });
    expect(text).toMatch(/\b100\b/);
  }, TIMEOUT_MS);

  it('writes an icon no larger than the format allows, on a square canvas that holds the whole page', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'lo-sine_wave.emf');
    const icon = (await dispatchConversion(bytes, 'emf', 'ico', {}, 'sine_wave.emf')).buffer;
    expect(icon.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))).toBe(true);
    const size = icon.readUInt32LE(6 + 8);
    const offset = icon.readUInt32LE(6 + 12);
    const picture = await sharp(icon.subarray(offset, offset + size)).metadata();
    expect(Math.max(picture.width ?? 0, picture.height ?? 0)).toBeLessThanOrEqual(256);
  }, TIMEOUT_MS);
});

const SVG_SOURCES = [
  { name: 'shapes.svg', extension: 'svg' as const, read: async () => fs.readFileSync(path.join(BENCH_CORPUS, 'vector', 'shapes.svg')) },
  { name: 'okular-checkmark.svgz', extension: 'svgz' as const, read: async (ctx: { skip: () => never }) => (await requireRealworldSample(ctx, 'okular-checkmark.svgz')).bytes },
];
const RASTERS_OF_VECTOR_SOURCES = ['ico', 'odd', 'psd'] as const;

/** librsvg draws the SVG (or the SVG inside the SVGZ) at the size of the picture it is compared with. */
function drawnByLibrsvg(svg: Buffer, width: number): Buffer {
  return withTempDirectory((directory) => {
    const file = path.join(directory, 'drawing.svg');
    const png = path.join(directory, 'drawing.png');
    fs.writeFileSync(file, svg);
    execFileSync(tool('rsvg-convert'), ['--format', 'png', '--background-color', 'white', '--width', String(width), '--output', png, file]);
    return fs.readFileSync(png);
  });
}

describe.skipIf(skipWithoutTools('rsvg-convert', 'soffice') || SKIP_WITHOUT_MAGICK)('an SVG or SVGZ drawing written as an icon, a Photoshop file or a drawing package', () => {
  for (const source of SVG_SOURCES) {
    it(
      `${source.name}: the icon, the Photoshop file and the drawing package show the drawing librsvg draws`,
      async (ctx) => {
        const bytes = await source.read(ctx);
        const svg = source.extension === 'svgz' ? (await import('node:zlib')).gunzipSync(bytes) : bytes;
        for (const target of RASTERS_OF_VECTOR_SOURCES) {
          const label = `${source.name} -> ${target}`;
          const result = await dispatchConversion(bytes, source.extension, target, {}, source.name);
          if (target === 'odd') {
            await expectDrawnPicture(await expectDrawingPackage(result.buffer, label), label);
            continue;
          }
          const decoded = await trimmedPng(decodedPng(result.buffer, target));
          await expectDrawnPicture(decoded, label);
          const { width, height } = await sharp(decoded).metadata();
          const drawn = await trimmedPng(drawnByLibrsvg(svg, Math.max(width ?? 1, height ?? 1)));
          expect(await ssim(decoded, drawn), `${label} against librsvg`).toBeGreaterThan(floorOf(target, MIN_OTHER_RENDERER_SSIM));
        }
      },
      TIMEOUT_MS
    );
  }
});

const POSTSCRIPT_SAMPLES = [
  { id: 'pil-illucs6_preview.eps', extension: 'eps' as const },
  { id: 'govdocs1-005282.ps', extension: 'ps' as const },
];

/** Ghostscript draws the file, an EPS cropped to its bounding box. */
function drawnByGhostscript(source: Buffer, extension: string): Buffer {
  return withTempDirectory((directory) => {
    const file = path.join(directory, `drawing.${extension}`);
    const png = path.join(directory, 'drawing.png');
    fs.writeFileSync(file, source);
    execFileSync(tool('gs'), ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', ...(extension === 'eps' ? ['-dEPSCrop'] : []), '-sDEVICE=png16m', `-r${RENDER_DPI}`, '-dFirstPage=1', '-dLastPage=1', `-sOutputFile=${png}`, file]);
    return fs.readFileSync(png);
  });
}

describe.skipIf(toolsMissing)('a PostScript or EPS file written as an icon, a Photoshop file or a drawing package', () => {
  for (const sample of POSTSCRIPT_SAMPLES) {
    it(
      `${sample.id}: the first picture shows the page Ghostscript draws`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const drawn = await trimmedPng(drawnByGhostscript(bytes, sample.extension));
        for (const target of RASTERS_OF_VECTOR_SOURCES) {
          const label = `${sample.id} -> ${target}`;
          const result = await dispatchConversion(bytes, sample.extension, target, { multiPageOutput: 'first' }, sample.id);
          expect(result.engineUsed, label).toBe('native-poppler');
          if (target === 'odd') {
            await expectDrawnPicture(await expectDrawingPackage(result.buffer, label), label);
            continue;
          }
          const decoded = await trimmedPng(decodedPng(result.buffer, target));
          await expectDrawnPicture(decoded, label);
          expect(await ssim(decoded, drawn), `${label} against Ghostscript`).toBeGreaterThan(floorOf(target, MIN_OTHER_RENDERER_SSIM));
        }
      },
      TIMEOUT_MS
    );
  }
});

const PLATES = ['plate-basic', 'plate-full'] as const;
const DXF_RASTERS = ['bmp', 'gif', 'tiff'] as const;

const plateBytes = (plate: string): Buffer => fs.readFileSync(path.join(BENCH_CORPUS, 'cad', `${plate}.dxf`));
const plateTruth = (plate: string): CadTruth => JSON.parse(fs.readFileSync(path.join(BENCH_CORPUS, 'cad', `${plate}.truth.json`), 'utf8')) as CadTruth;

describe.skipIf(skipWithoutTools('ffmpeg', 'gs') || SKIP_WITHOUT_MAGICK)('a DXF drawing written as BMP, GIF, TIFF or EPS', () => {
  for (const plate of PLATES) {
    it(
      `${plate}.dxf: every raster and the EPS put the strokes of the drawing where the file has them`,
      async () => {
        const truth = plateTruth(plate);
        const score = (png: Buffer): ReturnType<typeof scoreInk> =>
          withTempDirectory((directory) => {
            const file = path.join(directory, 'drawn.png');
            fs.writeFileSync(file, png);
            return scoreInk(readRaster(tool('ffmpeg'), file), truth);
          });
        for (const target of [...DXF_RASTERS, 'eps'] as const) {
          const label = `${plate}.dxf -> ${target}`;
          const result = await dispatchConversion(plateBytes(plate), 'dxf', target, {}, `${plate}.dxf`);
          const picture = target === 'eps' ? drawnByGhostscript(result.buffer, 'eps') : decodedPng(result.buffer, target);
          if (target === 'eps') expect(result.buffer.subarray(0, 30).toString('latin1'), label).toMatch(/^%!PS-Adobe-[\d.]+ EPSF-/);
          const { recall, precision } = score(picture);
          expect({ label, recall: recall >= MIN_INK_SCORE, precision: precision >= MIN_INK_SCORE }).toEqual({ label, recall: true, precision: true });
        }
      },
      TIMEOUT_MS
    );
  }

  it('a DXF written as TIFF is a file the TIFF tools read, with the page size of the PNG of the same drawing', async () => {
    const tiff = (await dispatchConversion(plateBytes('plate-full'), 'dxf', 'tiff', {}, 'plate-full.dxf')).buffer;
    const png = await pngOf(plateBytes('plate-full'), 'dxf', 'plate-full.dxf');
    const [tiffSize, pngSize] = [await sharp(decodedPng(tiff, 'tiff')).metadata(), await sharp(png).metadata()];
    expect({ width: tiffSize.width, height: tiffSize.height }).toEqual({ width: pngSize.width, height: pngSize.height });
  }, TIMEOUT_MS);

  it('options that size the picture (width) apply to the new rasters as they do to the PNG', async () => {
    const gif = (await dispatchConversion(plateBytes('plate-basic'), 'dxf', 'gif', { width: 400 }, 'plate-basic.dxf')).buffer;
    expect((await sharp(decodedPng(gif, 'gif')).metadata()).width).toBe(400);
  }, TIMEOUT_MS);
});

describe.skipIf(skipWithoutTools('gs', 'pdftocairo', 'soffice', 'rsvg-convert') || SKIP_WITHOUT_MAGICK)('an Illustrator file written as SVG and DXF', () => {
  /**
   * An Illustrator file saved with PDF compatibility is a PDF with private data: the sample is the EPS of the vector family written as a PDF by
   * Ghostscript. The white rectangle that paints the page is left out: Poppler draws it as a shape 40 points wider than the page on every side, a
   * DXF holds it as an outline (no fill), and the office suite's re-import then draws that frame, which the picture of the source does not show.
   */
  function illustratorFile(): Buffer {
    return withTempDirectory((directory) => {
      const eps = path.join(directory, 'shapes.eps');
      const shapes = fs.readFileSync(path.join(BENCH_CORPUS, 'vector', 'shapes.eps'), 'latin1');
      expect(shapes).toContain(PAGE_BACKDROP);
      fs.writeFileSync(eps, shapes.replace(PAGE_BACKDROP, ''), 'latin1');
      const out = path.join(directory, 'shapes.ai');
      execFileSync(tool('gs'), ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dEPSCrop', '-sDEVICE=pdfwrite', `-sOutputFile=${out}`, eps]);
      return fs.readFileSync(out);
    });
  }

  it('an AI file to .svg is the vector page Poppler writes, which librsvg draws like the truth of the shapes', async () => {
    const ai = illustratorFile();
    const svg = (await dispatchConversion(ai, 'ai', 'svg', {}, 'shapes.ai')).buffer;
    expect(svg.toString('utf-8')).toMatch(/<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const drawn = await trimmedPng(drawnByLibrsvg(svg, 400));
    const truth = await trimmedPng(fs.readFileSync(path.join(BENCH_CORPUS, 'vector', 'shapes.truth.png')));
    expect(await ssim(drawn, truth)).toBeGreaterThan(0.9);
  }, TIMEOUT_MS);

  it('an AI file to .dxf is a drawing between the section and the end of the file that the office suite opens and draws', async () => {
    const result = await dispatchConversion(illustratorFile(), 'ai', 'dxf', {}, 'shapes.ai');
    const lines = result.buffer.toString('utf-8').trimEnd().split(/\r?\n/);
    expect(lines.slice(0, 2).map((line) => line.trim())).toEqual(['0', 'SECTION']);
    expect(lines.slice(-2).map((line) => line.trim())).toEqual(['0', 'EOF']);
    const drawn = sofficeConvert(result.buffer, 'shapes.dxf', 'png', (output) => output.read());
    await expectDrawnPicture(drawn, 'shapes.ai -> dxf');
    const source = await trimmedPng(await pngOf(illustratorFile(), 'ai', 'shapes.ai'));
    const redrawn = await trimmedPng(drawn);
    const [a, b] = [await sharp(source).metadata(), await sharp(redrawn).metadata()];
    expect(Math.abs((a.width ?? 1) / (a.height ?? 1) / ((b.width ?? 1) / (b.height ?? 1)) - 1)).toBeLessThan(0.05);
  }, TIMEOUT_MS);
});

describe('the pairs left out of entry 187 stay out of the registry', () => {
  const LEFT_OUT: Readonly<Record<string, readonly string[]>> = {
    ai: ['emf', 'wmf'],
    cdr: ['emf', 'wmf'],
    cgm: ['emf', 'wmf'],
    dwf: ['cgm', 'wmf'],
    dwg: ['cgm', 'wmf'],
    dxf: ['cgm', 'wmf'],
    emf: ['dxf', 'wmf'],
    eps: ['emf', 'wmf'],
    ps: ['emf', 'wmf'],
    sk: ['emf', 'wmf'],
    sk1: ['emf', 'wmf'],
    wmf: ['emf'],
  };

  it.each(Object.entries(LEFT_OUT))('.%s does not offer %j', (source, targets) => {
    expect(targets.filter((target) => FORMAT_REGISTRY[source].targetFormats.includes(target))).toEqual([]);
  });

  it.each(['wmf', 'cgm'])('a DXF drawing with text cannot be written as .%s: the SVG it is drawn as holds <text>, which the metafile writers refuse', async (target) => {
    const svg = (await convertVectorCad(plateBytes('plate-basic'), 'dxf', 'svg', {}, 'plate-basic.dxf')).buffer;
    expect(svg.toString('utf-8')).toContain('<text');
    const refusal = convertVectorCad(svg, 'svg', target, {}, 'plate-basic.svg');
    await expect(refusal).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(refusal).rejects.toThrow(/SVG element <text> is not supported by metafile encoders/);
  });

  it('the pairs the entry offers are in the registry', () => {
    const OFFERED: Readonly<Record<string, readonly string[]>> = {
      ai: ['dxf', 'svg'],
      cdr: ['dxf'],
      cgm: ['dxf'],
      dwg: ['bmp', 'eps', 'gif', 'tiff'],
      dxf: ['bmp', 'eps', 'gif', 'tiff'],
      emf: [...EMF_RASTERS],
      eps: [...RASTERS_OF_VECTOR_SOURCES],
      ps: [...RASTERS_OF_VECTOR_SOURCES],
      svg: [...RASTERS_OF_VECTOR_SOURCES],
      svgz: [...RASTERS_OF_VECTOR_SOURCES],
      wmf: ['dxf'],
    };
    for (const [source, targets] of Object.entries(OFFERED)) {
      expect(targets.filter((target) => !FORMAT_REGISTRY[source].targetFormats.includes(target)), source).toEqual([]);
    }
    expect(Object.values(OFFERED).flat().length).toBe(33);
  });
});

/**
 * The reader of DWG files (`dwg2dxf`) is not part of every machine, so a stand-in writes the DXF of a plate where the reader writes its own. What is
 * checked is the route: the DXF the reader writes goes through the same writers as a DXF of the request, for the new targets; the reader itself is
 * checked against AutoCAD's values by tests/cad-dwg-reader.test.ts.
 */
const OUTPUT_ARG = 'out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done';
const ANY_DWG = Buffer.concat([Buffer.from('AC1015'), Buffer.alloc(200, 1)]);

describe.skipIf(skipWithoutTools('gs') || SKIP_WITHOUT_MAGICK)('a DWG drawing is written through the DXF the reader writes', () => {
  async function withStandInReader<T>(plate: string, body: () => Promise<T>): Promise<T> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dwg-standin-'));
    const program = path.join(directory, 'dwg2dxf');
    fs.writeFileSync(program, `#!/bin/sh\n${OUTPUT_ARG}\ncp '${path.join(BENCH_CORPUS, 'cad', `${plate}.dxf`)}' "$out"\n`, { mode: 0o755 });
    const before = process.env.DWG2DXF_PATH;
    process.env.DWG2DXF_PATH = program;
    try {
      return await body();
    } finally {
      if (before === undefined) delete process.env.DWG2DXF_PATH;
      else process.env.DWG2DXF_PATH = before;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  it.each([...DXF_RASTERS, 'eps'] as const)('a DWG to .%s is the picture the DXF it holds is written as', async (target) => {
    await withStandInReader('plate-full', async () => {
      const fromDwg = (await dispatchConversion(ANY_DWG, 'dwg', target, {}, 'plate.dwg')).buffer;
      const fromDxf = (await dispatchConversion(plateBytes('plate-full'), 'dxf', target, {}, 'plate-full.dxf')).buffer;
      expect(fromDwg.equals(fromDxf)).toBe(true);
    });
  }, TIMEOUT_MS);

  it('a file that is not a DWG is refused before any picture is written, for the new targets too', async () => {
    for (const target of [...DXF_RASTERS, 'eps']) {
      await expect(dispatchConversion(Buffer.from('not a drawing at all'), 'dwg', target, {}, 'x.dwg')).rejects.toThrow(/does not start with a DWG release code/);
    }
  });
});
