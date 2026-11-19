import iconv from 'iconv-lite';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { sourceBytesAsText } from '../src/lib/conversions/office/text-source';
import { withConversionWarnings } from '../src/lib/conversions/conversion-warnings';

/**
 * A text source that is not UTF-8 reads the way text to PDF reads it (policy entry 72): a byte order mark, valid UTF-8, then the
 * detected legacy encoding, with a warning that names it. Before this, every other target (DOCX, ODT, EPUB, HTML, Markdown and the
 * pandoc sources) decoded the bytes as UTF-8 and wrote U+FFFD for each legacy sequence, with no warning.
 */

/** A Korean paragraph in CP949, padded with ASCII to 744 bytes, the size of the file that was refused in review. */
const KOREAN_BODY = '대한민국은 민주공화국이다. 대한민국의 주권은 국민에게 있고, 모든 권력은 국민으로부터 나온다.\n';
const KOREAN_TEXT = KOREAN_BODY.repeat(8).slice(0, -1) + '\n';
const KOREAN_CP949 = ((): Buffer => {
  const encoded = iconv.encode(KOREAN_TEXT, 'cp949');
  return Buffer.concat([encoded, Buffer.from('.'.repeat(Math.max(0, 744 - encoded.length)))]);
})();
const KOREAN_EXPECTED = KOREAN_TEXT + '.'.repeat(744 - iconv.encode(KOREAN_TEXT, 'cp949').length);

const CP1252_TEXT = 'He said “hello” – it’s “fine” … Price: 5 € — ok. Café déjà vu, naïve façade, über Straße.\n';
const CP1252_BYTES = iconv.encode(CP1252_TEXT, 'cp1252');

const NOT_UTF8_WARNING = (encoding: string): string => `Text input is not valid UTF-8; it was read as ${encoding}.`;
const REPLACEMENT = '�';

describe('sourceBytesAsText on text that is not UTF-8', () => {
  it('has the size of the reviewed file', () => {
    expect(KOREAN_CP949.length).toBe(744);
  });

  it.each(['txt', 'text', 'md', 'log', 'rst', 'man'])('reads CP949 as .%s', async (format) => {
    const { warnings, text } = await readWithWarnings(() => sourceBytesAsText(KOREAN_CP949, format));
    expect(text).toBe(KOREAN_EXPECTED);
    expect(warnings).toEqual([NOT_UTF8_WARNING('euc-kr')]);
  });

  it('reads CP1252 with the standard table', async () => {
    const { warnings, text } = await readWithWarnings(() => sourceBytesAsText(CP1252_BYTES, 'txt'));
    expect(text).toBe(CP1252_TEXT);
    expect(warnings).toEqual([NOT_UTF8_WARNING('windows-1252')]);
  });

  it('drops the byte order mark of UTF-8 text, and says nothing', async () => {
    const { warnings, text } = await readWithWarnings(() => sourceBytesAsText(Buffer.from('﻿plain 한글\n'), 'txt'));
    expect(text).toBe('plain 한글\n');
    expect(warnings).toEqual([]);
  });
});

describe('text that is not UTF-8 converted to the office, ebook and markup targets', () => {
  it.each(['docx', 'odt', 'epub', 'html', 'md'])('keeps the Korean text of a CP949 .txt in .%s and warns', async (target) => {
    const result = await convertFile(KOREAN_CP949, 'txt', target, {}, 'ko.txt');
    expect(result.metadata?.warnings).toEqual([NOT_UTF8_WARNING('euc-kr')]);
    expect(await textOfResult(result.buffer, target)).toContain('대한민국은 민주공화국이다.');
    expect(await textOfResult(result.buffer, target)).not.toContain(REPLACEMENT);
  });

  it('keeps the quotes of a CP1252 .md in .docx and warns', async () => {
    const result = await convertFile(CP1252_BYTES, 'md', 'docx', {}, 'quotes.md');
    expect(result.metadata?.warnings).toEqual([NOT_UTF8_WARNING('windows-1252')]);
    expect(await textOfResult(result.buffer, 'docx')).toContain('“hello” – it’s');
  });
});

async function readWithWarnings(read: () => string): Promise<{ text: string; warnings: string[] }> {
  const result = await withConversionWarnings(async () => ({ text: read(), metadata: {} as Record<string, unknown> }));
  return { text: result.text, warnings: (result.metadata.warnings as string[] | undefined) ?? [] };
}

/** The text a converted file carries: the unzipped XML of a package, or the file itself. */
async function textOfResult(buffer: Buffer, target: string): Promise<string> {
  if (target === 'html' || target === 'md') return buffer.toString('utf-8');
  const zip = await JSZip.loadAsync(buffer);
  const parts = await Promise.all(Object.values(zip.files).filter((file) => !file.dir).map((file) => file.async('string')));
  return parts.join('\n');
}
