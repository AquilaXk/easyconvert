import { describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { assertPdfJbig2WithinLimits, declaredJbig2Pages, jbig2DecodedBytes } from '../src/lib/conversions/pdf-jbig2-guard';
import { DecompressionLimitError, PayloadLimitError } from '../src/lib/types';
import { SandboxedBufferLimitError } from '../src/lib/security/process-sandbox';
import { toPopplerOutputLimitError } from '../src/worker/pdf-decrypt';
import { type CraftObject, buildPdf } from './helpers/pdf-craft';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A PDF whose page content is a JBIG2 stream that declares a 100,000 x 100,000 page (the pdf.js test file `bomb_giant.pdf`:
 * 123 KB, three such streams). The text and image readers of the native tools decode the stream to 1.25 GB per stream, and
 * Poppler then reads that as page content and prints one diagnostic per token: the run ended 25 to 45 s later with the
 * output limit of the sandbox, an untyped failure. The size is declared in the first bytes of the stream, so the request is
 * refused before any tool starts, with the 413 of every other decoded-size limit.
 *
 * The oracle for the declared size is ITU-T T.88 (JBIG2) section 7.4.8: the page information segment (type 48) opens with the
 * page width and height as 32-bit big-endian integers, and the filter hands back rows of ceil(width / 8) bytes. The header
 * bytes below are the first 30 bytes of the real file's stream, read with a script of its own, not with the code under test.
 */

const toolsMissing = skipWithoutTools('pdftotext', 'pdftoppm');
/** The 30 bytes that open each JBIG2 stream of bomb_giant.pdf: segment 0, type 48, page 1, 19 data bytes, 100000 x 100000. */
const BOMB_PAGE_INFORMATION = Buffer.from('0000000030000100000013000186a0000186a00000000000000000010000', 'hex');
const BOMB_DECODED_BYTES = 12_500 * 100_000;
/** An A4 page scanned at 300 dpi: 2480 x 3508 pixels, 310 bytes a row. */
const SCAN_PAGE_INFORMATION = Buffer.from('0000000030000100000013000009b000000db4000000000000000001' + '0000', 'hex');
const SCAN_DECODED_BYTES = 310 * 3508;
const REFUSAL_BUDGET_MS = 5000;
const HTTP_PAYLOAD_TOO_LARGE = 413;
/** Real tools run for tens of seconds before the fix; the test must end by assertion, not by the test timeout. */
const ENGINE_TEST_TIMEOUT_MS = 120_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/** A one-page PDF whose only content stream is `stream` coded with the JBIG2 filter (the stream is not a picture; Poppler reads it as page content). */
function pdfWithJbig2Content(stream: Buffer): Buffer {
  const objects: CraftObject[] = [
    { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
    { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >>' },
    { id: 4, dict: '/Filter /JBIG2Decode', stream },
  ];
  return buildPdf(objects, 1).buffer;
}

/** The same page behind a wrapper filter: the segments are not in the file as they are, so the size check does not read them. */
function pdfWithHexWrappedJbig2Content(stream: Buffer): Buffer {
  const objects: CraftObject[] = [
    { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
    { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >>' },
    { id: 4, dict: '/Filter [/ASCIIHexDecode /JBIG2Decode]', stream: Buffer.from(`${stream.toString('hex')}>`, 'latin1') },
  ];
  return buildPdf(objects, 1).buffer;
}

/** One segment header (T.88 section 7.2): number, flags with the type, no referred-to segments, page 1, data length. */
function segmentHeader(number: number, type: number, dataLength: number): Buffer {
  const header = Buffer.alloc(11);
  header.writeUInt32BE(number, 0);
  header.writeUInt8(type, 4);
  header.writeUInt8(0, 5);
  header.writeUInt8(1, 6);
  header.writeUInt32BE(dataLength, 7);
  return header;
}

describe('JBIG2 page size from the page information segment', () => {
  it('reads 100000 x 100000 from the real file header as 12,500 bytes a row for 100,000 rows', () => {
    expect(jbig2DecodedBytes(BOMB_PAGE_INFORMATION, 0)).toBe(BOMB_DECODED_BYTES);
  });

  it('rounds the row up to whole bytes (2480 pixels are 310 bytes)', () => {
    expect(jbig2DecodedBytes(SCAN_PAGE_INFORMATION, 0)).toBe(SCAN_DECODED_BYTES);
    const oddWidth = Buffer.from(SCAN_PAGE_INFORMATION);
    oddWidth.writeUInt32BE(2481, 11);
    expect(jbig2DecodedBytes(oddWidth, 0)).toBe(311 * 3508);
  });

  it('skips segments before the page information segment by their data length', () => {
    const symbolDictionary = Buffer.concat([segmentHeader(0, 0, 3), Buffer.from([1, 2, 3])]);
    const pageInformation = Buffer.concat([segmentHeader(1, 48, 19), SCAN_PAGE_INFORMATION.subarray(11)]);
    expect(jbig2DecodedBytes(Buffer.concat([symbolDictionary, pageInformation]), 0)).toBe(SCAN_DECODED_BYTES);
  });

  it('reads the stream from an offset inside a larger buffer', () => {
    const file = Buffer.concat([Buffer.from('stream\n', 'latin1'), BOMB_PAGE_INFORMATION]);
    expect(jbig2DecodedBytes(file, 7)).toBe(BOMB_DECODED_BYTES);
  });

  it('gives no size for a page of unknown height (striped page), for data that is no segment and for a cut-off header', () => {
    const striped = Buffer.from(SCAN_PAGE_INFORMATION);
    striped.writeUInt32BE(0xffffffff, 15);
    expect(jbig2DecodedBytes(striped, 0)).toBeNull();
    expect(jbig2DecodedBytes(Buffer.from('BT /F1 12 Tf (text) Tj ET'), 0)).toBeNull();
    expect(jbig2DecodedBytes(BOMB_PAGE_INFORMATION.subarray(0, 20), 0)).toBeNull();
  });
});

describe('PDFs with JBIG2 streams', () => {
  it('refuses a stream that declares 1.25 GB with a 413 that names the object, the size and the limit', () => {
    const pdf = pdfWithJbig2Content(BOMB_PAGE_INFORMATION);
    let error: unknown;
    try {
      assertPdfJbig2WithinLimits(pdf);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DecompressionLimitError);
    const message = (error as DecompressionLimitError).message;
    expect(message).toContain('object 4');
    expect(message).toContain('100000 x 100000');
    expect(message).toContain(String(BOMB_DECODED_BYTES));
    expect(message).toContain(String(64 * 1024 * 1024));
    expect((error as DecompressionLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
  });

  it('reads the page of a scanned A4 stream and nothing from a PDF without JBIG2 streams or a JBIG2 name outside a stream', () => {
    expect([...declaredJbig2Pages(pdfWithJbig2Content(SCAN_PAGE_INFORMATION))]).toEqual([
      { objectNumber: 4, width: 2480, height: 3508, decodedBytes: SCAN_DECODED_BYTES },
    ]);
    const plain = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [] /Count 0' },
        { id: 3, raw: '<< /Note /JBIG2Decode >>' },
        { id: 4, dict: '/Filter /FlateDecode', stream: BOMB_PAGE_INFORMATION },
        { id: 5, dict: '/Filter [/ASCIIHexDecode /JBIG2Decode]', stream: Buffer.from(`${BOMB_PAGE_INFORMATION.toString('hex')}>`, 'latin1') },
      ],
      1
    ).buffer;
    expect([...declaredJbig2Pages(plain)]).toEqual([]);
  });

  it('judges every stream of a file against the limit, the way a scan of many pages passes and one huge page does not', () => {
    const manyPages = buildPdf(
      Array.from({ length: 300 }, (_, index): CraftObject => ({ id: index + 1, dict: '/Filter /JBIG2Decode', stream: SCAN_PAGE_INFORMATION })),
      1
    ).buffer;
    const pages = [...declaredJbig2Pages(manyPages)];
    expect(pages).toHaveLength(300);
    expect(pages.map((page) => page.decodedBytes)).toEqual(Array(300).fill(SCAN_DECODED_BYTES));
    expect(() => assertPdfJbig2WithinLimits(manyPages)).not.toThrow();
    expect(() => assertPdfJbig2WithinLimits(manyPages, SCAN_DECODED_BYTES - 1)).toThrow(DecompressionLimitError);
  });

  it.skipIf(toolsMissing)('ends a conversion to text in a typed 413 before Poppler starts', async () => {
    const started = performance.now();
    const failure = await dispatchConversion(pdfWithJbig2Content(BOMB_PAGE_INFORMATION), 'pdf', 'txt', {}, 'bomb.pdf').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(DecompressionLimitError);
    expect(performance.now() - started).toBeLessThan(REFUSAL_BUDGET_MS);
  });

  it.skipIf(toolsMissing)('ends a conversion to page images in the same typed 413', async () => {
    const started = performance.now();
    const failure = await dispatchConversion(pdfWithJbig2Content(BOMB_PAGE_INFORMATION), 'pdf', 'png', {}, 'bomb.pdf').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(DecompressionLimitError);
    expect(performance.now() - started).toBeLessThan(REFUSAL_BUDGET_MS);
  });

  it.skipIf(toolsMissing)('ends a bomb the size check cannot read (behind a wrapper filter) in a typed 413 when Poppler floods its diagnostics', async () => {
    const failure = await dispatchConversion(pdfWithHexWrappedJbig2Content(BOMB_PAGE_INFORMATION), 'pdf', 'txt', {}, 'wrapped.pdf').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as PayloadLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((failure as PayloadLimitError).message).toContain('Poppler printed more diagnostics');
  });

  it.skipIf(toolsMissing)('refuses the real pdf.js file bomb_giant.pdf to text in a typed 413 within seconds', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'pdf-pdfjs-bomb_giant.pdf');
    const started = performance.now();
    const failure = await dispatchConversion(sample.bytes, 'pdf', 'txt', {}, 'bomb_giant.pdf').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(DecompressionLimitError);
    expect((failure as DecompressionLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect(performance.now() - started).toBeLessThan(REFUSAL_BUDGET_MS);
  });
});

describe('Poppler output past the sandbox limit', () => {
  it('is a typed 413, not an untyped crash, whichever stream carried it', () => {
    const mapped = toPopplerOutputLimitError(new SandboxedBufferLimitError(104_857_600));
    expect(mapped).toBeInstanceOf(PayloadLimitError);
    expect(mapped?.message).toContain('Poppler');
    expect(mapped?.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
  });

  it('leaves every other failure to its own handling', () => {
    expect(toPopplerOutputLimitError(new Error('spawn failed'))).toBeNull();
  });
});
