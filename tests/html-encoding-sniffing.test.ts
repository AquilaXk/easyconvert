import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { decodeHtmlInput, prescanHtmlEncoding, sniffHtmlEncoding } from '../src/lib/conversions/html-encoding';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { normalizeWhitespace, sofficeConvert } from './helpers/soffice-office';

/** The bytes `iconv` writes for `text` in `charset`; the encoder is the independent side of every case. */
function iconvBytes(text: string, charset: string): Buffer {
  return execFileSync(requireOracleTool('iconv'), ['-f', 'UTF-8', '-t', charset], { input: text });
}

const html = (head: string, body: string): string => `<html><head>${head}</head><body><p>${body}</p></body></html>`;
const LATIN_TEXT = 'The “Magnum-1” launch – café — naïve ™';
const JAPANESE_TEXT = '日本語のテキストです';

describe('HTML encoding sniffing (WHATWG order: byte order mark, meta declaration, UTF-8 check, Windows-1252)', () => {
  oracleTest('reads Windows-1252 bytes of a file that declares nothing (curly quotes are 0x92-style bytes, not mojibake)', ['iconv'], () => {
    const bytes = iconvBytes(html('<title>t</title>', LATIN_TEXT), 'CP1252');
    expect(bytes.includes(0x93)).toBe(true);
    expect(sniffHtmlEncoding(bytes)).toEqual({ encoding: 'windows-1252', source: 'default' });
    expect(decodeHtmlInput(bytes)).toContain(LATIN_TEXT);
  });

  it('keeps valid UTF-8 bytes of a file that declares nothing as UTF-8', () => {
    const bytes = Buffer.from(html('', LATIN_TEXT), 'utf-8');
    expect(sniffHtmlEncoding(bytes)).toEqual({ encoding: 'utf-8', source: 'valid-utf8' });
    expect(decodeHtmlInput(bytes)).toContain(LATIN_TEXT);
  });

  oracleTest('follows <meta charset> for a legacy East Asian encoding', ['iconv'], () => {
    const bytes = iconvBytes(html('<meta charset="shift_jis">', JAPANESE_TEXT), 'SHIFT_JIS');
    expect(sniffHtmlEncoding(bytes)).toEqual({ encoding: 'shift_jis', source: 'declared' });
    expect(decodeHtmlInput(bytes)).toContain(JAPANESE_TEXT);
  });

  oracleTest('follows the http-equiv Content-Type form and maps ISO-8859-1 to Windows-1252 as the standard does', ['iconv'], () => {
    const head = '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=ISO-8859-1">';
    const bytes = iconvBytes(html(head, 'café über'), 'ISO-8859-1');
    expect(sniffHtmlEncoding(bytes)).toEqual({ encoding: 'windows-1252', source: 'declared' });
    expect(decodeHtmlInput(bytes)).toContain('café über');
  });

  it('lets a byte order mark win over a conflicting declaration', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html('<meta charset="windows-1252">', 'café'), 'utf-8')]);
    expect(sniffHtmlEncoding(bytes)).toEqual({ encoding: 'utf-8', source: 'bom' });
    const text = decodeHtmlInput(bytes);
    expect(text.startsWith('<html>')).toBe(true);
    expect(text).toContain('café');
  });

  it('decodes UTF-16 with a byte order mark', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html('', 'café'), 'utf16le')]);
    expect(sniffHtmlEncoding(bytes).encoding).toBe('utf-16le');
    expect(decodeHtmlInput(bytes)).toContain('café');
  });

  it('ignores a meta element outside the first 1024 bytes, inside a comment, or with an unknown label', () => {
    const late = Buffer.from(`<html><head><!-- ${'x'.repeat(1100)} --><meta charset="shift_jis"></head>é`, 'latin1');
    expect(prescanHtmlEncoding(late)).toBeNull();
    expect(prescanHtmlEncoding(Buffer.from('<!-- <meta charset="shift_jis"> --><p>a</p>'))).toBeNull();
    expect(prescanHtmlEncoding(Buffer.from('<meta charset="no-such-charset"><p>a</p>'))).toBeNull();
    expect(prescanHtmlEncoding(Buffer.from('<meta content="text/html; charset=shift_jis"><p>a</p>'))).toBeNull();
  });

  it('takes a declared UTF-16 as UTF-8 and never reads an escape-based encoding', () => {
    expect(prescanHtmlEncoding(Buffer.from('<meta charset="utf-16le">'))).toBe('utf-8');
    expect(prescanHtmlEncoding(Buffer.from('<meta charset="iso-2022-kr">'))).toBeNull();
  });

  it('replaces bytes that are invalid in the declared encoding with U+FFFD instead of refusing the document', () => {
    const bytes = Buffer.concat([Buffer.from('<meta charset="utf-8"><p>a'), Buffer.from([0xff]), Buffer.from('b</p>')]);
    expect(decodeHtmlInput(bytes)).toBe('<meta charset="utf-8"><p>a�b</p>');
  });
});

describe('HTML without a declared charset converts', () => {
  oracleTest('to PDF with the words of the Windows-1252 text (pdftotext) and to txt as the office suite reads it', ['iconv', 'pdftotext', 'soffice'], async () => {
    const body = 'Spaceport “News” from Cape Canaveral';
    const bytes = iconvBytes(html('<title>News</title>', body), 'CP1252');
    const pdf = (await convertFile(bytes, 'html', 'pdf', {}, 'news.html')).buffer;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-sniff-'));
    try {
      fs.writeFileSync(path.join(dir, 'out.pdf'), pdf);
      const text = execFileSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', path.join(dir, 'out.pdf'), '-'], { encoding: 'utf-8' });
      expect(normalizeWhitespace(text)).toContain(body);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // The office suite reads the quote bytes as C1 controls (ISO-8859-1), so only the words are compared with it.
    const oracle = sofficeConvert(bytes, 'html', 'txt:Text', 'txt').toString('utf-8');
    expect(oracle.match(/\p{L}+/gu)).toEqual(body.match(/\p{L}+/gu));
    const txt = (await convertFile(bytes, 'html', 'txt', {}, 'news.html')).buffer.toString('utf-8');
    expect(normalizeWhitespace(txt)).toContain(body);
  }, 180_000);
});
