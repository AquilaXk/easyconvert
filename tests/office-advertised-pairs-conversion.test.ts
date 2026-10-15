import { describe, expect } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { oracleTest } from './helpers/oracle-test';
import { normalizeWhitespace } from './helpers/soffice-office';
import {
  expectOcrRecall,
  expectPagesMatchReference,
  expectWordsOnReferencePages,
  renderReferencePages,
  type PageFormat,
} from './helpers/rendered-page-compare';
import {
  DOCUMENT_PARAGRAPHS,
  SHEET_ROWS,
  SLIDES,
  authorWithReferenceSuite,
  compoundFileFacts,
  identifyImage,
  openDocumentSlideTexts,
  pixelSpread,
  readZipWithUnzip,
  referenceDocumentText,
  xpath,
} from './helpers/office-pair-fixtures';

/**
 * The advertised legacy Office pairs of the registry, converted through the production dispatcher with a real input
 * the reference office suite authored. Each output is read back by a tool that is not part of the converter, and the
 * expected text is the text the fixture was written with. Page images are compared with the reference suite's own render
 * of the same input (page count, pixel size, SSIM); the authored words are checked in the text layer of that reference
 * PDF, and OCR of our pages is only a lenient secondary check.
 */

const PNG_MAGIC = '89504e470d0a1a0a';
const JPEG_MAGIC = 'ffd8ff';
const CFB_MAGIC = 'd0cf11e0a1b11ae1';
const TEST_TIMEOUT_MS = 180_000;
const MIN_VISIBLE_SPREAD = 0.01;

const DOCUMENT_TEXT = normalizeWhitespace(DOCUMENT_PARAGRAPHS.join('\n'));
const SLIDE_TEXTS = SLIDES.map((lines) => normalizeWhitespace(lines.join('\n')));

function startsWithHex(buffer: Buffer, hex: string): boolean {
  return buffer.subarray(0, hex.length / 2).toString('hex') === hex;
}

const authored = new Map<string, Buffer>();

/** The reference suite's file of `format`, authored once per run. */
function sourceFile(format: 'ppt' | 'xls' | 'doc' | 'rtf'): Buffer {
  const cached = authored.get(format);
  if (cached) return cached;
  const file = authorWithReferenceSuite(format);
  authored.set(format, file);
  return file;
}

function expectDecodablePage(page: Buffer, target: PageFormat): void {
  expect(startsWithHex(page, target === 'png' ? PNG_MAGIC : JPEG_MAGIC)).toBe(true);
  expect(identifyImage(page, target).format).toBe(target === 'png' ? 'PNG' : 'JPEG');
  expect(pixelSpread(page, target)).toBeGreaterThan(MIN_VISIBLE_SPREAD);
}

async function convert(input: Buffer, source: string, target: string): Promise<Buffer> {
  const result = await dispatchConversion(input, source, target, {}, `fixture.${source}`);
  expect(result.engineUsed, `${source}->${target} must run on a native engine`).toMatch(/^native-/);
  return result.buffer;
}

describe('ppt output', () => {
  oracleTest(
    'ppt -> odp is an OpenDocument presentation holding the authored slides',
    ['soffice', 'unzip', 'xmllint'],
    async () => {
      const odp = await convert(sourceFile('ppt'), 'ppt', 'odp');
      readZipWithUnzip(odp, (entries) => {
        expect(entries.names[0]).toBe('mimetype');
        expect(entries.read('mimetype').toString('utf-8')).toBe('application/vnd.oasis.opendocument.presentation');
        expect(xpath(entries.read('content.xml'), 'count(//*[local-name()="presentation"])')).toBe('1');
      });
      expect(openDocumentSlideTexts(odp)).toEqual(SLIDE_TEXTS);
    },
    TEST_TIMEOUT_MS
  );

  for (const target of ['png', 'jpg'] as const) {
    oracleTest(
      `ppt -> ${target} is one page per slide that matches the reference render, in slide order`,
      ['soffice', 'unzip', 'identify', 'pdftoppm', 'pdftotext', 'ffmpeg', 'tesseract'],
      async () => {
        const input = sourceFile('ppt');
        const archive = await convert(input, 'ppt', target);
        const reference = renderReferencePages(input, 'ppt', target);
        expectWordsOnReferencePages('ppt reference PDF', reference.pageTexts, SLIDES);
        readZipWithUnzip(archive, (entries) => {
          const names = entries.names.filter((name) => name.endsWith(`.${target}`)).sort();
          const pages = names.map((name) => entries.read(name));
          pages.forEach((page) => expectDecodablePage(page, target));
          expectPagesMatchReference(`ppt -> ${target}`, pages, reference.pages, target);
          pages.forEach((page, index) => expectOcrRecall(`ppt -> ${target} slide ${index + 1}`, page, target, SLIDES[index]));
        });
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('xls output', () => {
  for (const target of ['png', 'jpg'] as const) {
    oracleTest(
      `xls -> ${target} is one page that matches the reference render and shows every cell of the sheet`,
      ['soffice', 'identify', 'pdftoppm', 'pdftotext', 'ffmpeg', 'tesseract'],
      async () => {
        const input = sourceFile('xls');
        const page = await convert(input, 'xls', target);
        const reference = renderReferencePages(input, 'xls', target);
        expectWordsOnReferencePages('xls reference PDF', reference.pageTexts, [SHEET_ROWS.flat()]);
        expectDecodablePage(page, target);
        expectPagesMatchReference(`xls -> ${target}`, [page], reference.pages, target);
        expectOcrRecall(`xls -> ${target}`, page, target, SHEET_ROWS.flat());
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('doc output', () => {
  for (const target of ['png', 'jpg'] as const) {
    oracleTest(
      `doc -> ${target} is one page that matches the reference render and carries the authored paragraphs`,
      ['soffice', 'identify', 'pdftoppm', 'pdftotext', 'ffmpeg', 'tesseract'],
      async () => {
        const input = sourceFile('doc');
        const page = await convert(input, 'doc', target);
        const reference = renderReferencePages(input, 'doc', target);
        expectWordsOnReferencePages('doc reference PDF', reference.pageTexts, [DOCUMENT_PARAGRAPHS]);
        expectDecodablePage(page, target);
        expectPagesMatchReference(`doc -> ${target}`, [page], reference.pages, target);
        expectOcrRecall(`doc -> ${target}`, page, target, DOCUMENT_PARAGRAPHS);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'doc -> rtf is an RTF stream whose text the reference suite reads back as the authored paragraphs',
    ['soffice'],
    async () => {
      const rtf = await convert(sourceFile('doc'), 'doc', 'rtf');
      expect(rtf.subarray(0, 5).toString('latin1')).toBe('{\\rtf');
      expect(referenceDocumentText(rtf, 'rtf')).toBe(DOCUMENT_TEXT);
    },
    TEST_TIMEOUT_MS
  );
});

describe('rtf output', () => {
  oracleTest(
    'rtf -> doc is an OLE Word document whose text the reference suite reads back as the authored paragraphs',
    ['soffice', 'python3'],
    async () => {
      const doc = await convert(sourceFile('rtf'), 'rtf', 'doc');
      expect(startsWithHex(doc, CFB_MAGIC)).toBe(true);
      const facts = compoundFileFacts(doc);
      expect(facts.names).toContain('WordDocument');
      expect(facts.wordDocumentSize).toBeGreaterThan(DOCUMENT_TEXT.length);
      expect(referenceDocumentText(doc, 'doc')).toBe(DOCUMENT_TEXT);
    },
    TEST_TIMEOUT_MS
  );

  for (const target of ['png', 'jpg'] as const) {
    oracleTest(
      `rtf -> ${target} is one page that matches the reference render and carries the authored paragraphs`,
      ['soffice', 'identify', 'pdftoppm', 'pdftotext', 'ffmpeg', 'tesseract'],
      async () => {
        const input = sourceFile('rtf');
        const page = await convert(input, 'rtf', target);
        const reference = renderReferencePages(input, 'rtf', target);
        expectWordsOnReferencePages('rtf reference PDF', reference.pageTexts, [DOCUMENT_PARAGRAPHS]);
        expectDecodablePage(page, target);
        expectPagesMatchReference(`rtf -> ${target}`, [page], reference.pages, target);
        expectOcrRecall(`rtf -> ${target}`, page, target, DOCUMENT_PARAGRAPHS);
      },
      TEST_TIMEOUT_MS
    );
  }
});
