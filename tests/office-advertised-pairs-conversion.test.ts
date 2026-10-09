import { describe, expect } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { oracleTest } from './helpers/oracle-test';
import { normalizeWhitespace } from './helpers/soffice-office';
import {
  DOCUMENT_PARAGRAPHS,
  SHEET_ROWS,
  SLIDES,
  authorWithReferenceSuite,
  compoundFileFacts,
  identifyImage,
  ocrText,
  openDocumentSlideTexts,
  pixelSpread,
  readZipWithUnzip,
  referenceDocumentText,
  xpath,
} from './helpers/office-pair-fixtures';

/**
 * The advertised legacy Office pairs of the registry, converted through the production dispatcher with a real input
 * the reference office suite authored. Each output is read back by a tool that is not part of the converter, and the
 * expected text is the text the fixture was written with.
 */

const PNG_MAGIC = '89504e470d0a1a0a';
const JPEG_MAGIC = 'ffd8ff';
const CFB_MAGIC = 'd0cf11e0a1b11ae1';
const TEST_TIMEOUT_MS = 180_000;
const MIN_VISIBLE_SPREAD = 0.01;
const A4_150_DPI = { width: 1241, height: 1754 };

const DOCUMENT_TEXT = normalizeWhitespace(DOCUMENT_PARAGRAPHS.join('\n'));
const SLIDE_TEXTS = SLIDES.map((lines) => normalizeWhitespace(lines.join('\n')));

function startsWithHex(buffer: Buffer, hex: string): boolean {
  return buffer.subarray(0, hex.length / 2).toString('hex') === hex;
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
      const odp = await convert(authorWithReferenceSuite('ppt'), 'ppt', 'odp');
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
      `ppt -> ${target} is one decodable ${target} per slide, in slide order, carrying the slide text`,
      ['soffice', 'unzip', 'identify', 'magick', 'tesseract'],
      async () => {
        const archive = await convert(authorWithReferenceSuite('ppt'), 'ppt', target);
        readZipWithUnzip(archive, (entries) => {
          const pages = entries.names.filter((name) => name.endsWith(`.${target}`)).sort();
          expect(pages).toHaveLength(SLIDES.length);
          pages.forEach((name, index) => {
            const image = entries.read(name);
            expect(startsWithHex(image, target === 'png' ? PNG_MAGIC : JPEG_MAGIC)).toBe(true);
            const info = identifyImage(image, target);
            expect(info.format).toBe(target === 'png' ? 'PNG' : 'JPEG');
            expect(info.width).toBeGreaterThan(0);
            expect(info.height).toBeGreaterThan(0);
            expect(pixelSpread(image, target)).toBeGreaterThan(MIN_VISIBLE_SPREAD);
            const text = ocrText(image, target).toLowerCase();
            for (const word of SLIDES[index].flatMap((line) => line.toLowerCase().split(' '))) {
              expect(text, `slide ${index + 1} must show "${word}"`).toContain(word);
            }
          });
        });
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('xls output', () => {
  for (const target of ['png', 'jpg'] as const) {
    oracleTest(
      `xls -> ${target} is a decodable page image showing every cell of the sheet`,
      ['soffice', 'identify', 'magick', 'tesseract'],
      async () => {
        const image = await convert(authorWithReferenceSuite('xls'), 'xls', target);
        expect(startsWithHex(image, target === 'png' ? PNG_MAGIC : JPEG_MAGIC)).toBe(true);
        const info = identifyImage(image, target);
        expect(info.format).toBe(target === 'png' ? 'PNG' : 'JPEG');
        expect(info).toMatchObject(A4_150_DPI);
        expect(pixelSpread(image, target)).toBeGreaterThan(MIN_VISIBLE_SPREAD);
        const text = ocrText(image, target);
        for (const cell of SHEET_ROWS.flat()) {
          expect(text).toContain(cell);
        }
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('doc output', () => {
  for (const target of ['png', 'jpg'] as const) {
    oracleTest(
      `doc -> ${target} is a decodable page image carrying the authored paragraphs`,
      ['soffice', 'identify', 'magick', 'tesseract'],
      async () => {
        const image = await convert(authorWithReferenceSuite('doc'), 'doc', target);
        expect(startsWithHex(image, target === 'png' ? PNG_MAGIC : JPEG_MAGIC)).toBe(true);
        const info = identifyImage(image, target);
        expect(info.format).toBe(target === 'png' ? 'PNG' : 'JPEG');
        expect(info).toMatchObject(A4_150_DPI);
        expect(pixelSpread(image, target)).toBeGreaterThan(MIN_VISIBLE_SPREAD);
        const text = ocrText(image, target);
        expect(text).toContain('Quarterly review heading');
        expect(text).toContain('revenue growth');
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'doc -> rtf is an RTF stream whose text the reference suite reads back as the authored paragraphs',
    ['soffice'],
    async () => {
      const rtf = await convert(authorWithReferenceSuite('doc'), 'doc', 'rtf');
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
      const doc = await convert(authorWithReferenceSuite('rtf'), 'rtf', 'doc');
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
      `rtf -> ${target} is a decodable page image carrying the authored paragraphs`,
      ['soffice', 'identify', 'magick', 'tesseract'],
      async () => {
        const image = await convert(authorWithReferenceSuite('rtf'), 'rtf', target);
        expect(startsWithHex(image, target === 'png' ? PNG_MAGIC : JPEG_MAGIC)).toBe(true);
        const info = identifyImage(image, target);
        expect(info.format).toBe(target === 'png' ? 'PNG' : 'JPEG');
        expect(info).toMatchObject(A4_150_DPI);
        expect(pixelSpread(image, target)).toBeGreaterThan(MIN_VISIBLE_SPREAD);
        expect(ocrText(image, target)).toContain('revenue growth');
      },
      TEST_TIMEOUT_MS
    );
  }
});
