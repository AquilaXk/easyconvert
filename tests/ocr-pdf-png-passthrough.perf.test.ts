import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { generateSearchablePdf } from '../src/lib/conversions/ocr';
import type { OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { magickConvert, magickDifferingPixels } from './helpers/magick-compare';
import { shownWords } from './helpers/pdf-shown-text';

/**
 * A scanned page goes into the searchable PDF as the PNG's own compressed rows, and a bitonal page as CCITT G4.
 * Every expectation comes from a standard tool reading the PDF: `qpdf --check` and `--show-object` for the image
 * dictionary and its raw stream, `pdfimages -list` and `-png` for what a viewer's decoder makes of it, and
 * ImageMagick `compare -metric AE` for the pixels against the source file. Fixtures are rendered by ImageMagick
 * with fixed seeds; the PNG chunk walker below is written here from the PNG specification.
 */

const TEST_TIMEOUT_MS = 240_000;
const PAGE_WIDTH_PX = 2550;
const PAGE_HEIGHT_PX = 2000;
const SMALL_WIDTH_PX = 600;
const SMALL_HEIGHT_PX = 400;
/** The size limit of the issue: the PDF may be this much larger than the PNG, plus the text layer. */
const MAX_SIZE_FACTOR = 1.05;
/** Assembly must take at most this share of the time of decoding and re-encoding the page. */
const MAX_TIME_SHARE = 0.5;
const TIMING_RUNS = 5;
const TOOL_BUFFER_BYTES = 256 * 1024 * 1024;
const PNG_SIGNATURE_BYTES = 8;
const CHUNK_OVERHEAD_BYTES = 12;

let work = '';

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-png-passthrough-'));
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function tool(name: 'qpdf' | 'pdfimages'): string {
  const file = getOracleToolPath(name);
  if (!file) throw new OracleToolMissingError(name, `${name} is not installed`);
  return file;
}

/** The OCR result of a page whose words are in the top left corner, in the pixels of the scan. */
function ocrResult(width: number, height: number): OcrResult {
  return {
    text: 'Invoice 42',
    confidence: 0.9,
    wordCount: 2,
    lines: ['Invoice 42'],
    imageWidth: width,
    imageHeight: height,
    lineBlocks: [
      {
        text: 'Invoice 42',
        bbox: { x: 150, y: 150, width: 400, height: 50 },
        baseline: { x0: 150, y0: 190, x1: 550, y1: 190 },
        rowHeight: 50,
        words: [
          { text: 'Invoice', bbox: { x: 150, y: 150, width: 250, height: 50 } },
          { text: '42', bbox: { x: 420, y: 150, width: 130, height: 50 } },
        ],
      },
    ],
  };
}

const fixtureCache = new Map<string, string>();

/** Renders a fixture once per run: `recipe` are the ImageMagick arguments that precede the output file. */
function fixture(name: string, recipe: string[], output: string): string {
  const file = path.join(work, `${name}.png`);
  if (!fixtureCache.has(name)) {
    magickConvert([...recipe, output.replace('@', file)]);
    fixtureCache.set(name, file);
  }
  return file;
}

/** A page of rectangles standing in for text lines. */
const TEXT_MARKS = [
  '-fill', 'black',
  '-draw', 'rectangle 150,150 900,190',
  '-draw', 'rectangle 150,230 1400,270',
  '-draw', 'rectangle 150,310 700,350',
];

/** Gradient paper with fine noise and text-like marks, 8-bit RGB: what a scanner produces. */
function rgbPage(): string {
  return fixture(
    'page-rgb',
    ['-size', `${PAGE_WIDTH_PX}x${PAGE_HEIGHT_PX}`, 'gradient:white-gray80', '-seed', '7', '-attenuate', '0.004', '+noise', 'Gaussian', ...TEXT_MARKS, '-depth', '8'],
    'PNG24:@'
  );
}

/** A 1-bit page of text-like marks, as a fax or a thresholded scan. */
function bitonalPage(): string {
  return fixture(
    'page-bitonal',
    ['-size', `${PAGE_WIDTH_PX}x${PAGE_HEIGHT_PX}`, 'xc:white', ...TEXT_MARKS, '-monochrome', '-depth', '1'],
    'PNG:@'
  );
}

/** A 1-bit page of random dots, which G4 cannot beat deflate on. */
function noisyBitonalPage(): string {
  return fixture(
    'page-bitonal-noise',
    ['-size', '800x600', 'xc:gray50', '-seed', '3', '+noise', 'Random', '-colorspace', 'Gray', '-threshold', '50%', '-monochrome', '-depth', '1'],
    'PNG:@'
  );
}

/** A two-valued page stored as 8-bit gray: bitonal pixels in a byte each. */
function bitonalGray8Page(): string {
  return fixture(
    'page-bitonal-gray8',
    ['-size', `${PAGE_WIDTH_PX}x${PAGE_HEIGHT_PX}`, 'xc:white', ...TEXT_MARKS, '-colorspace', 'Gray', '-depth', '8', '-define', 'png:bit-depth=8', '-define', 'png:color-type=0'],
    'PNG:@'
  );
}

function grayPage(): string {
  return fixture(
    'page-gray8',
    ['-size', '1200x900', 'gradient:white-gray60', '-seed', '5', '-attenuate', '0.01', '+noise', 'Gaussian', '-colorspace', 'Gray', '-depth', '8', '-define', 'png:color-type=0'],
    'PNG:@'
  );
}

/**
 * A palette page of `colors` colours. ImageMagick renders the picture; its PNG writer only stores palettes at
 * 8 bits, so the palette is quantised by libvips, which stores 16 colours at 4 bits, 4 colours at 2 bits and 2
 * at 1 bit.
 */
async function palettePage(colors: number, transparent = false): Promise<string> {
  const name = `page-palette-${colors}${transparent ? '-trns' : ''}`;
  const file = path.join(work, `${name}.png`);
  if (!fixtureCache.has(name)) {
    const rendered = path.join(work, `${name}-source.png`);
    magickConvert(['-size', `${SMALL_WIDTH_PX}x${SMALL_HEIGHT_PX}`, '-seed', '2', 'plasma:fractal', rendered]);
    const picture = transparent ? sharp(rendered).ensureAlpha(0.5) : sharp(rendered);
    fs.writeFileSync(file, await picture.png({ palette: true, colours: colors }).toBuffer());
    fixtureCache.set(name, file);
  }
  return file;
}

/** An 8-bit picture widened to 16 bits by ImageMagick (every sample is 257 times the 8-bit value). */
function deep16Page(type: 'gray' | 'rgb'): string {
  const grayArgs = type === 'gray' ? ['-colorspace', 'Gray', '-define', 'png:color-type=0'] : ['-define', 'png:color-type=2'];
  return fixture(
    `page-${type}16`,
    // Reduced to 8 bits first, so that every 16-bit sample is the 8-bit value times 257 and a decoder that keeps
    // the high byte (poppler) and one that rounds (ImageMagick) read the same pixel. The scale keeps every sample
    // below 65535: `pdfimages -png` writes the 16-bit sample 65535 of an RGB image as 0 although the PDF stream is
    // the PNG's own and `pdftoppm` renders it white, so a full-scale sample would make this oracle wrong.
    ['-size', `${SMALL_WIDTH_PX}x${SMALL_HEIGHT_PX}`, '-seed', '4', 'plasma:fractal', ...grayArgs, '-evaluate', 'Multiply', '0.9', '-depth', '8', '-define', 'png:bit-depth=16'],
    'PNG:@'
  );
}

function interlacedPage(): string {
  return fixture(
    'page-interlaced',
    ['-size', `${SMALL_WIDTH_PX}x${SMALL_HEIGHT_PX}`, '-seed', '6', 'plasma:fractal', '-interlace', 'PNG', '-define', 'png:color-type=2'],
    'PNG:@'
  );
}

/** An RGBA page whose alpha channel is half transparent everywhere, so the PDF needs a soft mask. */
async function alphaPage(): Promise<string> {
  const file = path.join(work, 'page-alpha.png');
  if (!fixtureCache.has('page-alpha')) {
    const rendered = path.join(work, 'page-alpha-source.png');
    magickConvert(['-size', `${SMALL_WIDTH_PX}x${SMALL_HEIGHT_PX}`, '-seed', '8', 'plasma:fractal', rendered]);
    fs.writeFileSync(file, await sharp(rendered).ensureAlpha(0.5).png().toBuffer());
    fixtureCache.set('page-alpha', file);
  }
  return file;
}

function jpegPage(): string {
  const file = path.join(work, 'page.jpg');
  if (!fixtureCache.has('page-jpeg')) {
    magickConvert(['-size', `${SMALL_WIDTH_PX}x${SMALL_HEIGHT_PX}`, '-seed', '9', 'plasma:fractal', '-quality', '90', file]);
    fixtureCache.set('page-jpeg', file);
  }
  return file;
}

interface PngChunk {
  type: string;
  body: Buffer;
}

/** Walks the chunks of a PNG (clause 5), trusting the file (it was written by ImageMagick). */
function chunksOf(png: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let pos = PNG_SIGNATURE_BYTES;
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    chunks.push({ type: png.toString('latin1', pos + 4, pos + 8), body: png.subarray(pos + 8, pos + 8 + length) });
    pos += CHUNK_OVERHEAD_BYTES + length;
  }
  return chunks;
}

function idatOf(png: Buffer): Buffer {
  return Buffer.concat(chunksOf(png).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.body));
}

function headerOf(png: Buffer): { width: number; height: number; bitDepth: number; colorType: number } {
  const body = chunksOf(png)[0].body;
  return { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8], colorType: body[9] };
}

async function assemble(pngFile: string): Promise<{ pdf: Buffer; file: string; png: Buffer }> {
  const png = fs.readFileSync(pngFile);
  const { width, height } = headerOf(png);
  const pdf = await generateSearchablePdf(png, ocrResult(width, height));
  const file = pngFile.replace(/\.\w+$/, '.pdf');
  fs.writeFileSync(file, pdf);
  return { pdf, file, png };
}

interface ListedImage {
  type: string;
  width: number;
  height: number;
  color: string;
  bpc: number;
  enc: string;
  object: number;
}

/** The rows of `pdfimages -list`, which names each image's colour model, encoding and object number. */
function listImages(file: string): ListedImage[] {
  const out = execFileSync(tool('pdfimages'), ['-list', file], { encoding: 'utf-8' });
  return out
    .split('\n')
    .slice(2)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const f = line.trim().split(/\s+/);
      return { type: f[2], width: Number(f[3]), height: Number(f[4]), color: f[5], bpc: Number(f[7]), enc: f[8], object: Number(f[10]) };
    });
}

function showObject(file: string, object: number): string {
  return execFileSync(tool('qpdf'), [`--show-object=${object}`, file], { encoding: 'latin1', maxBuffer: TOOL_BUFFER_BYTES });
}

function rawStream(file: string, object: number): Buffer {
  return execFileSync(tool('qpdf'), [`--show-object=${object}`, '--raw-stream-data', file], { maxBuffer: TOOL_BUFFER_BYTES });
}

function qpdfCheckPasses(file: string): boolean {
  const out = execFileSync(tool('qpdf'), ['--check', file], { encoding: 'utf-8' });
  return out.includes('No syntax or stream encoding errors found');
}

/** What a decoder makes of the page: `pdfimages -png` output, compared pixel for pixel with the source file. */
function differingPixelsAfterDecode(pdfFile: string, sourcePng: string): number {
  const prefix = path.join(work, `decoded-${path.basename(pdfFile, '.pdf')}`);
  execFileSync(tool('pdfimages'), ['-png', pdfFile, prefix]);
  return magickDifferingPixels(sourcePng, `${prefix}-000.png`);
}

/** The bytes of the PDF that are not the image: the same text layer over a one-pixel page. */
async function textLayerBytes(): Promise<number> {
  const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
  return (await generateSearchablePdf(tiny, ocrResult(1, 1))).length;
}

describe('PNG pages embedded without re-compression', () => {
  oracleTest('an RGB page keeps its IDAT bytes as a FlateDecode stream with a PNG predictor', ['qpdf', 'pdfimages'], async () => {
    const { file, png } = await assemble(rgbPage());
    const [image] = listImages(file);
    expect(image).toMatchObject({ type: 'image', width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX, color: 'rgb', bpc: 8 });
    const dictionary = showObject(file, image.object);
    expect(dictionary).toMatch(/\/Filter \/FlateDecode/);
    expect(dictionary).toMatch(/\/ColorSpace \/DeviceRGB/);
    expect(dictionary).toMatch(/\/DecodeParms << \/BitsPerComponent 8 \/Colors 3 \/Columns 2550 \/Predictor 15 >>/);
    expect(rawStream(file, image.object).equals(idatOf(png))).toBe(true);
  }, TEST_TIMEOUT_MS);

  oracleTest('the decoded RGB page matches the source pixel for pixel, and qpdf accepts the file', ['qpdf', 'pdfimages'], async () => {
    const source = rgbPage();
    const { file } = await assemble(source);
    expect(qpdfCheckPasses(file)).toBe(true);
    expect(differingPixelsAfterDecode(file, source)).toBe(0);
  }, TEST_TIMEOUT_MS);

  oracleTest('the PDF is at most 1.05x the PNG plus the text layer, for every kind of page', ['qpdf', 'pdfimages'], async () => {
    const layer = await textLayerBytes();
    const pages = [rgbPage(), grayPage(), bitonalPage(), bitonalGray8Page(), await palettePage(16), await palettePage(4), await palettePage(200)];
    for (const page of pages) {
      const { pdf, png } = await assemble(page);
      const { colorType, bitDepth } = headerOf(png);
      expect(pdf.length, `${path.basename(page)} (colour type ${colorType}, depth ${bitDepth})`).toBeLessThanOrEqual(png.length * MAX_SIZE_FACTOR + layer);
    }
  }, TEST_TIMEOUT_MS);

  oracleTest('assembly takes at most half the time of decoding and re-encoding the page', ['qpdf'], async () => {
    const source = rgbPage();
    const png = fs.readFileSync(source);
    const result = ocrResult(PAGE_WIDTH_PX, PAGE_HEIGHT_PX);
    const best = async (run: () => Promise<unknown>): Promise<number> => {
      let fastest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < TIMING_RUNS; i++) {
        const started = performance.now();
        await run();
        fastest = Math.min(fastest, performance.now() - started);
      }
      return fastest;
    };
    // The reference is the library's own decode and re-encode of the PNG, which is what the page cost before.
    const reencode = await best(async () => {
      const doc = await PDFDocument.create();
      const image = await doc.embedPng(png);
      doc.addPage([PAGE_WIDTH_PX, PAGE_HEIGHT_PX]).drawImage(image, { x: 0, y: 0 });
      return doc.save();
    });
    const passthrough = await best(() => generateSearchablePdf(png, result));
    expect(passthrough).toBeLessThanOrEqual(reencode * MAX_TIME_SHARE);
  }, TEST_TIMEOUT_MS);

  oracleTest('the text layer is still on the page beside the passed-through image', ['qpdf'], async () => {
    const { pdf } = await assemble(rgbPage());
    expect(shownWords(await PDFDocument.load(pdf))).toEqual(['Invoice', '42']);
  }, TEST_TIMEOUT_MS);

  oracleTest('gray, palette and 16-bit pages pass through with their own colour model and depth', ['qpdf', 'pdfimages'], async () => {
    const cases: Array<{ source: string; color: string; bpc: number; space: RegExp; parms: RegExp }> = [
      { source: grayPage(), color: 'gray', bpc: 8, space: /\/ColorSpace \/DeviceGray/, parms: /\/Colors 1 .*\/Predictor 15/ },
      { source: await palettePage(200), color: 'index', bpc: 8, space: /\/ColorSpace \[ \/Indexed \/DeviceRGB \d+ \d+ 0 R \]/, parms: /\/BitsPerComponent 8 \/Colors 1/ },
      { source: await palettePage(16), color: 'index', bpc: 4, space: /\/ColorSpace \[ \/Indexed \/DeviceRGB 15 \d+ 0 R \]/, parms: /\/BitsPerComponent 4 \/Colors 1/ },
      { source: await palettePage(4), color: 'index', bpc: 2, space: /\/ColorSpace \[ \/Indexed \/DeviceRGB 3 \d+ 0 R \]/, parms: /\/BitsPerComponent 2 \/Colors 1/ },
      { source: deep16Page('gray'), color: 'gray', bpc: 16, space: /\/ColorSpace \/DeviceGray/, parms: /\/BitsPerComponent 16 \/Colors 1/ },
      { source: deep16Page('rgb'), color: 'rgb', bpc: 16, space: /\/ColorSpace \/DeviceRGB/, parms: /\/BitsPerComponent 16 \/Colors 3/ },
    ];
    for (const { source, color, bpc, space, parms } of cases) {
      const { file, png } = await assemble(source);
      const [image] = listImages(file);
      const label = `${path.basename(source)} as ${color} ${bpc}-bit`;
      expect(image, label).toMatchObject({ color, bpc });
      const dictionary = showObject(file, image.object);
      expect(dictionary, label).toMatch(space);
      expect(dictionary, label).toMatch(parms);
      expect(rawStream(file, image.object).equals(idatOf(png)), label).toBe(true);
      expect(qpdfCheckPasses(file), label).toBe(true);
      expect(differingPixelsAfterDecode(file, source), label).toBe(0);
    }
  }, TEST_TIMEOUT_MS);

  oracleTest('an ICC profile in the PNG becomes an ICCBased colour space with the same profile bytes', ['qpdf', 'pdfimages'], async () => {
    const plain = rgbPage();
    const tagged = path.join(work, 'page-icc.png');
    fs.writeFileSync(tagged, await sharp(plain).resize(SMALL_WIDTH_PX).withIccProfile('srgb').png().toBuffer());
    const { file, png } = await assemble(tagged);
    const profile = chunksOf(png).find((chunk) => chunk.type === 'iCCP');
    expect(profile).toBeDefined();
    const [image] = listImages(file);
    const dictionary = showObject(file, image.object);
    const space = /\/ColorSpace \[ \/ICCBased (\d+) 0 R \]/.exec(dictionary);
    expect(space).not.toBeNull();
    const iccObject = Number((space as RegExpExecArray)[1]);
    expect(showObject(file, iccObject)).toMatch(/\/Alternate \/DeviceRGB.*\/Filter \/FlateDecode.*\/N 3|\/N 3.*\/Alternate \/DeviceRGB/s);
    // The chunk is a profile name, a NUL, a compression method byte and then the zlib stream that PDF reads as Flate.
    const nameEnd = (profile as PngChunk).body.indexOf(0);
    expect(rawStream(file, iccObject).equals((profile as PngChunk).body.subarray(nameEnd + 2))).toBe(true);
    expect(qpdfCheckPasses(file)).toBe(true);
    expect(differingPixelsAfterDecode(file, tagged)).toBe(0);
  }, TEST_TIMEOUT_MS);

  oracleTest('interlaced, alpha and transparent-palette pages are decoded and still come out right', ['qpdf', 'pdfimages'], async () => {
    const transparentPalette = await palettePage(8, true);
    expect(chunksOf(fs.readFileSync(transparentPalette)).some((chunk) => chunk.type === 'tRNS')).toBe(true);
    for (const source of [interlacedPage(), await alphaPage(), transparentPalette]) {
      const { file, png } = await assemble(source);
      const images = listImages(file);
      // The decoding path leaves the compressed rows unrecognisable, and an alpha channel becomes a soft mask.
      const colorImage = images.find((image) => image.type === 'image') as ListedImage;
      expect(rawStream(file, colorImage.object).equals(idatOf(png)), path.basename(source)).toBe(false);
      expect(qpdfCheckPasses(file), path.basename(source)).toBe(true);
      if (headerOf(png).colorType === 6 || chunksOf(png).some((chunk) => chunk.type === 'tRNS')) {
        expect(images.some((image) => image.type === 'smask'), path.basename(source)).toBe(true);
      }
    }
  }, TEST_TIMEOUT_MS);
});

describe('bitonal pages as CCITT Group 4', () => {
  oracleTest('a 1-bit page is a CCITTFaxDecode stream with K -1 that decodes to the source pixels', ['qpdf', 'pdfimages'], async () => {
    const source = bitonalPage();
    const { file, png } = await assemble(source);
    expect(headerOf(png)).toMatchObject({ bitDepth: 1, colorType: 0 });
    const [image] = listImages(file);
    expect(image).toMatchObject({ type: 'image', width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX, bpc: 1, enc: 'ccitt' });
    const dictionary = showObject(file, image.object);
    expect(dictionary).toMatch(/\/Filter \/CCITTFaxDecode/);
    expect(dictionary).toMatch(/\/DecodeParms << \/Columns 2550 \/K -1 \/Rows 2000 >>/);
    expect(dictionary).toMatch(/\/ColorSpace \/DeviceGray/);
    expect(qpdfCheckPasses(file)).toBe(true);
    expect(differingPixelsAfterDecode(file, source)).toBe(0);
    // Group 4 is smaller than the deflated rows it replaced.
    expect(rawStream(file, image.object).length).toBeLessThan(idatOf(png).length);
  }, TEST_TIMEOUT_MS);

  oracleTest('an 8-bit page that only has black and white is coded as CCITT G4 as well', ['qpdf', 'pdfimages'], async () => {
    const source = bitonalGray8Page();
    const { file, png } = await assemble(source);
    expect(headerOf(png)).toMatchObject({ bitDepth: 8, colorType: 0 });
    const [image] = listImages(file);
    expect(image).toMatchObject({ bpc: 1, enc: 'ccitt' });
    expect(qpdfCheckPasses(file)).toBe(true);
    expect(differingPixelsAfterDecode(file, source)).toBe(0);
  }, TEST_TIMEOUT_MS);

  oracleTest('a 1-bit page of random dots stays deflate, which is shorter there', ['qpdf', 'pdfimages'], async () => {
    const source = noisyBitonalPage();
    const { file, png } = await assemble(source);
    expect(headerOf(png)).toMatchObject({ bitDepth: 1, colorType: 0 });
    const [image] = listImages(file);
    expect(image.enc).toBe('image');
    expect(showObject(file, image.object)).toMatch(/\/Filter \/FlateDecode/);
    expect(rawStream(file, image.object).equals(idatOf(png))).toBe(true);
    expect(differingPixelsAfterDecode(file, source)).toBe(0);
  }, TEST_TIMEOUT_MS);

  oracleTest('a gray page with more than two values is not coded as CCITT', ['qpdf', 'pdfimages'], async () => {
    const { file } = await assemble(grayPage());
    expect(listImages(file)[0].enc).toBe('image');
  }, TEST_TIMEOUT_MS);

  oracleTest('1-bit pages of odd widths decode to the source (row padding)', ['qpdf', 'pdfimages'], async () => {
    for (const width of [1, 7, 9, 63, 65, 1001]) {
      const source = fixture(
        `page-bitonal-w${width}`,
        ['-size', `${width}x40`, 'xc:white', '-fill', 'black', '-draw', `rectangle ${Math.floor(width / 3)},5 ${Math.floor(width / 2)},30`, '-monochrome', '-depth', '1'],
        'PNG:@'
      );
      const { file } = await assemble(source);
      expect(qpdfCheckPasses(file), `width ${width}`).toBe(true);
      expect(differingPixelsAfterDecode(file, source), `width ${width}`).toBe(0);
    }
  }, TEST_TIMEOUT_MS);
});

describe('JPEG pages', () => {
  oracleTest('a JPEG page keeps its file bytes as a DCTDecode stream', ['qpdf', 'pdfimages'], async () => {
    const source = jpegPage();
    const jpeg = fs.readFileSync(source);
    const result = ocrResult(SMALL_WIDTH_PX, SMALL_HEIGHT_PX);
    const file = path.join(work, 'jpeg.pdf');
    fs.writeFileSync(file, await generateSearchablePdf(jpeg, result));
    const [image] = listImages(file);
    expect(image.enc).toBe('jpeg');
    expect(showObject(file, image.object)).toMatch(/\/Filter \/DCTDecode/);
    expect(rawStream(file, image.object).equals(jpeg)).toBe(true);
    expect(qpdfCheckPasses(file)).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('an unusable PNG', () => {
  it('is refused with a typed error and not embedded as an empty page', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const truncated = png.subarray(0, png.length - 20);
    await expect(generateSearchablePdf(truncated, ocrResult(8, 8))).rejects.toMatchObject({
      name: 'CorruptStreamError',
      status: 400,
    });
  });
});
