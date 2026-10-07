import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { convertFile } from '../src/lib/conversions';
import { extractTextFromRtf } from '../src/lib/conversions/office';
import {
  RTF_MAX_CONTROL_WORD_LENGTH,
  RTF_MAX_GROUP_DEPTH,
  RTF_MAX_PARAMETER_DIGITS,
} from '../src/lib/conversions/office/rtf-reader';
import { LegacyOfficeFormatError } from '../src/lib/conversions/office/legacy-office-errors';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { flatOdt, normalizeWhitespace, sofficeConvert } from './helpers/soffice-office';

const PLACEHOLDER_PATTERN = /Extracted document content|document content\b|\[Text:/i;
const HTTP_BAD_REQUEST = 400;

function rtf(body: string): Buffer {
  return Buffer.from(body, 'latin1');
}

/** The RTF `\'hh` spelling of the bytes `iconv` produces for `text` in `charset`. */
function iconvEscapes(text: string, charset: string): string {
  const bytes = execFileSync(requireOracleTool('iconv'), ['-f', 'UTF-8', '-t', charset], { input: text });
  return [...bytes].map((b) => `\\'${b.toString(16).padStart(2, '0')}`).join('');
}

describe('RTF Unicode escapes', () => {
  it('reads \\uN as a signed 16-bit code unit and skips one \\ucN fallback character', () => {
    expect(extractTextFromRtf(rtf('{\\rtf1\\ansi\\uc1 a\\u233?b\\u-10916?c\\u54620?d}'))).toBe('aéb한c한d');
  });

  it('skips the fallback bytes that \\uc2 declares, one per \\\'hh escape', () => {
    expect(extractTextFromRtf(rtf("{\\rtf1\\ansi\\uc2 \\u233\\'e9\\'e9x}"))).toBe('éx');
  });

  it('keeps the character after \\u when \\uc0 declares no fallback', () => {
    expect(extractTextFromRtf(rtf('{\\rtf1\\ansi\\uc0 \\u233 x}'))).toBe('éx');
  });

  it('restores \\uc at the end of the group that changed it', () => {
    expect(extractTextFromRtf(rtf('{\\rtf1\\ansi\\uc1 {\\uc0 \\u233 a}\\u233?b}'))).toBe('éaéb');
  });

  it('joins a surrogate pair written as two \\u escapes', () => {
    expect(extractTextFromRtf(rtf('{\\rtf1\\ansi \\u-10179?\\u-8704? done}'))).toBe('\u{1F600} done');
  });

  it('reads the escapes the platform writes: \\uN? and \\par followed by a line feed', () => {
    const written = '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\fs24 caf\\u233?\\par\n\\u54620?\\u44397?}\n';
    expect(extractTextFromRtf(rtf(written))).toBe('café\n한국');
  });
});

describe('RTF 8-bit escapes and code pages', () => {
  it("decodes \\'hh in Windows-1252, including bytes the Latin-1 range lacks", () => {
    const text = extractTextFromRtf(rtf("{\\rtf1\\ansi\\ansicpg1252 caf\\'e9 \\'93quoted\\'94 \\'80 5 \\'96 \\'85}"));
    expect(text).toBe('café “quoted” € 5 – …');
  });

  it("decodes Shift_JIS through the document code page (hand-written bytes)", () => {
    const text = extractTextFromRtf(rtf("{\\rtf1\\ansi\\ansicpg932\\deff0{\\fonttbl{\\f0\\fnil\\fcharset128 MS Mincho;}}\\f0 \\'93\\'fa\\'96\\'7b\\'8c\\'ea}"));
    expect(text).toBe('日本語');
  });

  it('uses the charset of the current font, not the document code page, for \\\'hh bytes', () => {
    const body =
      "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}{\\f1\\fnil\\fcharset129 Malgun Gothic;}}" +
      "\\f0 caf\\'e9 \\f1 \\'c7\\'d1\\'b1\\'b9}";
    expect(extractTextFromRtf(rtf(body))).toBe('café 한국');
  });

  it('decodes unescaped high bytes in the document code page', () => {
    const body = Buffer.concat([Buffer.from('{\\rtf1\\ansi\\ansicpg1252 caf'), Buffer.from([0xe9]), Buffer.from('}')]);
    expect(extractTextFromRtf(body)).toBe('café');
  });

  const iconvCases: [string, number, string, number][] = [
    ['CP949', 949, '한국어 문서', 129],
    ['GBK', 936, '中文文档', 134],
    ['BIG5', 950, '中文文件', 136],
    ['SHIFT_JIS', 932, '日本語の文書', 128],
    ['CP1251', 1251, 'Привет мир', 204],
  ];
  for (const [charset, codepage, text, fcharset] of iconvCases) {
    oracleTest(`decodes ${charset} text produced by iconv (code page ${codepage})`, ['iconv'], () => {
      const body = `{\\rtf1\\ansi\\ansicpg${codepage}\\deff0{\\fonttbl{\\f0\\fnil\\fcharset${fcharset} Font;}}\\f0 ${iconvEscapes(text, charset)}}`;
      expect(extractTextFromRtf(rtf(body))).toBe(text);
    });
  }

  it('refuses a code page it cannot decode instead of guessing', () => {
    expect(() => extractTextFromRtf(rtf("{\\rtf1\\ansi\\ansicpg437 \\'80}"))).toThrow(/code page 437 is not supported/);
  });
});

describe('RTF groups, destinations and special characters', () => {
  it('skips tables, metadata, unknown starred destinations and headers but keeps nested group text', () => {
    const body =
      '{\\rtf1\\ansi{\\fonttbl{\\f0 Times;}}{\\colortbl;\\red0\\green0\\blue0;}{\\stylesheet{\\s0 Normal;}}' +
      '{\\*\\generator Msftedit 5.41.21;}{\\info{\\title Secret Title}{\\author Someone}}{\\*\\unknowndest hidden text}' +
      '\\pard Visible {\\b bold {\\i nested}} text\\par {\\header header text}{\\footnote\\pard footnote body} End}';
    expect(extractTextFromRtf(rtf(body))).toBe('Visible bold nested text\nfootnote body End');
  });

  it('keeps a field result and drops the field instruction', () => {
    const body = '{\\rtf1\\ansi See {\\field{\\*\\fldinst HYPERLINK "http://example.invalid/x"}{\\fldrslt {\\ul the report}}} now}';
    expect(extractTextFromRtf(rtf(body))).toBe('See the report now');
  });

  it('keeps the text of a starred destination the reader understands', () => {
    const body = '{\\rtf1\\ansi{\\shp{\\*\\shpinst{\\sp{\\sn fFlipH}{\\sv 0}}{\\shptxt Box text}}}}';
    expect(extractTextFromRtf(rtf(body))).toBe('Box text');
  });

  it('maps table cells to tabs and rows to line breaks', () => {
    const body = '{\\rtf1\\ansi\\trowd\\cellx1000\\cellx2000\\intbl A\\cell B\\cell\\row\\trowd\\cellx1000\\cellx2000\\intbl C\\cell D\\cell\\row}';
    expect(extractTextFromRtf(rtf(body))).toBe('A\tB\nC\tD');
  });

  it('maps control symbols and character words', () => {
    const body = '{\\rtf1\\ansi a\\~b\\_c\\-d \\{e\\} \\\\ f\\tab g\\line h\\emdash i\\endash j\\bullet k\\lquote l\\rdblquote}';
    expect(extractTextFromRtf(rtf(body))).toBe('a\u00a0b\u2011cd {e} \\ f\tg\nh—i–j•k‘l”');
  });

  it('ignores raw line breaks and treats a backslash line break as a paragraph end', () => {
    expect(extractTextFromRtf(rtf('{\\rtf1\\ansi one\r\ntwo\\\nthree}'))).toBe('onetwo\nthree');
  });

  it('skips the raw bytes of \\bin without parsing them', () => {
    const body = Buffer.concat([Buffer.from('{\\rtf1 A{\\pict\\bin4 '), Buffer.from('}{}\\'), Buffer.from('}B}')]);
    expect(extractTextFromRtf(body)).toBe('AB');
  });

  it('keeps the Unicode form of a \\upr / \\ud pair of destinations out of the body', () => {
    const body = '{\\rtf1\\ansi{\\info{\\upr{\\title Ansi}}{\\*\\ud{\\title Unicode}}}Body}';
    expect(extractTextFromRtf(rtf(body))).toBe('Body');
  });
});

describe('RTF fail-closed behaviour', () => {
  const malformed: [string, Buffer, RegExp][] = [
    ['text that is not RTF', Buffer.from('just some text', 'utf-8'), /RTF header/],
    ['an unclosed group', rtf('{\\rtf1\\ansi abc'), /open group/],
    ['an unmatched closing brace', rtf('{\\rtf1 a}}'), /closing brace|unexpected data/],
    ['data after the root group', rtf('{\\rtf1 a}garbage'), /follows the end/],
    ["a truncated \\' escape", rtf("{\\rtf1 a\\'"), /cut off/],
    ["a non-hex \\' escape", rtf("{\\rtf1 a\\'zz}"), /hex digits/],
    ['a \\bin that runs past the end', rtf('{\\rtf1 a\\bin999 xx}'), /runs past the end/],
    ['a lone surrogate', rtf('{\\rtf1 a\\u-10179?}'), /unpaired surrogate/],
    ['a document without text', rtf('{\\rtf1\\ansi{\\fonttbl{\\f0 Times;}}\\pard\\par}'), /holds no text/],
    ['a \\u without a value', rtf('{\\rtf1 \\u?}'), /no value/],
    ['a backslash at the end', rtf('{\\rtf1 a\\'), /after a backslash/],
  ];

  it.each(malformed)('rejects %s with a typed 400 error', (_name, input, pattern) => {
    let thrown: unknown;
    try {
      extractTextFromRtf(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LegacyOfficeFormatError);
    expect((thrown as LegacyOfficeFormatError).status).toBe(HTTP_BAD_REQUEST);
    expect((thrown as Error).message).toMatch(pattern);
  });

  it('rejects groups nested deeper than RTF_MAX_GROUP_DEPTH', () => {
    const deep = rtf(`{\\rtf1${'{'.repeat(RTF_MAX_GROUP_DEPTH + 1)}x${'}'.repeat(RTF_MAX_GROUP_DEPTH + 1)}}`);
    expect(() => extractTextFromRtf(deep)).toThrow(`groups are nested deeper than ${RTF_MAX_GROUP_DEPTH} levels`);
  });

  it('accepts nesting just inside the limit', () => {
    const depth = RTF_MAX_GROUP_DEPTH - 1;
    expect(extractTextFromRtf(rtf(`{\\rtf1${'{'.repeat(depth)}x${'}'.repeat(depth)}}`))).toBe('x');
  });

  it('rejects an overlong control word and an overlong parameter', () => {
    const longWord = 'a'.repeat(RTF_MAX_CONTROL_WORD_LENGTH + 1);
    expect(() => extractTextFromRtf(rtf(`{\\rtf1 \\${longWord} x}`))).toThrow(/control word is longer/);
    const longParameter = '1'.repeat(RTF_MAX_PARAMETER_DIGITS + 1);
    expect(() => extractTextFromRtf(rtf(`{\\rtf1 \\li${longParameter} x}`))).toThrow(/more than 10 digits/);
  });

  it('fails a malformed .rtf conversion with a typed 400 error and never a placeholder', async () => {
    const run = convertFile(Buffer.from('not rtf at all', 'utf-8'), 'rtf', 'txt', {}, 'bad.rtf');
    await expect(run).rejects.toBeInstanceOf(LegacyOfficeFormatError);
    await expect(run).rejects.toMatchObject({ status: HTTP_BAD_REQUEST });
  });
});

describe('RTF text extraction against LibreOffice', () => {
  const paragraphs = ['Résumé café naïve déjà vu', '한국어 문서의 텍스트입니다', '日本語のテキスト and “smart quotes” – dash', 'Plain ASCII line 42 {braces} \\ slash'];

  oracleTest('reads the RTF LibreOffice writes for Korean, Japanese and accented text', ['soffice'], () => {
    const written = sofficeConvert(flatOdt(paragraphs), 'fodt', 'rtf', 'rtf');
    const extracted = extractTextFromRtf(written);
    expect(extracted).not.toMatch(PLACEHOLDER_PATTERN);
    expect(normalizeWhitespace(extracted)).toBe(normalizeWhitespace(paragraphs.join(' ')));
  }, 180_000);

  oracleTest('converts a LibreOffice RTF to txt through the dispatcher', ['soffice'], async () => {
    const written = sofficeConvert(flatOdt(paragraphs), 'fodt', 'rtf', 'rtf');
    const result = await convertFile(written, 'rtf', 'txt', {}, 'sample.rtf');
    expect(normalizeWhitespace(result.buffer.toString('utf-8'))).toBe(normalizeWhitespace(paragraphs.join(' ')));
  }, 180_000);
});

describe('RTF conversion keeps its previous behaviour for plain documents', () => {
  it('converts the platform RTF sample to text without control words', async () => {
    const sample = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Courier;}}\\viewkind4\\uc1\\pard\\f0\\fs20 Hello from \\b RTF \\b0 document!\\par}';
    const result = await convertFile(Buffer.from(sample, 'utf-8'), 'rtf', 'txt', {}, 'sample.rtf');
    expect(result.buffer.toString('utf-8')).toBe('Hello from RTF document!');
  });
});
