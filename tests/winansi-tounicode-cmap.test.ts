import { describe, it, expect } from 'vitest';
import iconv from 'iconv-lite';
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { createWinAnsiToUnicodeCMap } from '../src/lib/conversions/ocr-pdf-combiner';
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

  oracleTest('lets pdftotext read the euro sign, curly quotes and dashes of a standard-font page', ['pdftotext'], async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // The CMap is attached to the font dictionary the way a writer that wants searchable standard-font text does it.
    await font.embed();
    const cmapStream = doc.context.stream(createWinAnsiToUnicodeCMap());
    (doc.context.lookup(font.ref) as PDFDict).set(PDFName.of('ToUnicode'), doc.context.register(cmapStream));
    const page = doc.addPage([400, 100]);
    const line = '\u20ac5 \u201cquoted\u201d \u2013 done \u2014 \u2122';
    page.drawText(line, { x: 20, y: 50, size: 14, font });
    const text = extractTextWithExternalPdftotext(Buffer.from(await doc.save()));
    expect(text?.trim()).toBe(line);
  });
});
