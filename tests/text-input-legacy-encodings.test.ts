import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { decodeTextInput, readTextFileCharacters } from '../src/lib/conversions/text-input';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * Plain text and Markdown that are not UTF-8 (#783: six government text files refused with "Text input is not valid UTF-8").
 * The rule is the one of the HTML encoding sniffing (policy entry 19) with a detector for the encodings that rule cannot
 * reach: a byte order mark, then UTF-8 when the bytes are valid UTF-8, then the encoding the ICU character set detector
 * (`chardet`) finds, and Windows-1252, the standard's default, when it finds nothing; bytes that libmagic does not take for
 * text are still refused.
 *
 * Expected texts come from tools that share no code with the converter: Python 3.13 `bytes.decode('cp1252')` (strict, so an
 * undefined byte would raise) and `iconv -f CP1252 -t UTF-8`, which agree on every real file here. The synthetic bytes come
 * from `str.encode(codec)` of Python.
 */

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const bytesOf = (hex: string): Buffer => Buffer.from(hex, 'hex');

/** id, sha-256 of `bytes.decode('cp1252').encode('utf-8')`, and a run of the text that carries a non-ASCII character (whitespace collapsed). */
const REAL_TEXT_FILES: ReadonlyArray<readonly [id: string, sha256: string, run: string]> = [
  ['govdocs1-000081.txt', '323f57d0ecab8ee82bb8d3c740b1a16f9d3d10a28e61b0d0979df1d508429a1c', '(“ Petitioner”)'],
  ['govdocs1-000219.txt', '92fadc936eb81bcefd30232297ef1a35c6fc2c42ec0867d5f80b2aa7991a9e62', 'the ©nc coming'],
  ['govdocs1-000226.txt', 'df0879bf1754890a7c42b9ffd33ac4ef0988133924f3ec560ed2bca1c0217c03', 'the caf‚ owner'],
  ['govdocs1-000502.txt', 'cef3d38eb4babbee4f9fdfef99066fb17a6a50620399a93aff1c78bcdcf46cc7', '(ß-lactam and'],
  ['govdocs1-001171.txt', '3f5bb4c8b1869f694446b98d5bb996ede0db9992e62df3b8bf73c36a8bdb7534', 'Tolad® SX 9260'],
  ['govdocs1-001559.txt', '1d9742f41afccd5e76d7a807b2e65819d182b38212dd9b986a888c64a7d5c607', 'Commission’s Rules'],
];

/** `str.encode(codec).hex()` of Python for the sentence in the comment. */
const CP1252_QUOTES = bytesOf('48652073616964209368656c6c6f9420962069749273209366696e659420850d0a50726963653a203520802097206f6b2e0d0a'); // He said “hello” – it’s “fine” …\r\nPrice: 5 € — ok.\r\n
const LATIN1_ACCENTS = bytesOf('436166e92064e96ae02076752c206e61ef7665206661e76164652c20fc6265722053747261df652e205365f16f72204dfc6c6c65722061df204be473652e0a'); // Café déjà vu, naïve façade, über Straße. Señor Müller aß Käse.\n
const SHIFT_JIS = bytesOf('93fa967b8cea82cc8365834c83588367837483408343838b82c582b781420a82b182ea82cd95b68e9a8352815b836882cc94bb92e882f08a6d82a982df82e982bd82df82cc95b68fcd82c582b781420a'); // 日本語のテキストファイルです。\nこれは文字コードの判定を確かめるための文章です。\n
const EUC_KR = bytesOf('c7d1b1b9beee20b9aebcadc0d4b4cfb4d92e20b9aec0da20c0cec4dab5f9c0bb20c8aec0cec7cfb4c220b9aec0e5c0d4b4cfb4d92e0a'); // 한국어 문서입니다. 문자 인코딩을 확인하는 문장입니다.\n
const GBK = bytesOf('d5e2cac7d2bbb8f6d6d0cec4cec4b1becec4bcfea3acd3c3c0b4bcecb2e9d7d6b7fbb1e0c2ebb5c4cab6b1f0a1a30a'); // 这是一个中文文本文件，用来检查字符编码的识别。\n

const NOT_UTF8_WARNING = (encoding: string): string => `Text input is not valid UTF-8; it was read as ${encoding}.`;

function pdfWords(pdf: Buffer): string {
  const pdftotext = getOracleToolPath('pdftotext');
  if (!pdftotext) throw new Error('pdftotext is required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-input-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    return execFileSync(pdftotext, ['-q', path.join(dir, 'in.pdf'), '-'], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
      .normalize('NFC')
      .replace(/\s+/g, ' ');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('real text files in a legacy encoding', () => {
  it.for(REAL_TEXT_FILES)('reads %s as Windows-1252, the text Python and iconv decode', { timeout: 60_000 }, async ([id, digest], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    expect(sha256(decodeTextInput(sample.bytes))).toBe(digest);
  });

  it.for(REAL_TEXT_FILES)('converts %s to a PDF that carries its text and says how it was read', { timeout: 120_000 }, async ([id, , run], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    const result = await convertFile(sample.bytes, 'txt', 'pdf', {}, id);
    expect(result.metadata?.warnings).toEqual([NOT_UTF8_WARNING('windows-1252')]);
    const found = pdfWords(result.buffer);
    expect(found).toContain(run);
  });
});

describe('text bytes of a single-byte encoding', () => {
  it('reads smart quotes, dashes and the euro sign of Windows-1252', () => {
    expect(decodeTextInput(CP1252_QUOTES)).toBe('He said “hello” – it’s “fine” …\r\nPrice: 5 € — ok.\r\n');
  });

  it('reads Latin-1 accents', () => {
    expect(decodeTextInput(LATIN1_ACCENTS)).toBe('Café déjà vu, naïve façade, über Straße. Señor Müller aß Käse.\n');
  });

  it('reads the five bytes Windows-1252 leaves undefined as their C1 code points, as the standard does', () => {
    expect(decodeTextInput(Buffer.from('a\x81\x8d\x8f\x90\x9db é', 'latin1'))).toBe('a\u0081\u008d\u008f\u0090\u009db é');
  });

  oracleTest('reads a Markdown file the same way as a text file', ['pdftotext'], async () => {
    const result = await convertFile(Buffer.concat([Buffer.from('# T\n\n'), LATIN1_ACCENTS]), 'md', 'pdf', {}, 'latin1.md');
    expect(result.metadata?.warnings).toEqual([NOT_UTF8_WARNING('windows-1252')]);
    expect(pdfWords(result.buffer).trim()).toBe('T Café déjà vu, naïve façade, über Straße. Señor Müller aß Käse.');
  });

  it('reads a text with too few non-ASCII bytes to tell the encoding as Windows-1252', () => {
    expect(decodeTextInput(Buffer.from('a\té\f', 'latin1'))).toBe('a\té\f');
  });
});

describe('text bytes of a multi-byte encoding', () => {
  it.for([
    ['Shift_JIS', SHIFT_JIS, '日本語のテキストファイルです。\nこれは文字コードの判定を確かめるための文章です。\n'],
    ['EUC-KR', EUC_KR, '한국어 문서입니다. 문자 인코딩을 확인하는 문장입니다.\n'],
    ['GBK', GBK, '这是一个中文文本文件，用来检查字符编码的识别。\n'],
  ] as const)('is detected as %s and read in it', ([, bytes, expected]) => {
    expect(decodeTextInput(bytes)).toBe(expected);
  });

  oracleTest('converts Shift_JIS text to a PDF with its characters', ['pdftotext'], async () => {
    const result = await convertFile(SHIFT_JIS, 'txt', 'pdf', {}, 'sjis.txt');
    expect(result.metadata?.warnings).toEqual([NOT_UTF8_WARNING('shift_jis')]);
    expect(pdfWords(result.buffer).replace(/ /g, '')).toContain('日本語のテキストファイルです。');
  });
});

describe('bytes that are not text', () => {
  it('refuses a binary file with NUL bytes, which no encoding makes text', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000001000000010008060000005c72a866', 'hex');
    expect(() => decodeTextInput(png)).toThrow(/not text/);
  });

  it('refuses a legacy-encoded file with a control byte in its first megabyte', () => {
    expect(() => decodeTextInput(Buffer.concat([LATIN1_ACCENTS, Buffer.from([0x00]), LATIN1_ACCENTS]))).toThrow(/not text/);
    expect(() => decodeTextInput(Buffer.concat([LATIN1_ACCENTS, Buffer.from([0x03]), LATIN1_ACCENTS]))).toThrow(/not text/);
  });

  it('keeps the tab, line feed, form feed, carriage return and escape characters that libmagic takes for text', () => {
    expect(decodeTextInput(Buffer.from('a\té\f\r\n\x1b[0m', 'latin1'))).toBe('a\té\f\r\n\x1b[0m');
  });
});

describe('text that was never refused', () => {
  it('reads UTF-8 and UTF-16 with a byte order mark as before, with no warning', async () => {
    expect(decodeTextInput(Buffer.from('Café “quoted”', 'utf-8'))).toBe('Café “quoted”');
    expect(decodeTextInput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Café', 'utf16le')]))).toBe('Café');
    expect(decodeTextInput(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Café', 'utf16le').swap16()]))).toBe('Café');
  });
});

describe('the characters of a text file scanned for the route of a PDF', () => {
  function withFile<T>(bytes: Buffer, scan: (file: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-scan-'));
    try {
      const file = path.join(dir, 'in.txt');
      fs.writeFileSync(file, bytes);
      return scan(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('gives the distinct characters of a UTF-8 file read in chunks that cut its characters', () => {
    const text = 'ab日本語日本語ab';
    const characters = withFile(Buffer.from(text, 'utf-8'), (file) => readTextFileCharacters(file, 4));
    expect([...characters].sort()).toEqual([...new Set(text)].sort());
  });

  it('reads a Shift_JIS file whole, so the route sees the Japanese letters the conversion draws', () => {
    expect(withFile(SHIFT_JIS, (file) => readTextFileCharacters(file, 4))).toBe(decodeTextInput(SHIFT_JIS));
  });

  it('refuses a binary file as the conversion does', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000001000000010008060000005c72a866', 'hex');
    expect(() => withFile(png, (file) => readTextFileCharacters(file, 4))).toThrow(/not text/);
  });
});
