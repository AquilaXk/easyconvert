import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { PdfTextGeometryError, PdfTextUnmappedError, PDF_TEXT_MAX_PAGES } from '../src/lib/conversions/pdf-text-types';
import { ConversionFailedError, CorruptStreamError, EncryptedOfficeDocumentError, PayloadLimitError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { requireTessdata } from './helpers/ocr-fixtures';
import { captureError } from './helpers/capture-error';
import { cer, hasControlCharacters, paragraphOrderTau } from './helpers/pdf-text-metrics';
import { expectNoHang } from './helpers/timing';

/**
 * Text extraction from the PDF text layer. The fixtures are rendered by LibreOffice from sources in
 * tests/fixtures/pdf-text/sources (see PROVENANCE.md there), and the expected text is written from the same strings, so
 * neither oracle is a reader under test. Poppler's `pdftotext -raw` is the second, independent reader.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'pdf-text');
/** Character error rate a fixture may have against its source text. */
const MAX_CER = 0.01;
const MIN_ORDER_TAU = 0.99;
/** Looser bound for text recognized by OCR from the rendered page. */
const MAX_OCR_CER = 0.05;
const ENCRYPT_KEY_BITS = '256';

const pdf = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, `${name}.pdf`));
const truth = (name: string): string => fs.readFileSync(path.join(FIXTURES, `${name}.truth.txt`), 'utf8').trim();
const paragraphsOf = (name: string): string[] => truth(name).split(/\n\n/);

async function textOf(name: string, options = {}): Promise<string> {
  const converted = await convertFile(pdf(name), 'pdf', 'txt', options, `${name}.pdf`);
  return converted.buffer.toString('utf8');
}

function pdftotextRaw(name: string): string {
  return execFileSync(requireOracleTool('pdftotext'), ['-raw', '-enc', 'UTF-8', path.join(FIXTURES, `${name}.pdf`), '-'], { encoding: 'utf8' });
}

describe('text from the text layer, against the source text', () => {
  for (const name of ['latin', 'cjk', 'rtl', 'two-column', 'hyphenated', 'multipage', 'vertical']) {
    it(`${name}: character error rate of at most ${MAX_CER} and no control characters`, async () => {
      const text = await textOf(name);
      expect(hasControlCharacters(text)).toBe(false);
      expect(cer(truth(name), text)).toBeLessThanOrEqual(MAX_CER);
    });
  }

  it('keeps the "ET" inside a word and the ligatures of the font as letters', async () => {
    const text = await textOf('latin');
    expect(text).toContain('The ET scan was effective: the first official certificate of the traffic office');
    expect(text).toContain('Fluffy waffles differ from offices');
    expect(text).toContain('a well-known brand of coffee is brewed at 8:30');
    expect(text.split('\n\n')[1]).toBe(paragraphsOf('latin')[1]);
  });

  it('rejoins words broken by a hyphen at the end of a line', async () => {
    const text = await textOf('hyphenated');
    expect(text).toContain('Internationalization requirements strengthen the organizational responsibilities');
    expect(text).toContain('telecommunications infrastructure');
    expect(text.split('\n\n')).toEqual(paragraphsOf('hyphenated'));
    expect(text).not.toMatch(/\w-\s/);
  });

  it('reads right-to-left lines in logical order, with the Latin word and the number where the sentence has them', async () => {
    const text = await textOf('rtl');
    expect(text).toContain('تقرير الربع الثاني');
    expect(text).toContain('رقم الطلب 4521 تم إرساله إلى مكتب Berlin صباح الاثنين');
    expect(text).toContain('דוח הרבעון השני');
    expect(text.replace(/\s+/g, ' ').trim()).toBe(truth('rtl').replace(/\s+/g, ' ').trim());
  });
});

describe('reading order', () => {
  it('follows the paragraphs of a two-column page (Kendall tau at least 0.99)', async () => {
    const text = await textOf('two-column');
    expect(paragraphOrderTau(paragraphsOf('two-column'), text)).toBeGreaterThanOrEqual(MIN_ORDER_TAU);
  });

  it('keeps the order of the pages', async () => {
    const text = await textOf('multipage');
    const first = text.indexOf('First page heading');
    const second = text.indexOf('Second page heading');
    const third = text.indexOf('Third page heading');
    expect([first >= 0, first < second, second < third]).toEqual([true, true, true]);
  });

  it('reads vertical lines top to bottom, from the right-most line', async () => {
    const text = await textOf('vertical');
    expect(text.replace(/\s+/g, '')).toBe(truth('vertical').replace(/\s+/g, ''));
  });
});

describe('against Poppler pdftotext -raw', () => {
  for (const name of ['latin', 'cjk', 'two-column', 'multipage']) {
    oracleTest(`${name}: agrees with the reference reader within ${MAX_CER}`, ['pdftotext'], async () => {
      // Poppler puts a line break where a line wraps inside Han and kana text, which the source has no space for.
      const unspaced = (text: string): string => (name === 'cjk' ? text.replace(/\s+/g, '') : text);
      expect(cer(unspaced(pdftotextRaw(name)), unspaced(await textOf(name)))).toBeLessThanOrEqual(MAX_CER);
    });
  }
});

describe('fonts without a Unicode mapping', () => {
  it('refuses the page with a typed 400 instead of emitting control characters', async () => {
    const error = await captureError(() => textOf('cjk-unmapped'));
    expect(error).toBeInstanceOf(PdfTextUnmappedError);
    expect((error as PdfTextUnmappedError).status).toBe(400);
    expect((error as PdfTextUnmappedError).pages).toEqual([1]);
    expect(error.message).toContain('OCR');
    expect(hasControlCharacters(error.message)).toBe(false);
  });

  oracleTest('recognizes the page with OCR when OCR is on', ['tesseract', 'pdftoppm'], async () => {
    requireTessdata('eng');
    const text = await textOf('latin-unmapped', { ocrEnabled: true, ocrLanguage: 'eng' });
    expect(hasControlCharacters(text)).toBe(false);
    expect(cer(truth('latin'), text)).toBeLessThanOrEqual(MAX_OCR_CER);
  }, 120_000);
});

describe('input that must be refused', () => {
  oracleTest('a PDF that needs a password is a typed 422', ['qpdf'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-text-encrypted-'));
    try {
      const encrypted = path.join(dir, 'locked.pdf');
      execFileSync(requireOracleTool('qpdf'), [`--encrypt`, 'user-secret', 'owner-secret', ENCRYPT_KEY_BITS, '--', path.join(FIXTURES, 'latin.pdf'), encrypted]);
      const error = await captureError(() => convertFile(fs.readFileSync(encrypted), 'pdf', 'txt', {}, 'locked.pdf'));
      expect(error).toBeInstanceOf(EncryptedOfficeDocumentError);
      expect((error as EncryptedOfficeDocumentError).status).toBe(422);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bytes that are not a PDF are a typed 400', async () => {
    const error = await captureError(() => convertFile(Buffer.from('this is not a pdf at all'), 'pdf', 'txt', {}, 'x.pdf'));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect(error.message).toBe('Invalid PDF document: missing %PDF- header');
  });

  it('a damaged PDF is a typed 400, never an empty or guessed text', async () => {
    const damaged = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('7 0 obj << /Type /Page /Contents 9 0 R >> endobj\n'), Buffer.alloc(64, 0xff)]);
    const error = await captureError(() => convertFile(damaged, 'pdf', 'txt', {}, 'x.pdf'));
    expect(error).toBeInstanceOf(PdfTextGeometryError);
    expect((error as PdfTextGeometryError).status).toBe(400);
  });

  it('a document with more pages than the limit is a typed 413 and finishes quickly', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i <= PDF_TEXT_MAX_PAGES; i++) doc.addPage([10, 10]);
    const bytes = Buffer.from(await doc.save());
    const error = await expectNoHang('page-count limit', () => captureError(() => convertFile(bytes, 'pdf', 'txt', {}, 'many.pdf')));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error.message).toContain(String(PDF_TEXT_MAX_PAGES));
  });
});
