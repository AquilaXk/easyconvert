import { describe, expect, it, vi } from 'vitest';
import { runPdfTextJob } from '../src/lib/conversions/pdf-text-geometry';
import { readDxf } from './helpers/dxf-reader';
import { PicturePages } from '../src/lib/conversions/vector-dxf';
import { isSvgPageTarget, svgPageEncoder } from '../src/worker/svg-page-encoders';
import { withPageNumbers } from '../src/worker/worker-output';
import type { WorkerConversionResult } from '../src/worker/worker-types';

vi.mock('../src/lib/conversions/pdf-text-geometry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/conversions/pdf-text-geometry')>()),
  runPdfTextJob: vi.fn(),
}));

/**
 * The writers behind the SVG-page targets (DXF, EMF, WMF) are the ones the PDF chain calls for a Visio drawing, so each
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
  it.each(['dxf', 'emf', 'wmf'])('.%s is a target written from the SVG page', (target) => {
    expect(isSvgPageTarget(target)).toBe(true);
  });

  it.each(['png', 'svg', 'cgm', 'pdf', 'eps', 'toString', '__proto__'])('.%s is not', (target) => {
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

  it('DXF: a SECTION record opens the file and an EOF record closes it', async () => {
    const dxf = (await write('dxf')).toString('utf-8');
    expect(dxf).toMatch(/^\s*0\nSECTION\n/);
    expect(dxf).toMatch(/\n\s*0\nEOF\s*$/);
  });

  it('each target has a writer of its own', async () => {
    const outputs = await Promise.all(['dxf', 'emf', 'wmf'].map(async (target) => (await write(target)).subarray(0, 48).toString('hex')));
    expect(new Set(outputs).size).toBe(3);
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
