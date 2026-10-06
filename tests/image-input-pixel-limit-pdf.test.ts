import { beforeAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { MAX_PDF_IMAGE_MARKERS, extractRasterImagesFromPdf } from '../src/lib/conversions/pdf-rasterizer';
import { ConversionFailedError } from '../src/lib/types';
import { pdfWithFlateImage, type ImageDictionary } from './helpers/image-pdf-bomb';

const BYTES_PER_MIB = 1024 * 1024;
/** Generous bound for a scan that must be linear in the file size; the quadratic scan took 23 s on 8 MB. */
const MAX_SCAN_MS = 8000;
const MAX_RSS_GROWTH_BYTES = 50 * BYTES_PER_MIB;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const EXPECTED_DEFAULT_LIMIT = 100_000_000;
const OVER_CAP_SIDE = 15_000;
const SMALL_SIDE = 64;
const MAX_BOMB_PDF_BYTES = 2 * BYTES_PER_MIB;
const SCAN_FIXTURE_BYTES = 8 * 1000 * 1000;

const COMMON = '/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length {length}';

/** The same 15000 x 15000 image written in forms that a naive text scan reads wrongly. */
const EVASIONS: Array<[string, ImageDictionary]> = [
  ['a name-escaped Subtype value', { body: `/Type /XObject /Subtype /#49mage /Width 15000 /Height 15000 ${COMMON}` }],
  ['a name-escaped Width key', { body: `/Type /XObject /Subtype /Image /Wid#74h 15000 /Height 15000 ${COMMON}` }],
  ['an indirect Width', { body: `/Type /XObject /Subtype /Image /Width 6 0 R /Height 15000 ${COMMON}`, extraObjects: ['15000'] }],
  ['indirect Width and Height', { body: `/Type /XObject /Subtype /Image /Width 6 0 R /Height 7 0 R ${COMMON}`, extraObjects: ['15000', '15000'] }],
  ['a decoy Width and Height before the real ones', { body: `/Type /XObject /Subtype /Image /Metadata << /Width 1 /Height 1 >> /Width 15000 /Height 15000 ${COMMON}` }],
  ['a /stream name before the dimensions', { body: `/Type /XObject /Subtype /Image /Foo /stream /Width 15000 /Height 15000 ${COMMON}` }],
  ['a real number', { body: `/Type /XObject /Subtype /Image /Width 15000.0 /Height +15000 ${COMMON}` }],
];

describe('PDF raster extraction (the OCR input path) honours the input pixel limit', () => {
  beforeAll(async () => {
    // Load pdfjs once so the measurement below covers the rejection only.
    await extractRasterImagesFromPdf(pdfWithFlateImage(SMALL_SIDE, SMALL_SIDE));
  });

  it('refuses a small PDF whose image declares 225 megapixels, before the image is decoded', async () => {
    const pdf = pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE);
    expect(pdf.length).toBeLessThan(MAX_BOMB_PDF_BYTES);

    const rssBefore = process.memoryUsage().rss;
    let error: unknown;
    try {
      await extractRasterImagesFromPdf(pdf);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InputPixelLimitError);
    expect(error).toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, limit: EXPECTED_DEFAULT_LIMIT });
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it.each(EVASIONS)('refuses the image when it is written with %s', async (_label, dictionary) => {
    const pdf = pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE, false, dictionary);
    const rssBefore = process.memoryUsage().rss;
    const run = extractRasterImagesFromPdf(pdf);
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, width: OVER_CAP_SIDE, height: OVER_CAP_SIDE });
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it.each([
    ['an indirect Width that is not a plain integer object', { body: `/Type /XObject /Subtype /Image /Width 99 0 R /Height 15000 ${COMMON}` }],
    ['no Width at all', { body: `/Type /XObject /Subtype /Image /Height 15000 ${COMMON}` }],
    ['a Width beyond the scan window', { body: `/Type /XObject /Subtype /Image /Pad (${'x'.repeat(10_000)}) /Width 15000 /Height 15000 ${COMMON}` }],
  ])('refuses, as unreadable and not decoded, an image with %s', async (_label, dictionary) => {
    const pdf = pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE, false, dictionary);
    const rssBefore = process.memoryUsage().rss;
    const run = extractRasterImagesFromPdf(pdf);
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.not.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toThrow(/dimensions of an embedded image could not be read/);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('keeps the typed error through a PDF conversion that asks for OCR, without decoding the image', async () => {
    const pdf = pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE);
    const run = convertFile(pdf, 'pdf', 'txt', { ocrEnabled: true }, 'scan.pdf');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE });
  });

  it('refuses an inline image over the limit with the same typed error, since pdfjs skips it undecoded', async () => {
    const pdf = pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE, true);
    const rssBefore = process.memoryUsage().rss;
    const run = extractRasterImagesFromPdf(pdf);
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, limit: EXPECTED_DEFAULT_LIMIT });
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('tells concurrent extractions apart: a benign PDF is not refused because another PDF holds a bomb', async () => {
    const bomb = extractRasterImagesFromPdf(pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE, true));
    const benign = extractRasterImagesFromPdf(pdfWithFlateImage(SMALL_SIDE, SMALL_SIDE));
    const [bombResult, benignResult] = await Promise.allSettled([bomb, benign]);
    expect(bombResult.status).toBe('rejected');
    expect(benignResult.status).toBe('fulfilled');
    if (benignResult.status === 'fulfilled') {
      expect(benignResult.value).toHaveLength(1);
      expect(benignResult.value[0]).toMatchObject({ width: SMALL_SIDE, height: SMALL_SIDE });
    }
  });

  it('still extracts an image within the limit', async () => {
    const images = await extractRasterImagesFromPdf(pdfWithFlateImage(SMALL_SIDE, SMALL_SIDE));
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ pageNumber: 1, width: SMALL_SIDE, height: SMALL_SIDE });
    expect(images[0].buffer.subarray(1, 4).toString('ascii')).toBe('PNG');
  });
});

describe('the PDF image scan stays linear on hostile files', () => {
  /** Repeats `unit` to about SCAN_FIXTURE_BYTES behind a PDF header. */
  function repeated(unit: string): Buffer {
    const count = Math.floor(SCAN_FIXTURE_BYTES / unit.length);
    return Buffer.from(`%PDF-1.4\n${unit.repeat(count)}`, 'latin1');
  }

  it.each([
    ['digits before every marker', `${'1'.repeat(2040)}/Subtype /Image `],
    ['white-space separated numbers before every marker', `${'1 '.repeat(1000)}/Subtype /Image `],
    ['markers back to back', '/Subtype /Image '],
  ])('refuses 8 MB of %s quickly and typed', async (_label, unit) => {
    const pdf = repeated(unit);
    const start = performance.now();
    const run = extractRasterImagesFromPdf(pdf);
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    expect(performance.now() - start).toBeLessThan(MAX_SCAN_MS);
  });

  it('scans a file whose every marker has readable dimensions in bounded time', async () => {
    const unit = '/Subtype /Image /Width 1 /Height 1 ';
    const markers = MAX_PDF_IMAGE_MARKERS - 1;
    const pdf = Buffer.from(`%PDF-1.4\n${unit.repeat(markers)}`, 'latin1');
    const start = performance.now();
    // pdfjs then rejects the file as malformed; what is measured is that the scan itself finishes.
    await extractRasterImagesFromPdf(pdf).catch(() => undefined);
    expect(performance.now() - start).toBeLessThan(MAX_SCAN_MS);
  });

  it('refuses a document with more image markers than the cap, without reading further', async () => {
    const pdf = Buffer.from(`%PDF-1.4\n${'/Subtype /Image /Width 1 /Height 1 '.repeat(MAX_PDF_IMAGE_MARKERS + 1)}`, 'latin1');
    const run = extractRasterImagesFromPdf(pdf);
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(`more than ${MAX_PDF_IMAGE_MARKERS} images`);
  });
});

describe('implicit OCR of a scanned PDF', () => {
  it('refuses an image over the limit with 413 whether or not OCR was asked for, never an empty 200', async () => {
    const pdf = pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE);
    for (const options of [{}, { ocrEnabled: true }]) {
      const run = convertFile(pdf, 'pdf', 'txt', options, 'scan.pdf');
      await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
      await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE });
    }
    const hocr = convertFile(pdf, 'pdf', 'hocr', {}, 'scan.pdf');
    await expect(hocr).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE });
  });

  it('reports a PDF whose image dimensions cannot be read as a typed 400 when OCR was asked for', async () => {
    const pdf = pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE, false, { body: `/Type /XObject /Subtype /Image /Height 15000 ${COMMON}` });
    const run = convertFile(pdf, 'pdf', 'txt', { ocrEnabled: true }, 'scan.pdf');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/could not be read/);
  });
});
