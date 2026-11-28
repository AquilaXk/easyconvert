import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { runPdfTextJob } from '../src/lib/conversions/pdf-text-geometry';
import { readDxf } from './helpers/dxf-reader';
import { PicturePages } from '../src/lib/conversions/vector-dxf';
import { isSvgPageTarget, svgPageEncoder } from '../src/worker/svg-page-encoders';
import { withPageNumbers } from '../src/worker/worker-output';
import { skipWithoutTools } from './helpers/strict-skip';
import { UnsupportedOptionError } from '../src/lib/types';
import type { WorkerConversionResult } from '../src/worker/worker-types';

vi.mock('../src/lib/conversions/pdf-text-geometry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/conversions/pdf-text-geometry')>()),
  runPdfTextJob: vi.fn(),
}));

/**
 * The writers behind the SVG-page targets (CGM, DXF, EMF, WMF) are the ones the PDF chain calls for a Visio drawing, so each
 * must write the file signature its format specification names; a table that paired a target with the wrong writer would
 * otherwise hand out a file of another format under the right name.
 */

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><polygon points="10,10 90,20 40,80" fill="#ff0000"/></svg>';
const EMF_SIGNATURE = 0x464d4520;
const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const WMF_STANDARD_HEADER_WORDS = 9;
/** A one-page render: the page draws no bitmap-font text, so its PDF is never read. */
const RENDERED = { filename: 'drawing.svg' } as WorkerConversionResult;

function write(target: string): Promise<Buffer> {
  return svgPageEncoder(target, RENDERED, () => undefined, {}, new PicturePages())(Buffer.from(SVG), RENDERED.filename);
}

describe('the writers of the SVG-page targets', () => {
  it.each(['cgm', 'dxf', 'emf', 'wmf'])('.%s is a target written from the SVG page', (target) => {
    expect(isSvgPageTarget(target)).toBe(true);
  });

  it.each(['png', 'svg', 'pdf', 'eps', 'toString', '__proto__'])('.%s is not', (target) => {
    expect(isSvgPageTarget(target)).toBe(false);
  });

  it('EMF: the header record is type 1 and holds the signature of the format at byte 40', async () => {
    const emf = await write('emf');
    expect(emf.readUInt32LE(0)).toBe(1);
    expect(emf.readUInt32LE(40)).toBe(EMF_SIGNATURE);
    expect(emf.readUInt32LE(48)).toBe(emf.length);
  });

  it('WMF: an Aldus placeable header, or the standard header of nine words', async () => {
    const wmf = await write('wmf');
    const header = wmf.readUInt32LE(0) === WMF_PLACEABLE_KEY ? 22 : 0;
    expect(wmf.readUInt16LE(header + 2)).toBe(WMF_STANDARD_HEADER_WORDS);
    expect([1, 2]).toContain(wmf.readUInt16LE(header));
  });

  it('CGM: a binary metafile opens with BEGIN METAFILE and closes with END METAFILE, and its name is not the text layer reader', async () => {
    const cgm = await write('cgm');
    expect(cgm.readUInt16BE(0) >> 5).toBe(1);
    expect(cgm.readUInt16BE(cgm.length - 2)).toBe(2 << 5);
    expect(cgm.indexOf(Buffer.from('drawing'))).toBe(3);
  });

  it('DXF: a SECTION record opens the file and an EOF record closes it', async () => {
    const dxf = (await write('dxf')).toString('utf-8');
    expect(dxf).toMatch(/^\s*0\nSECTION\n/);
    expect(dxf).toMatch(/\n\s*0\nEOF\s*$/);
  });

  it('each target has a writer of its own', async () => {
    const outputs = await Promise.all(['cgm', 'dxf', 'emf', 'wmf'].map(async (target) => (await write(target)).subarray(0, 48).toString('hex')));
    expect(new Set(outputs).size).toBe(4);
  });
});

describe('the size of the page that Poppler drew', () => {
  const LETTER_MM = [(612 * 25.4) / 72, (792 * 25.4) / 72];
  const FORMS = {
    // Poppler 25.02 and later (and cairo before 1.17.6) write the unit of the document.
    'points (Poppler 25.02 and later)': 'width="612pt" height="792pt"',
    // Poppler 24 on cairo 1.17.6 and later (Ubuntu noble) writes the user units of cairo, which are points, without a unit.
    'no unit (Poppler before 25.02)': 'width="612" height="792"',
  };
  const page = (size: string): Buffer =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 612 792"><path d="M 72 72 L 540 72 L 306 720 Z" fill="#ff0000"/></svg>`);
  /** The frame of the EMF header (rclFrame, 0.01 mm), in millimetres. */
  const emfFrame = (emf: Buffer): number[] => [(emf.readInt32LE(32) - emf.readInt32LE(24)) / 100, (emf.readInt32LE(36) - emf.readInt32LE(28)) / 100];

  it.each(Object.entries(FORMS))('EMF: a page of 612 x 792 points is 215.9 x 279.4 mm with %s', async (_form, size) => {
    const emf = await svgPageEncoder('emf', RENDERED, () => undefined, {}, new PicturePages())(page(size), RENDERED.filename);
    const [width, height] = emfFrame(emf);
    expect(width).toBeCloseTo(LETTER_MM[0], 0);
    expect(height).toBeCloseTo(LETTER_MM[1], 0);
  });

  it.each(Object.entries(FORMS))('WMF: a page of 612 x 792 points has the same logical size with %s', async (_form, size) => {
    const reference = await svgPageEncoder('wmf', RENDERED, () => undefined, {}, new PicturePages())(page(FORMS['points (Poppler 25.02 and later)']), RENDERED.filename);
    const wmf = await svgPageEncoder('wmf', RENDERED, () => undefined, {}, new PicturePages())(page(size), RENDERED.filename);
    expect(wmf.equals(reference)).toBe(true);
  });

  it('a page whose root names no viewBox keeps the size the SVG states', async () => {
    const emf = await write('emf');
    expect(emfFrame(emf)[0]).toBeCloseTo((100 * 25.4) / 96, 0);
  });
});

describe('the text layer of a PDF, for the pages of one render', () => {
  const PAGES = 24;
  const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==';
  /** A page with one bitmap-font character, which the DXF writer sets as TEXT from the text layer. */
  const BITMAP_PAGE =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="612" height="792" viewBox="0 0 612 792"><defs>' +
    `<image id="source-0" x="0" y="0" width="1" height="1" xlink:href="${PIXEL}"/><mask id="m"><use xlink:href="#source-0"/></mask>` +
    '<g id="g-H"><rect x="0" y="0" width="25" height="33.33" mask="url(#m)" transform="matrix(0.24, 0, 0, 0.24, 0, -8)"/></g>' +
    '</defs><use xlink:href="#g-H" x="72" y="90"/></svg>';

  it('is read in one job for every page of the render, not once per page', async () => {
    const layer = { width: 612, height: 792, items: [{ text: 'H', x: 72, baseline: 90, width: 6, size: 0.24, font: 0, rtl: false, angled: false, vertical: false }] };
    const job = vi.mocked(runPdfTextJob);
    job.mockReset();
    job.mockResolvedValue({ content: Array.from({ length: PAGES }, (_, index) => ({ pageNumber: index + 1, ...layer })) } as Awaited<ReturnType<typeof runPdfTextJob>>);
    const rendered = withPageNumbers({ filename: 'doc.zip' } as WorkerConversionResult, Array.from({ length: PAGES }, (_, index) => index + 1));
    const readPdf = vi.fn(() => Buffer.from('%PDF-'));
    const encode = svgPageEncoder('dxf', rendered, readPdf, {}, new PicturePages());

    const pages = await Promise.all(Array.from({ length: PAGES }, (_, index) => encode(Buffer.from(BITMAP_PAGE), `doc-p${String(index + 1).padStart(3, '0')}.svg`)));

    expect(pages.every((page) => readDxf(page.toString('utf-8')).texts.length === 1)).toBe(true);
    expect(job).toHaveBeenCalledTimes(1);
    expect(readPdf).toHaveBeenCalledTimes(1);
    expect(job.mock.calls[0][1]).toMatchObject({ geometry: 'none', content: Array.from({ length: PAGES }, (_, index) => index + 1) });
  });
});

/**
 * A page that the in-process EMF and WMF writers refuse as a whole (nothing to draw, a bitmap-font character) goes to the office suite as a
 * one-page PDF; the pages the in-process writer writes do not, and a page with a Type 3 font is refused as before because the PDF import
 * of the office suite drops the glyphs of such a font. The office suite is a stand-in here; tests/office-metafile-real-samples.test.ts runs it.
 * Where the worker gives it Poppler's picture of the page (`pageRaster`), a picture, a mask or a gradient is a bitmap record in the page and
 * the office suite is not asked (entry 459).
 */
describe.skipIf(skipWithoutTools('qpdf'))('an EMF or WMF page the in-process writer refuses', () => {
  const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==';
  const PICTURE_PAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image width="10" height="10" href="${PIXEL}"/></svg>`;
  const WRITTEN = Buffer.from('written by the office suite');

  async function pdfOfPages(pages: number, type3 = false): Promise<Buffer> {
    const document = await PDFDocument.create();
    for (let page = 0; page < pages; page++) document.addPage([200, 200]);
    if (type3) {
      const font = document.context.register(document.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type3') }));
      document.getPage(0).node.set(PDFName.of('Resources'), document.context.obj({ Font: { F1: font } }));
    }
    return Buffer.from(await document.save());
  }

  const encoder = (target: string, pdf: Buffer, pages: number, officeSuite: (page: Buffer, target: string) => Promise<Buffer>) =>
    svgPageEncoder(target, withPageNumbers({ filename: 'doc.zip' } as WorkerConversionResult, Array.from({ length: pages }, (_, index) => index + 1)), () => pdf, {}, new PicturePages(), { officeSuite });

  it('is written by the office suite from the one page of the PDF it came from', async () => {
    const run = vi.fn(async () => Buffer.from('ignored'));
    run.mockResolvedValue(Buffer.from([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00, ...new Array(32).fill(0), 0x20, 0x45, 0x4d, 0x46, 0, 0, 0, 0]));
    const pdf = await pdfOfPages(3);
    const written = await encoder('emf', pdf, 3, run)(Buffer.from(PICTURE_PAGE), 'doc-p002.svg');
    expect(written.readUInt32LE(40)).toBe(EMF_SIGNATURE);
    expect(run).toHaveBeenCalledTimes(1);
    const [handed, target] = run.mock.calls[0] as unknown as [Buffer, string];
    expect(target).toBe('emf');
    expect((await PDFDocument.load(handed)).getPageCount()).toBe(1);
  });

  it('is refused when the office suite writes no file of the target format', async () => {
    const pdf = await pdfOfPages(1);
    await expect(encoder('wmf', pdf, 1, async () => WRITTEN)(Buffer.from(PICTURE_PAGE), 'doc-p001.svg')).rejects.toThrow(/wrote no \.wmf file/);
  });

  it('is refused as before when the page holds a Type 3 font, and the office suite is not asked', async () => {
    const run = vi.fn(async () => WRITTEN);
    const pdf = await pdfOfPages(1, true);
    await expect(encoder('emf', pdf, 1, run)(Buffer.from(PICTURE_PAGE), 'doc-p001.svg')).rejects.toBeInstanceOf(UnsupportedOptionError);
    expect(run).not.toHaveBeenCalled();
  });

  it('is not asked for a page the in-process writer writes, nor for a DXF page', async () => {
    const run = vi.fn(async () => WRITTEN);
    const pdf = await pdfOfPages(1);
    const written = await encoder('emf', pdf, 1, run)(Buffer.from(SVG), 'doc-p001.svg');
    expect(written.readUInt32LE(40)).toBe(EMF_SIGNATURE);
    await encoder('dxf', pdf, 1, run)(Buffer.from(PICTURE_PAGE), 'doc-p001.svg').catch(() => undefined);
    expect(run).not.toHaveBeenCalled();
  });
  const PNG_OF_PAGE = async (_page: number, dpi: number): Promise<Buffer> =>
    (await import('sharp')).default({ create: { width: Math.round((100 * dpi) / 96), height: Math.round((100 * dpi) / 96), channels: 3, background: '#808080' } }).png().toBuffer();
  const encoderWithPictures = (target: string, pdf: Buffer, officeSuite: (page: Buffer, target: string) => Promise<Buffer>, pageRaster = PNG_OF_PAGE) =>
    svgPageEncoder(target, withPageNumbers({ filename: 'doc.zip' } as WorkerConversionResult, [1]), () => pdf, {}, new PicturePages(), { officeSuite, pageRaster });

  it('is written in process with a bitmap record for the picture, and the office suite is not asked', async () => {
    const run = vi.fn(async () => WRITTEN);
    const pdf = await pdfOfPages(1);
    for (const target of ['emf', 'wmf']) {
      const written = await encoderWithPictures(target, pdf, run)(Buffer.from(PICTURE_PAGE), 'doc-p001.svg');
      expect(target === 'emf' ? written.readUInt32LE(40) : written.readUInt32LE(0)).toBe(target === 'emf' ? EMF_SIGNATURE : WMF_PLACEABLE_KEY);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('still goes to the office suite when the page is refused as a whole: a page with nothing to draw', async () => {
    const run = vi.fn(async () => Buffer.from([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00, ...new Array(32).fill(0), 0x20, 0x45, 0x4d, 0x46, 0, 0, 0, 0]));
    const pdf = await pdfOfPages(1);
    const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>';
    await encoderWithPictures('emf', pdf, run)(Buffer.from(blank), 'doc-p001.svg');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is refused with a typed error that is not the office suite\'s, when the picture would pass the bounds', async () => {
    const run = vi.fn(async () => WRITTEN);
    const pdf = await pdfOfPages(1);
    const poster = `<svg xmlns="http://www.w3.org/2000/svg" width="${96 * 120}" height="${96 * 120}"><image width="10" height="10" href="${PIXEL}"/></svg>`;
    await expect(encoderWithPictures('emf', pdf, run, vi.fn())(Buffer.from(poster), 'doc-p001.svg')).rejects.toThrow(/more than 72 dpi allows/);
    expect(run).not.toHaveBeenCalled();
  });
});
