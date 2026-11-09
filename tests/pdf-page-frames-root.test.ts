import JSZip from 'jszip';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { convertDocument } from '../src/lib/conversions/document';
import { shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { PdfPageFrameError, readPdfPageFrames } from '../src/lib/conversions/pdf-page-geometry';
import { requireTessdata } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';
import { buildPdf, HELVETICA_FONT, textContent } from './helpers/pdf-craft';
import { requireRealworldSample } from './helpers/realworld-sample';

const CATALOG_ID = 1;
const PAGES_ID = 2;
const PAGE_ID = 3;
const MEDIA_BOX = '[0 0 200 100]';
const PARSER_TYPE_ERROR = /is not a function|undefined|TypeError/;

afterEach(async () => {
  await shutdownOcrWorkerPool();
});

function pdfWithPagesEntry(pagesDict: string): Buffer {
  return buildPdf(
    [
      { id: CATALOG_ID, dict: `/Type /Catalog /Pages ${PAGES_ID} 0 R` },
      { id: PAGES_ID, dict: pagesDict },
      { id: PAGE_ID, dict: `/Type /Page /Parent ${PAGES_ID} 0 R /MediaBox ${MEDIA_BOX}` },
    ],
    CATALOG_ID
  ).buffer;
}

describe('the frames of a PDF whose catalog has no page tree', () => {
  it('refuses a /Pages entry that is a plain dictionary with a typed error that names the page tree', async () => {
    const error = await readPdfPageFrames(pdfWithPagesEntry('/S /JavaScript /JS (func=function(){};func();)')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PdfPageFrameError);
    const message = (error as PdfPageFrameError).message;
    expect(message).toMatch(/\/Pages entry of the catalog is missing or is not a page tree dictionary/);
    expect(message).not.toMatch(PARSER_TYPE_ERROR);
  });

  it('refuses a /Type /Page root dictionary that also contains /Kids', async () => {
    const error = await readPdfPageFrames(pdfWithPagesEntry(`/Type /Page /Kids [${PAGE_ID} 0 R] /Count 1 /MediaBox ${MEDIA_BOX}`)).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(PdfPageFrameError);
    const message = (error as PdfPageFrameError).message;
    expect(message).toMatch(/\/Pages entry of the catalog is missing or is not a page tree dictionary/);
    expect(message).not.toMatch(PARSER_TYPE_ERROR);
  });

  it('refuses a root dictionary that is not typed /Type /Catalog', async () => {
    const untypedRoot = buildPdf(
      [
        { id: CATALOG_ID, dict: `/Pages ${PAGES_ID} 0 R` },
        { id: PAGES_ID, dict: `/Type /Pages /Kids [${PAGE_ID} 0 R] /Count 1` },
        { id: PAGE_ID, dict: `/Type /Page /Parent ${PAGES_ID} 0 R /MediaBox ${MEDIA_BOX}` },
      ],
      CATALOG_ID
    ).buffer;
    const error = await readPdfPageFrames(untypedRoot).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PdfPageFrameError);
    const message = (error as PdfPageFrameError).message;
    expect(message).toMatch(/\/Pages entry of the catalog is missing or is not a page tree dictionary/);
    expect(message).not.toMatch(PARSER_TYPE_ERROR);
  });

  it('still reads the frame of a page tree that has one page', async () => {
    const frames = await readPdfPageFrames(pdfWithPagesEntry(`/Type /Pages /Kids [${PAGE_ID} 0 R] /Count 1`));
    expect(frames).toEqual([{ cropBox: { x0: 0, y0: 0, x1: 200, y1: 100 }, rotation: 0 }]);
  });

  it('reads the frame of a catalog whose /Pages entry is a single /Type /Page leaf directly, and converts its text', async () => {
    const leafPdf = buildPdf(
      [
        { id: CATALOG_ID, dict: `/Type /Catalog /Pages ${PAGES_ID} 0 R` },
        { id: PAGES_ID, dict: `/Type /Page /MediaBox [0 0 842 1191] /Rotate 90 /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >>` },
        { id: 3, stream: Buffer.from(textContent('Single page leaf catalog'), 'latin1') },
        { id: 4, raw: HELVETICA_FONT },
      ],
      CATALOG_ID
    ).buffer;
    const frames = await readPdfPageFrames(leafPdf);
    expect(frames).toEqual([{ cropBox: { x0: 0, y0: 0, x1: 842, y1: 1191 }, rotation: 90 }]);
    const converted = await convertDocument(leafPdf, 'pdf', 'txt');
    expect(converted.buffer.toString('utf8').trim()).toBe('Single page leaf catalog');
  });

  it('preserves an embedded JPEG byte for byte when converting a single-page leaf catalog PDF to DOCX', async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 80, b: 160 } },
    })
      .jpeg()
      .toBuffer();
    const leafImagePdf = buildPdf(
      [
        { id: CATALOG_ID, dict: `/Type /Catalog /Pages ${PAGES_ID} 0 R` },
        {
          id: PAGES_ID,
          dict: `/Type /Page /MediaBox [0 0 612 792] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Im0 5 0 R >> >>`,
        },
        {
          id: 3,
          stream: Buffer.from(
            `${textContent('Single page leaf catalog document with an embedded JPEG image for DOCX conversion')}\nq 40 0 0 40 10 10 cm /Im0 Do Q`,
            'latin1'
          ),
        },
        { id: 4, raw: HELVETICA_FONT },
        {
          id: 5,
          dict: `/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
          stream: jpeg,
        },
      ],
      CATALOG_ID
    ).buffer;
    const docx = await convertDocument(leafImagePdf, 'pdf', 'docx');
    const zip = await JSZip.loadAsync(docx.buffer);
    const media = Object.keys(zip.files).filter((entry) => entry.startsWith('word/media/') && !zip.files[entry].dir);
    expect(media).toEqual(['word/media/image1.jpeg']);
    const written = await (zip.file(media[0]) as JSZip.JSZipObject).async('nodebuffer');
    expect(written.equals(jpeg)).toBe(true);
  });

  oracleTest(
    'converts a single-page leaf catalog PDF through forced OCR to text and to a sandwich PDF',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      const leafPdf = buildPdf(
        [
          { id: CATALOG_ID, dict: `/Type /Catalog /Pages ${PAGES_ID} 0 R` },
          { id: PAGES_ID, dict: `/Type /Page /MediaBox [0 0 612 792] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >>` },
          { id: 3, stream: Buffer.from(textContent('Single page leaf catalog', 72), 'latin1') },
          { id: 4, raw: HELVETICA_FONT },
        ],
        CATALOG_ID
      ).buffer;
      const ocrTxt = await convertDocument(leafPdf, 'pdf', 'txt', { ocrEnabled: true, ocrMode: 'force' });
      expect(ocrTxt.buffer.toString('utf8').toLowerCase()).toContain('single page leaf catalog');
      const ocrPdf = await convertDocument(leafPdf, 'pdf', 'pdf', { ocrEnabled: true, ocrMode: 'force' });
      const frames = await readPdfPageFrames(ocrPdf.buffer);
      expect(frames).toEqual([{ cropBox: { x0: 0, y0: 0, x1: 612, y1: 792 }, rotation: 0 }]);
    },
    120_000
  );

  it('refuses pdfjs-issue15590.pdf, whose /Pages is the dictionary of a JavaScript action, the same way', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdfjs-issue15590.pdf');
    const error = await readPdfPageFrames(bytes).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PdfPageFrameError);
    expect((error as PdfPageFrameError).message).toMatch(/\/Pages entry of the catalog is missing or is not a page tree dictionary/);
    expect((error as PdfPageFrameError).message).not.toMatch(PARSER_TYPE_ERROR);
  });
});
