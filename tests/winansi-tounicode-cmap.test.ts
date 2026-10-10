import { describe, it, expect } from 'vitest';
import iconv from 'iconv-lite';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { applyPdfWatermark } from '../src/lib/conversions/pdf-postprocess/watermark';
import { createWinAnsiToUnicodeCMap } from '../src/lib/conversions/pdf-winansi-tounicode';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { lookupCode, readToUnicodeCMap } from './helpers/cmap-reader';

/**
 * The ToUnicode CMap attached to fonts that use WinAnsiEncoding must decode each code the way WinAnsiEncoding does
 * (PDF 32000-1 Annex D.2: Windows code page 1252, with the unused codes shown as the bullet), otherwise copying or
 * searching text with an euro sign, curly quotes, dashes or a bullet yields C1 control characters. The expectation
 * comes from iconv-lite's windows-1252 tables, not from the generator (Node's TextDecoder is not used: it decodes
 * windows-1252 as Latin-1).
 */

const WINANSI_CODESPACE_MAX = 0xff;
const FIRST_PRINTABLE_CODE = 0x20;
/** WinAnsiEncoding shows these five unused windows-1252 codes as the bullet (Annex D.2, note on unused codes). */
const UNUSED_CODES_SHOWN_AS_BULLET = [0x81, 0x8d, 0x8f, 0x90, 0x9d];
const BULLET = '•';


describe('WinAnsi ToUnicode CMap', () => {
  const cmap = readToUnicodeCMap(createWinAnsiToUnicodeCMap());

  it('declares a one-byte codespace', () => {
    expect(cmap.name).toBe('WinAnsi-ToUnicode');
    expect(cmap.codespaces).toEqual([{ low: 0, high: WINANSI_CODESPACE_MAX, bytes: 1 }]);
  });

  it('decodes every printable code as windows-1252 does', () => {
    const wrong: Array<{ code: string; got: string | undefined; want: string }> = [];
    for (let code = FIRST_PRINTABLE_CODE; code <= WINANSI_CODESPACE_MAX; code++) {
      const want = UNUSED_CODES_SHOWN_AS_BULLET.includes(code) ? BULLET : iconv.decode(Buffer.of(code), 'win1252');
      const got = lookupCode(cmap, code);
      if (got !== want) wrong.push({ code: `0x${code.toString(16)}`, got, want });
    }
    expect(wrong).toEqual([]);
  });

  it('maps the characters that differ from Latin-1 to their real code points', () => {
    expect(lookupCode(cmap, 0x80)).toBe('€');
    expect(lookupCode(cmap, 0x93)).toBe('“');
    expect(lookupCode(cmap, 0x94)).toBe('”');
    expect(lookupCode(cmap, 0x96)).toBe('–');
    expect(lookupCode(cmap, 0x97)).toBe('—');
    expect(lookupCode(cmap, 0x99)).toBe('™');
  });
});

/**
 * The standard-font text this product writes is the watermark stamped by applyPdfWatermark (Helvetica-Bold, which pdf-lib
 * encodes with WinAnsiEncoding). The page below goes through that entry point; nothing here attaches the CMap by hand.
 */
describe('a text watermark carries the WinAnsi ToUnicode CMap', () => {
  const WATERMARK = '\u20ac5 \u201cquoted\u201d \u2013 done \u2014 \u2122';
  const PAGE_WIDTH = 400;
  const PAGE_HEIGHT = 200;
  const WATERMARK_SIZE = 14;

  async function stampedPdf(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const blank = Buffer.from(await doc.save());
    return applyPdfWatermark(blank, { text: WATERMARK, rotation: 0, fontSize: WATERMARK_SIZE, opacity: 1 });
  }

  /** The font dictionaries of the first page, read from the saved file with a fresh parse. */
  async function pageFontDicts(pdf: Buffer): Promise<PDFDict[]> {
    const reloaded = await PDFDocument.load(pdf);
    const fonts = reloaded.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    if (!fonts) throw new Error('the stamped page has no font resources');
    return fonts.keys().map((key) => fonts.lookup(key, PDFDict));
  }

  it('writes the text in a WinAnsiEncoding standard font whose /ToUnicode decodes each byte as windows-1252 does', async () => {
    const [font, ...others] = await pageFontDicts(await stampedPdf());
    expect(others).toEqual([]);
    expect(font.lookup(PDFName.of('Encoding'))).toBe(PDFName.of('WinAnsiEncoding'));
    expect(font.lookup(PDFName.of('BaseFont'))).toBe(PDFName.of('Helvetica-Bold'));
    const stream = font.lookup(PDFName.of('ToUnicode'));
    if (!(stream instanceof PDFRawStream)) throw new Error('the watermark font has no /ToUnicode stream');
    const cmap = readToUnicodeCMap(Buffer.from(stream.getContents()).toString('latin1'));
    // The bytes the watermark is drawn with, per the Windows 1252 tables of iconv-lite (an independent source).
    const bytes = iconv.encode(WATERMARK, 'win1252');
    const decoded = [...bytes].map((code) => lookupCode(cmap, code)).join('');
    expect(decoded).toBe(WATERMARK);
  });

  oracleTest('lets pdftotext read the euro sign, curly quotes and dashes of the stamped page', ['pdftotext'], async () => {
    const text = extractTextWithExternalPdftotext(await stampedPdf());
    expect(text?.trim()).toBe(WATERMARK);
  });
});
