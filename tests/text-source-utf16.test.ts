import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { extractTextContentForOffice } from '../src/lib/conversions/office';
import { sourceBytesAsText } from '../src/lib/conversions/office/text-source';

/**
 * A text source with a byte order mark that names UTF-16 is text, whatever the target: the binary guard of the text writers
 * (a null byte in the first 4 KiB) used to refuse it, and UTF-16BE text reached only the PDF writer. A source with no reader of its
 * own that merely starts with the same two bytes is still binary and still refused.
 */

const TEXT = 'Hello wörld\r\nline two\r\n';
const BE = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(TEXT, 'utf16le').swap16()]);
const LE = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT, 'utf16le')]);
const TEXT_SOURCES = ['txt', 'text', 'md', 'log', 'rst', 'man'] as const;

describe('a text source with a UTF-16 byte order mark', () => {
  it.each(TEXT_SOURCES)('is read as text for .%s, in both byte orders', (format) => {
    expect(sourceBytesAsText(BE, format)).toBe(TEXT);
    expect(sourceBytesAsText(LE, format)).toBe(TEXT);
  });

  it('converts to HTML, to plain text and to the office writers', async () => {
    const html = await dispatchConversion(BE, 'txt', 'html', {}, 'note.txt');
    expect(html.buffer.toString('utf8')).toContain('Hello wörld');
    expect(html.buffer.toString('utf8')).not.toContain('\u0000');
    const plain = await dispatchConversion(BE, 'log', 'txt', {}, 'events.log');
    expect(plain.buffer.toString('utf8')).toBe(TEXT);
    expect(await extractTextContentForOffice(BE, 'txt', {}, 'note')).toBe(TEXT);
  });

  it('is refused with the typed answer when the bytes break the encoding it declares', () => {
    const lone = Buffer.from([0xfe, 0xff, 0xd8, 0x00]);
    expect(() => sourceBytesAsText(lone, 'txt')).toThrow(expect.objectContaining({ name: 'InvalidUnicodeTextError' }));
  });
});

describe('a binary source with no reader that starts with the same bytes', () => {
  const body = Buffer.concat([Buffer.from('AT&TFORM'), Buffer.alloc(64), Buffer.from('DJVMDIRM')]);

  it.each([
    ['FE FF', [0xfe, 0xff]],
    ['FF FE', [0xff, 0xfe]],
  ])('is still refused when it starts with %s', (_label, bom) => {
    const bytes = Buffer.concat([Buffer.from(bom), body]);
    expect(() => sourceBytesAsText(bytes, 'djvu')).toThrow(/fail-closed against mojibake/);
    expect(() => sourceBytesAsText(bytes, 'msg')).toThrow(expect.objectContaining({ name: 'LegacyOfficeFormatError' }));
  });
});
