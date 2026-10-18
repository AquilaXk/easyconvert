import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions/index';
import { EncryptedOfficeDocumentError, PdfPasswordRequiredError } from '../src/lib/types';
import { captureError } from './helpers/capture-error';
import { ENCRYPTION_VARIANTS, pdftotext, plainPdf, qpdfEncrypt, qpdfEncryptionReport } from './helpers/encrypted-pdf-fixtures';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { hasTesseractLanguage } from './helpers/tessdata';

/**
 * A PDF whose open (user) password is empty opens without asking, whatever the owner restricts, on every route that reads
 * it in the process: text, Markdown, HTML, hOCR, ALTO and the Office targets. A file that needs a password still answers
 * a typed 422 until the request carries it. Every encrypted file is written by the qpdf command line, and qpdf and
 * Poppler (which both open the files with the empty password themselves) say what the file holds.
 */

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext');
const ocrMissing = skipWithoutTools('qpdf', 'pdftoppm', 'tesseract') || skipUnless('eng.traineddata (Tesseract English data)', hasTesseractLanguage('eng'));
const OCR_TIMEOUT_MS = 120_000;
/** Too few characters for a text layer, so the page goes to OCR. */
const SPARSE_PAGE = '42';
const BODY = 'Locked body of the document';
const PAGE_TEXTS = [BODY, 'Second page of the document'];
const OWNER_PASSWORD = 'owner-secret-1';
const USER_PASSWORD = 'user-secret-1';
const HTTP_UNPROCESSABLE = 422;

const outputOf = async (pdf: Buffer, target: string, options = {}): Promise<string> =>
  (await convertFile(pdf, 'pdf', target, options, 'locked.pdf')).buffer.toString('utf8');

async function entryText(archive: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(archive);
  const entry = zip.file(name);
  expect(entry, `${name} in the archive`).not.toBeNull();
  return (entry as JSZip.JSZipObject).async('string');
}

describe.skipIf(toolsMissing)('an encrypted PDF with an empty open password', () => {
  for (const variant of ENCRYPTION_VARIANTS) {
    describe(variant.name, () => {
      it('is a file qpdf itself opens with the empty password', async () => {
        const pdf = qpdfEncrypt(await plainPdf(PAGE_TEXTS), { variant, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'none', extractAllowed: false });
        expect(qpdfEncryptionReport(pdf, '')).toMatchObject({ encrypted: true, userPasswordMatched: true });
        expect(pdftotext(pdf)).toContain(BODY);
      });

      for (const target of ['txt', 'md', 'html']) {
        it(`converts to ${target} as the unencrypted file does, although the owner forbids copying and editing`, async () => {
          const plain = await plainPdf(PAGE_TEXTS);
          const locked = qpdfEncrypt(plain, { variant, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'none', extractAllowed: false });
          const converted = await outputOf(locked, target);
          expect(converted).toContain(BODY);
          expect(converted).toBe(await outputOf(plain, target));
        });
      }

      for (const target of ['hocr', 'alto']) {
        // The sparse last page is recognized by OCR, which renders it: the page boxes and the rendering read the encrypted file too.
        it.skipIf(ocrMissing)(`converts to ${target} with the words of the text page and a recognized sparse page`, async () => {
          const locked = qpdfEncrypt(await plainPdf([BODY, SPARSE_PAGE]), { variant, userPassword: '', ownerPassword: OWNER_PASSWORD, structure: 'objstm' });
          const converted = await outputOf(locked, target);
          for (const word of BODY.split(' ')) expect(converted, `${target} holds "${word}"`).toContain(word);
        }, OCR_TIMEOUT_MS);
      }
    });
  }

  it('converts to DOCX with the text of the document', async () => {
    const locked = qpdfEncrypt(await plainPdf(PAGE_TEXTS), { variant: ENCRYPTION_VARIANTS[3], userPassword: '', ownerPassword: OWNER_PASSWORD });
    const converted = (await convertFile(locked, 'pdf', 'docx', {}, 'locked.pdf')).buffer;
    expect(await entryText(converted, 'word/document.xml')).toContain(BODY);
  });
});

describe.skipIf(toolsMissing)('an encrypted PDF that needs a password', () => {
  async function locked(): Promise<Buffer> {
    return qpdfEncrypt(await plainPdf(PAGE_TEXTS), { variant: ENCRYPTION_VARIANTS[3], userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
  }

  for (const target of ['md', 'html', 'docx']) {
    it(`is a typed 422 to ${target} without a password and with a wrong one`, async () => {
      const pdf = await locked();
      for (const options of [{}, { password: 'not-the-password' }]) {
        const error = await captureError(() => convertFile(pdf, 'pdf', target, options, 'locked.pdf'));
        expect(error).toBeInstanceOf(PdfPasswordRequiredError);
        expect((error as EncryptedOfficeDocumentError).status).toBe(HTTP_UNPROCESSABLE);
        expect(error.message).toMatch(/password/i);
        expect(error.message).not.toContain('not-the-password');
      }
    });
  }

  for (const target of ['md', 'html']) {
    it(`converts to ${target} once the request carries the user password or the owner password, as the unencrypted file does`, async () => {
      const plain = await plainPdf(PAGE_TEXTS);
      const pdf = qpdfEncrypt(plain, { variant: ENCRYPTION_VARIANTS[3], userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
      const expected = await outputOf(plain, target);
      expect(expected).toContain(BODY);
      for (const password of [USER_PASSWORD, OWNER_PASSWORD]) expect(await outputOf(pdf, target, { password }), `${target} with ${password}`).toBe(expected);
    });
  }
});
