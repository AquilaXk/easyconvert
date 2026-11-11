import { PDFDocument } from 'pdf-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { convertFile } from '../src/lib/conversions/index';
import { OcrWorkLimitError } from '../src/lib/conversions/ocr-work-budget';
import { PdfPageFrameError } from '../src/lib/conversions/pdf-page-geometry';
import { PdfPageRenderError, PdfPageRenderLimitError } from '../src/lib/conversions/pdf-page-render';
import { JobTimeoutError, OcrEngineUnavailableError, OcrLanguageUnknownError, PayloadLimitError } from '../src/lib/types';

/**
 * OCR that the request did not ask for (a PDF to text whose pages have no text layer) is a best effort for one page that cannot be
 * rendered (the memory or time of a render, no engine): the text layer stays the answer and the conversion records a warning. A
 * document with no text that is refused for the size of its work (pages, work budget) is refused with the 413 that says so. OCR that the request
 * asked for (`ocrEnabled`, or the hOCR and ALTO targets, which are OCR output) is refused with the typed error. What
 * counts as a refusal is stated by hand here, the rendering and the engine are replaced: the nightly hostile-input suites run the
 * real renderer against the same files.
 */

const recognize = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/conversions/ocr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/conversions/ocr')>()),
  recognizeRenderedPdfPages: recognize,
}));

/** One page with nothing on it: no text layer, so a conversion to text reaches for OCR. */
async function blankPage(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const refuses = (error: Error) => recognize.mockRejectedValue(error);

beforeEach(() => {
  recognize.mockReset();
});

describe('OCR the request did not ask for, refused for one page that cannot be drawn within the limits of a render', () => {
  it.each([
    ['the memory a render may use', () => new PdfPageRenderLimitError('Page 1 needs more memory or output than rendering for OCR allows.')],
    ['the time one render may take', () => new PdfPageRenderError('Page 1 could not be rendered for OCR within 60000 ms.', 'timeout')],
    ['an engine that is not installed', () => new OcrEngineUnavailableError('Rendering PDF pages for OCR needs Poppler pdftoppm, which is not installed on this server.')],
  ])('answers the text layer and a warning when %s refuses it', async (_label, makeError) => {
    refuses(makeError());
    const result = await convertFile(await blankPage(), 'pdf', 'txt', {}, 'blank.pdf');
    expect(result.buffer.toString('utf8')).toBe('');
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(result.metadata?.warnings).toEqual([expect.stringContaining('Did not recognize page 1 with OCR, which the request did not ask for')]);
    expect((result.metadata?.warnings as string[])[0]).toContain(makeError().message);
  });
});

describe('OCR the request did not ask for, refused for the size of the work, on a document with no text', () => {
  it.each([
    ['the work budget of the document', () => new OcrWorkLimitError('Recognizing this document needs more than the 40000 ms allowed for 1 pages')],
    ['the number of pages one request renders', () => new PayloadLimitError('The request converts 900 pages to images; at most 200 are converted in one request.')],
  ])('stays the 413 that tells the person to select pages when %s refuses it', async (_label, makeError) => {
    const error = makeError();
    refuses(error);
    const refused = convertFile(await blankPage(), 'pdf', 'txt', {}, 'blank.pdf');
    await expect(refused).rejects.toBe(error);
    await expect(refused).rejects.toMatchObject({ status: 413 });
  });
});

describe('OCR the request did not ask for, on a page that cannot be drawn', () => {
  it.each([
    ['a page tree that cannot be walked', () => new PdfPageFrameError('Invalid PDF: the page tree could not be read (x).')],
    ['a page that Poppler calls malformed', () => new PdfPageRenderError('Page 1 could not be rendered for OCR: the PDF is malformed or unsupported.', 'malformed')],
  ])('refuses a document with no text at all for %s, as damaged, instead of answering an empty text', async (_label, makeError) => {
    const error = makeError();
    refuses(error);
    await expect(convertFile(await blankPage(), 'pdf', 'txt', {}, 'blank.pdf')).rejects.toBe(error);
  });
});

describe('a failure that is not a refusal', () => {
  it.each([
    ['the pixel limit of the input', () => new InputPixelLimitError(1000, 5000, 5000, 'PDF page 1 at 300 DPI')],
    ['the deadline of the job', () => new JobTimeoutError(30_000)],
    ['a language the request got wrong', () => new OcrLanguageUnknownError('Unknown OCR language xx')],
  ])('stays a failure for %s', async (_label, makeError) => {
    const error = makeError();
    refuses(error);
    await expect(convertFile(await blankPage(), 'pdf', 'txt', {}, 'blank.pdf')).rejects.toBe(error);
  });
});

describe('OCR the request asked for', () => {
  it.each([
    ['the work budget of the document', () => new OcrWorkLimitError('Recognizing this document needs more than the 40000 ms allowed for 1 pages')],
    ['the memory a render may use', () => new PdfPageRenderLimitError('Page 1 needs more memory or output than rendering for OCR allows.')],
    ['the time one render may take', () => new PdfPageRenderError('Page 1 could not be rendered for OCR within 60000 ms.', 'timeout')],
    ['an engine that is not installed', () => new OcrEngineUnavailableError('Rendering PDF pages for OCR needs Poppler pdftoppm, which is not installed on this server.')],
  ])('is refused with the typed error when %s refuses it', async (_label, makeError) => {
    const error = makeError();
    refuses(error);
    await expect(convertFile(await blankPage(), 'pdf', 'txt', { ocrEnabled: true }, 'blank.pdf')).rejects.toBe(error);
  });

  it('is refused with the typed error for the hOCR target, which is OCR output', async () => {
    const error = new OcrWorkLimitError('Recognizing this document needs more than the 40000 ms allowed for 1 pages');
    refuses(error);
    await expect(convertFile(await blankPage(), 'pdf', 'hocr', {}, 'blank.pdf')).rejects.toBe(error);
  });
});
