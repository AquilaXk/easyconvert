import { describe, it, expect } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { extractTextFromDoc } from '../src/lib/conversions/office';
import { DOC_MAX_PIECES } from '../src/lib/conversions/office/doc-reader';
import { EncryptedOfficeDocumentError, LegacyOfficeFormatError } from '../src/lib/conversions/office/legacy-office-errors';
import { oracleTest } from './helpers/oracle-test';
import { buildCompoundFile } from './helpers/cfb-craft';
import { buildWordBinary } from './helpers/word-binary-builder';
import { flatOdt, normalizeWhitespace, sofficeConvert } from './helpers/soffice-office';

const PLACEHOLDER_PATTERN = /Extracted document content|document content\b|\[Text:/i;
const BOM = '﻿';
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;

/** Paragraphs written by the test: accented Latin, Hangul, Japanese and Latin with punctuation. */
const AUTHORED_PARAGRAPHS = [
  'Résumé café naïve déjà vu',
  '한국어 문서의 텍스트입니다',
  '日本語のテキスト and “smart quotes” – dash',
  'Plain ASCII line 42',
];

function expectNoPlaceholder(text: string): void {
  expect(text).not.toMatch(PLACEHOLDER_PATTERN);
}

describe('Word 97-2003 text extraction from hand-written documents', () => {
  it('reads one UTF-16 piece of Korean and accented text', () => {
    const text = 'Résumé 한국어 문서\r두 번째 문단\r';
    const doc = buildWordBinary({ pieces: [{ text, compressed: false }] });
    expect(extractTextFromDoc(doc)).toBe('Résumé 한국어 문서\n두 번째 문단');
  });

  it('follows the piece table across compressed and UTF-16 pieces stored out of order', () => {
    const doc = buildWordBinary({
      pieces: [
        { text: 'Café “quoted” – €5\r', compressed: true },
        { text: '日本語 piece\r', compressed: false },
        { text: 'Final ASCII piece\r', compressed: true },
      ],
      reversePhysicalOrder: true,
    });
    expect(extractTextFromDoc(doc)).toBe('Café “quoted” – €5\n日本語 piece\nFinal ASCII piece');
  });

  it('keeps field results, drops field instructions and maps cell and row marks', () => {
    const text = 'See \x13 HYPERLINK "http://example.invalid/x" \x14the report\x15 now\rA\x07B\x07\x07C\x07D\x07\x07';
    const doc = buildWordBinary({ pieces: [{ text, compressed: false }] });
    expect(extractTextFromDoc(doc)).toBe('See the report now\nA\tB\nC\tD');
  });

  it('keeps line breaks, tabs and hyphen characters', () => {
    const doc = buildWordBinary({ pieces: [{ text: 'one\x0Btwo\x09three\x1Efour\x1Fdash\r', compressed: false }] });
    expect(extractTextFromDoc(doc)).toBe('one\ntwo\tthree-fourdash');
  });

  it('reads only the main story, not the footnote story that follows it', () => {
    const doc = buildWordBinary({
      pieces: [{ text: 'Body text only\r', compressed: true }],
      footnote: 'FOOTNOTE-STORY-TEXT\r',
    });
    expect(extractTextFromDoc(doc)).toBe('Body text only');
  });

  it('skips Prc entries that precede the piece table and honours fWhichTblStm', () => {
    const doc = buildWordBinary({ pieces: [{ text: 'Table zero text\r', compressed: true }], prcBytes: 6, tableStream0: true });
    expect(extractTextFromDoc(doc)).toBe('Table zero text');
  });
});

describe('Word 97-2003 fail-closed behaviour', () => {
  it('rejects bytes that are not a compound file instead of scraping them', () => {
    const plain = Buffer.from('This is a legacy binary Word document payload with readable ASCII text.', 'utf-8');
    expect(() => extractTextFromDoc(plain)).toThrow(LegacyOfficeFormatError);
  });

  it('never answers with a placeholder for an empty or garbage input', () => {
    for (const input of [Buffer.alloc(0), Buffer.alloc(2048, 0x41), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]) {
      let thrown: unknown;
      let returned: string | undefined;
      try {
        returned = extractTextFromDoc(input);
      } catch (err) {
        thrown = err;
      }
      expect(returned).toBeUndefined();
      expect(thrown).toBeInstanceOf(LegacyOfficeFormatError);
      expect((thrown as LegacyOfficeFormatError).status).toBe(HTTP_BAD_REQUEST);
    }
  });

  it('answers an encrypted document with a 422 error', () => {
    const doc = buildWordBinary({ pieces: [{ text: 'Secret\r', compressed: true }], encrypted: true });
    let thrown: unknown;
    try {
      extractTextFromDoc(doc);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EncryptedOfficeDocumentError);
    expect((thrown as EncryptedOfficeDocumentError).status).toBe(HTTP_UNPROCESSABLE);
  });

  it('rejects a document whose compound file lacks the table stream', () => {
    const word = buildCompoundFile([{ name: 'WordDocument', data: Buffer.alloc(5000) }]);
    expect(() => extractTextFromDoc(word)).toThrow(LegacyOfficeFormatError);
  });

  it('rejects a Word stream without the Word signature', () => {
    const doc = buildCompoundFile([
      { name: 'WordDocument', data: Buffer.alloc(5000) },
      { name: '1Table', data: Buffer.alloc(512) },
    ]);
    expect(() => extractTextFromDoc(doc)).toThrow(/signature/);
  });

  it('rejects a text piece that lies outside the WordDocument stream', () => {
    const doc = buildWordBinary({ pieces: [{ text: 'Short text\r', compressed: true }], fcShift: 1_000_000 });
    expect(() => extractTextFromDoc(doc)).toThrow(/outside the WordDocument stream/);
  });

  it('rejects a piece table with more pieces than the limit', () => {
    const oversized = DOC_MAX_PIECES + 1;
    const plcBytes = 4 + oversized * 12;
    const clx = Buffer.alloc(5 + plcBytes);
    clx[0] = 0x02;
    clx.writeUInt32LE(plcBytes, 1);
    const word = Buffer.alloc(5000);
    word.writeUInt16LE(0xa5ec, 0);
    word.writeUInt16LE(0x00c1, 2);
    word.writeUInt16LE(0x0200, 10);
    word.writeUInt16LE(14, 32);
    word.writeUInt16LE(22, 62);
    word.writeUInt32LE(4, 76);
    word.writeUInt16LE(93, 152);
    word.writeUInt32LE(0, 154 + 33 * 8);
    word.writeUInt32LE(clx.length, 154 + 33 * 8 + 4);
    const file = buildCompoundFile([
      { name: 'WordDocument', data: word },
      { name: '1Table', data: clx },
    ]);
    expect(() => extractTextFromDoc(file)).toThrow(/more than the 262144 limit/);
  });

  it('rejects a document that holds no text', () => {
    const doc = buildWordBinary({ pieces: [{ text: '\r\r', compressed: true }] });
    expect(() => extractTextFromDoc(doc)).toThrow(LegacyOfficeFormatError);
  });
});

describe('Word 97-2003 text extraction against LibreOffice', () => {
  oracleTest('matches the authored text and the LibreOffice text export of a Korean and Latin document', ['soffice'], () => {
    const source = flatOdt(AUTHORED_PARAGRAPHS);
    const doc = sofficeConvert(source, 'fodt', 'doc', 'doc');
    const reference = sofficeConvert(doc, 'doc', 'txt:Text (encoded):UTF8', 'txt').toString('utf-8').replace(BOM, '');

    const extracted = extractTextFromDoc(doc);

    expectNoPlaceholder(extracted);
    expect(normalizeWhitespace(extracted)).toBe(normalizeWhitespace(AUTHORED_PARAGRAPHS.join(' ')));
    expect(normalizeWhitespace(extracted)).toBe(normalizeWhitespace(reference));
  }, 180_000);

  oracleTest('reads a Latin-only LibreOffice document', ['soffice'], () => {
    const paragraphs = ['Compressed piece text with café and “quotes”', 'Second line: 3 × 4 = 12'];
    const doc = sofficeConvert(flatOdt(paragraphs), 'fodt', 'doc', 'doc');
    expect(normalizeWhitespace(extractTextFromDoc(doc))).toBe(normalizeWhitespace(paragraphs.join(' ')));
  }, 180_000);

  oracleTest('reads a LibreOffice document with a hyperlink field, table, tab and line break', ['soffice'], () => {
    const rich = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text>' +
        '<text:p>See <text:a xlink:href="http://example.invalid/x">the report</text:a> now<text:line-break/>after break<text:tab/>tabbed</text:p>' +
        '<table:table table:name="T1"><table:table-column table:number-columns-repeated="2"/>' +
        '<table:table-row><table:table-cell office:value-type="string"><text:p>A1</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>B1</text:p></table:table-cell></table:table-row>' +
        '<table:table-row><table:table-cell office:value-type="string"><text:p>A2</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>B2</text:p></table:table-cell></table:table-row>' +
        '</table:table></office:text></office:body></office:document>',
      'utf-8'
    );
    const doc = sofficeConvert(rich, 'fodt', 'doc', 'doc');
    const reference = sofficeConvert(doc, 'doc', 'txt:Text (encoded):UTF8', 'txt').toString('utf-8').replace(BOM, '');
    const extracted = extractTextFromDoc(doc);
    expect(extracted).toBe('See the report now\nafter break\ttabbed\nA1\tB1\nA2\tB2');
    expect(normalizeWhitespace(extracted)).toBe(normalizeWhitespace(reference));
  }, 180_000);

  oracleTest('reads compressed and out-of-order pieces of a hand-built document the way LibreOffice does', ['soffice'], () => {
    const doc = buildWordBinary({
      pieces: [
        { text: 'Café “quoted” – €5\r', compressed: true },
        { text: '日本語 piece\r', compressed: false },
        { text: 'Final ASCII piece\r', compressed: true },
      ],
      reversePhysicalOrder: true,
    });
    const reference = sofficeConvert(doc, 'doc', 'txt:Text (encoded):UTF8', 'txt').toString('utf-8').replace(BOM, '');
    expect(normalizeWhitespace(reference)).toBe('Café “quoted” – €5 日本語 piece Final ASCII piece');
    expect(normalizeWhitespace(extractTextFromDoc(doc))).toBe(normalizeWhitespace(reference));
  }, 180_000);

  oracleTest('converts a LibreOffice document to txt and html through the dispatcher', ['soffice'], async () => {
    const doc = sofficeConvert(flatOdt(AUTHORED_PARAGRAPHS), 'fodt', 'doc', 'doc');
    const txt = await convertFile(doc, 'doc', 'txt', {}, 'sample.doc');
    expect(normalizeWhitespace(txt.buffer.toString('utf-8'))).toBe(normalizeWhitespace(AUTHORED_PARAGRAPHS.join(' ')));
    const html = await convertFile(doc, 'doc', 'html', {}, 'sample.doc');
    for (const paragraph of AUTHORED_PARAGRAPHS) {
      expect(html.buffer.toString('utf-8')).toContain(paragraph.replace(/&/g, '&amp;'));
    }
  }, 180_000);
});

describe('doc conversion API errors', () => {
  it('fails a malformed .doc conversion with a typed 400 error and no placeholder text', async () => {
    const garbage = Buffer.from('plain readable text that is not a Word document', 'utf-8');
    const run = convertFile(garbage, 'doc', 'txt', {}, 'bad.doc');
    await expect(run).rejects.toBeInstanceOf(LegacyOfficeFormatError);
    await expect(run).rejects.toMatchObject({ status: HTTP_BAD_REQUEST });
  });
});
