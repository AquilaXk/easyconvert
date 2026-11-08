import { describe, expect, it } from 'vitest';
import { MAX_PDF_DRAWS, MAX_PDF_DRAWS_PER_PAGE, PdfDocument, PdfStructureError } from '../src/lib/conversions/pdf-document';
import { planPageRender } from '../src/lib/conversions/pdf-page-render';
import { pdfjsReadableBytes } from '../src/lib/conversions/pdf-reader-input';
import { runPdfTextJob } from '../src/lib/conversions/pdf-text-geometry';
import { type CraftObject, buildPdf, flate } from './helpers/pdf-craft';
import { AES_256, plainPdf, qpdfEncrypt } from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';
import { captureError } from './helpers/capture-error';

/**
 * The limits a PDF is checked against before it is read (pdf-document.ts, `contentStreams`) follow the document as pdf.js reads
 * it:
 *  - a page's resources are those of its own /Parent chain (ISO 32000-1 section 7.7.3.4, pdf.js `getInheritableProperty`), not
 *    only the ones the /Kids walk met on the way down, so a page tree that keeps its XObjects on a /Pages node is read;
 *  - every draw counts: a `Do` of an image or a form, and an inline image, per page and per document, a form's draws again on each
 *    invocation, so a page that draws one picture a hundred thousand times is refused though the picture is stored once;
 *  - an encrypted file is checked after it is decrypted, or refused with a typed error, never passed unread.
 */

const IMAGE: CraftObject = {
  id: 10,
  dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8',
  stream: Buffer.from([0]),
};
const FORM_ID = 11;
const INLINE_IMAGE = 'BI /W 1 /H 1 /BPC 8 /CS /G ID x EI\n';

const doOperators = (count: number, name = 'Im1'): string => `/${name} Do\n`.repeat(count);

/** One page whose resources are given by `resources`, which sits on the page or on its /Pages node. */
function pdfWithResourcesOn(where: 'page' | 'pages', content: string): Buffer {
  const resources = '/Resources << /XObject << /Im1 10 0 R >> >>';
  return buildPdf(
    [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: `/Type /Pages /Kids [3 0 R] /Count 1 ${where === 'pages' ? resources : ''}` },
      { id: 3, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R ${where === 'page' ? resources : ''}` },
      { id: 4, dict: '/Filter /FlateDecode', stream: flate(content) },
      IMAGE,
    ],
    1
  ).buffer;
}

function drawn(pdf: Buffer): { painted: number[]; draws: readonly number[] } {
  const document = new PdfDocument(pdf, undefined, true);
  document.contentStreams(() => undefined);
  return { painted: document.paintedImageObjects().flatMap((page) => [...page]), draws: document.drawsPerPage() };
}

describe('the resources of a page are read through its /Parent chain', () => {
  it('reads the XObjects a page keeps on its own dictionary', () => {
    expect(drawn(pdfWithResourcesOn('page', doOperators(3)))).toEqual({ painted: [10], draws: [3] });
  });

  it('reads the XObjects a page inherits from its /Pages node', () => {
    expect(drawn(pdfWithResourcesOn('pages', doOperators(3)))).toEqual({ painted: [10], draws: [3] });
  });

  it('reads the resources of the /Pages node a page names as its /Parent, whichever /Kids list holds the page', () => {
    // The page is listed under node 2, which has no resources, but names node 6 as its parent, and node 6 has them; pdf.js reads node 6.
    const pdf = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
        { id: 3, dict: '/Type /Page /Parent 6 0 R /MediaBox [0 0 100 100] /Contents 4 0 R' },
        { id: 4, stream: Buffer.from(doOperators(5)) },
        { id: 6, dict: '/Type /Pages /Kids [] /Count 0 /Resources << /XObject << /Im1 10 0 R >> >>' },
        IMAGE,
      ],
      1
    ).buffer;
    expect(drawn(pdf)).toEqual({ painted: [10], draws: [5] });
  });

  it('reads the resources of a page found by its /Type when the page tree lists none, through the /Parent chain', () => {
    const pdf = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [] /Count 0 /Resources << /XObject << /Im1 10 0 R >> >>' },
        { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R' },
        { id: 4, stream: Buffer.from(doOperators(4)) },
        IMAGE,
      ],
      1
    ).buffer;
    expect(drawn(pdf)).toEqual({ painted: [10], draws: [4] });
  });

  it('keeps the nearest resources: a page with its own dictionary does not read its parent\'s', () => {
    const pdf = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1 /Resources << /XObject << /Im1 10 0 R >> >>' },
        { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << >>' },
        { id: 4, stream: Buffer.from(doOperators(4)) },
        IMAGE,
      ],
      1
    ).buffer;
    expect(drawn(pdf)).toEqual({ painted: [], draws: [0] });
  });

  it('counts the draws of a page whose resources come from the /Pages node against the limit', () => {
    const pdf = pdfWithResourcesOn('pages', doOperators(MAX_PDF_DRAWS_PER_PAGE + 1));
    expect(() => drawn(pdf)).toThrow(PdfStructureError);
  });

  it('stops at a /Parent chain that returns to itself', () => {
    const pdf = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1 /Parent 6 0 R' },
        { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R' },
        { id: 4, stream: Buffer.from(doOperators(1)) },
        { id: 6, dict: '/Type /Pages /Kids [] /Count 0 /Parent 2 0 R' },
        IMAGE,
      ],
      1
    ).buffer;
    expect(drawn(pdf)).toEqual({ painted: [], draws: [0] });
  });
});

describe('every draw counts against the limits of a page and of a document', () => {
  it(`passes a page that draws ${MAX_PDF_DRAWS_PER_PAGE} times and refuses one more`, () => {
    expect(drawn(pdfWithResourcesOn('page', doOperators(MAX_PDF_DRAWS_PER_PAGE))).draws).toEqual([MAX_PDF_DRAWS_PER_PAGE]);
    expect(() => drawn(pdfWithResourcesOn('page', doOperators(MAX_PDF_DRAWS_PER_PAGE + 1)))).toThrow(/draws more than/);
  });

  it('counts the inline images of a page', () => {
    expect(drawn(pdfWithResourcesOn('page', INLINE_IMAGE.repeat(7))).draws).toEqual([7]);
    expect(() => drawn(pdfWithResourcesOn('page', INLINE_IMAGE.repeat(MAX_PDF_DRAWS_PER_PAGE + 1)))).toThrow(PdfStructureError);
  });

  it('does not count an inline image that a string, a name or a comment spells', () => {
    expect(drawn(pdfWithResourcesOn('page', '(BI ID) Tj /ID Do % BI ID\n')).draws).toEqual([0]);
  });

  it('counts the draws of a form again on every invocation', () => {
    const formDraws = 1000;
    const invocations = Math.ceil(MAX_PDF_DRAWS_PER_PAGE / formDraws) + 1;
    const pdf = (times: number): Buffer =>
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
          { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /XObject << /Fm1 11 0 R >> >>' },
          { id: 4, stream: Buffer.from(doOperators(times, 'Fm1')) },
          {
            id: FORM_ID,
            dict: '/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Im1 10 0 R >> >>',
            stream: Buffer.from(doOperators(formDraws)),
          },
          IMAGE,
        ],
        1
      ).buffer;
    // Each invocation is a draw of the form and `formDraws` draws of the picture.
    expect(drawn(pdf(3)).draws).toEqual([3 * (formDraws + 1)]);
    expect(() => drawn(pdf(invocations))).toThrow(/draws more than/);
  });

  it('refuses a document whose pages draw more than the document limit together, though no page draws more than its own', () => {
    const perPage = MAX_PDF_DRAWS_PER_PAGE - 1;
    const pages = Math.floor(MAX_PDF_DRAWS / perPage) + 1;
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: `/Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${20 + i} 0 R`).join(' ')}] /Count ${pages} /Resources << /XObject << /Im1 10 0 R >> >>` },
      { id: 4, stream: Buffer.from(doOperators(perPage)) },
      IMAGE,
    ];
    for (let i = 0; i < pages; i++) objects.push({ id: 20 + i, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R' });
    const pdf = buildPdf(objects, 1).buffer;
    expect(() => drawn(pdf)).toThrow(/PDF draws more than/);
  });

  it('refuses the file before the picture decoders or pdf.js read it', () => {
    const pdf = pdfWithResourcesOn('page', doOperators(MAX_PDF_DRAWS_PER_PAGE + 1));
    expect(() => pdfjsReadableBytes(pdf, { content: true, pictures: true })).toThrow(PdfStructureError);
  });
});

const qpdfMissing = skipWithoutTools('qpdf');

describe.skipIf(qpdfMissing)('an encrypted PDF is checked after it is decrypted, or refused with a typed error', () => {
  const hostile = (): Buffer => pdfWithResourcesOn('page', doOperators(MAX_PDF_DRAWS_PER_PAGE + 1));

  it('refuses the bytes of an encrypted file the guard cannot read, instead of passing them to pdf.js', async () => {
    const locked = qpdfEncrypt(hostile(), { variant: AES_256, userPassword: '', ownerPassword: 'owner-secret' });
    for (const job of [{ content: true, pictures: false }, { content: false, pictures: false }]) {
      const error = await captureError(async () => pdfjsReadableBytes(locked, job));
      expect(error, `job ${JSON.stringify(job)}`).toMatchObject({ name: 'EncryptedOfficeDocumentError', status: 422, refusalCode: 'encrypted_input' });
    }
  });

  it('applies the limits of a file with no open password to what it holds once decrypted', async () => {
    const locked = qpdfEncrypt(hostile(), { variant: AES_256, userPassword: '', ownerPassword: 'owner-secret' });
    await expect(runPdfTextJob(locked, { geometry: 'none', content: true })).rejects.toThrow(/draws more than/);
  });

  it('reads an encrypted file with no open password that is within the limits', async () => {
    const locked = qpdfEncrypt(await plainPdf(['Locked body']), { variant: AES_256, userPassword: '', ownerPassword: 'owner-secret' });
    const result = await runPdfTextJob(locked, { geometry: 'none', content: true });
    expect(JSON.stringify(result.content).includes('Locked body')).toBe(true);
  });

  it('answers a file that needs an open password with the typed password error, not with a pass', async () => {
    const locked = qpdfEncrypt(await plainPdf(['Locked body']), { variant: AES_256, userPassword: 'user-secret', ownerPassword: 'owner-secret' });
    const error = await captureError(() => runPdfTextJob(locked, { geometry: 'none', content: true }));
    expect(error).toMatchObject({ name: 'PdfPasswordRequiredError', status: 422, refusalCode: 'password_required' });
  });

  it('counts the pages of an encrypted file whose page tree is in an encrypted object stream against the page limit', async () => {
    const pageCount = 501;
    const locked = qpdfEncrypt(await plainPdf(Array.from({ length: pageCount }, (_, i) => `Page ${i + 1}`)), {
      variant: AES_256,
      userPassword: '',
      ownerPassword: 'owner-secret',
      structure: 'objstm',
    });
    const error = await captureError(() => planPageRender(locked, undefined, 72));
    expect(error).toMatchObject({ name: 'PayloadLimitError', status: 413 });
  }, 60_000);
});
