import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { isFormatCompatibleWithMagicBytes, sniffMimeTypeFromMagicBytes } from '../src/lib/registry';
import { assertNotSpoofedFile } from '../src/lib/security/file-guard';
import { isUtf16LeText } from '../src/lib/utf16-text-signature';

/**
 * Text saved as UTF-16 little-endian starts with FF FE, which is also the sync word of an MPEG audio frame (Layer I with a CRC). The
 * spoof check took it for MP3 and refused every .txt, .csv, .tsv and .md file Windows Notepad and Excel write as "Unicode". The big-endian
 * mark (FE FF) was never refused. A file counts as UTF-16 text when libmagic's `looks_ucs16` (file/file `src/encoding.c`) says so, and
 * an MP3 renamed to a text name is still refused.
 */

const MP3 = fs.readFileSync(path.join(__dirname, 'fixtures', 'golden', 'media', 'golden-audio.mp3'));
const BOM_LE = Buffer.from([0xff, 0xfe]);
const utf16le = (text: string): Buffer => Buffer.concat([BOM_LE, Buffer.from(text, 'utf16le')]);

const TEXT = '이름,나이\n홍길동,30\nHello wörld,25\n';
const SAMPLES: ReadonlyArray<readonly [string, Buffer]> = [
  ['Korean and ASCII', utf16le(TEXT)],
  ['ASCII only', utf16le('a,b\r\n1,2\r\n')],
  ['a surrogate pair', utf16le('emoji 🎉 text\n')],
  ['the mark alone', BOM_LE],
];
const TEXT_EXTENSIONS = ['txt', 'csv', 'tsv', 'md', 'log', 'rst'] as const;

describe('UTF-16LE text with a byte order mark', () => {
  it.each(SAMPLES)('is not MPEG audio: %s', (_label, bytes) => {
    expect(sniffMimeTypeFromMagicBytes(bytes)).not.toBe('audio/mpeg');
    expect(isUtf16LeText(bytes)).toBe(true);
  });

  it.each(TEXT_EXTENSIONS.flatMap((ext) => SAMPLES.map(([label, bytes]) => [ext, label, bytes] as const)))('is accepted as .%s: %s', (ext, _label, bytes) => {
    expect(isFormatCompatibleWithMagicBytes(bytes, ext)).toBe(true);
    expect(() => assertNotSpoofedFile(bytes, ext, `data.${ext}`)).not.toThrow();
  });

  it('is accepted as it is cut inside a character or a surrogate pair, as the first 64 KiB of a larger file is', () => {
    const whole = utf16le('x🎉y'.repeat(100));
    for (const cut of [whole.length - 1, whole.length - 2, 5, 7]) expect(isUtf16LeText(whole.subarray(0, cut))).toBe(true);
  });
});

describe('a file that is not UTF-16LE text, behind the same two bytes', () => {
  /** An MPEG Layer I frame with a CRC: sync word FF FE, 128 kb/s at 44.1 kHz, mono, then silence. */
  const SILENT_LAYER_I = Buffer.concat([Buffer.from([0xff, 0xfe, 0x40, 0xc0]), Buffer.alloc(380)]);
  const RANDOM = Buffer.concat([BOM_LE, Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 167 + 13) & 0xff))]);

  it('keeps an MP3 renamed .txt, .csv, .tsv and .md refused', () => {
    expect(sniffMimeTypeFromMagicBytes(MP3)).toBe('audio/mpeg');
    for (const ext of ['txt', 'csv', 'tsv', 'md']) {
      expect(() => assertNotSpoofedFile(MP3, ext, `song.${ext}`)).toThrow(/audio\/mpeg/);
    }
  });

  it.each([
    ['a Layer I frame of silence', SILENT_LAYER_I],
    ['binary data', RANDOM],
    ['a lone low surrogate', Buffer.concat([BOM_LE, Buffer.from([0x00, 0xdc, 0x41, 0x00])])],
    ['a high surrogate with no low one', Buffer.concat([BOM_LE, Buffer.from([0x00, 0xd8, 0x41, 0x00])])],
    ['a control character', Buffer.concat([BOM_LE, Buffer.from([0x01, 0x00, 0x41, 0x00])])],
    ['a noncharacter', Buffer.concat([BOM_LE, Buffer.from([0xff, 0xff, 0x41, 0x00])])],
    ['a null character', Buffer.concat([BOM_LE, Buffer.from([0x00, 0x00, 0x41, 0x00])])],
  ])('is refused as .txt: %s', (_label, bytes) => {
    expect(isUtf16LeText(bytes)).toBe(false);
    expect(() => assertNotSpoofedFile(bytes, 'txt', 'data.txt')).toThrow(/File spoofing rejected/);
  });

  it('is still an MP3 under its own name', () => {
    expect(() => assertNotSpoofedFile(SILENT_LAYER_I, 'mp3', 'song.mp3')).not.toThrow();
    expect(() => assertNotSpoofedFile(utf16le('plain text\n'), 'mp3', 'song.mp3')).toThrow(/File spoofing rejected/);
  });
});

describe('UTF-16LE text through the routes of each text family', () => {
  const read = (bytes: Buffer, ext: string): Buffer => {
    assertNotSpoofedFile(bytes, ext, `data.${ext}`);
    return bytes;
  };

  it('converts .txt to PDF and DOCX', async () => {
    const bytes = read(utf16le('Hello wörld\r\n둘째 줄\r\n'), 'txt');
    expect((await convertFile(bytes, 'txt', 'pdf', {}, 'note.txt')).buffer.subarray(0, 5).toString()).toBe('%PDF-');
    const docx = await JSZip.loadAsync((await convertFile(bytes, 'txt', 'docx', {}, 'note.txt')).buffer);
    expect(await docx.file('word/document.xml')!.async('string')).toContain('둘째 줄');
  });

  it('converts .md to HTML', async () => {
    const html = (await convertFile(read(utf16le('# 제목\n\n본문 text\n'), 'md'), 'md', 'html', {}, 'note.md')).buffer.toString('utf-8');
    expect(/<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1]).toBe('제목');
    expect(/<p>([^<]*)<\/p>/.exec(html)?.[1]).toBe('본문 text');
  });

  it.each(['csv', 'tsv'])('converts .%s to JSON', async (ext) => {
    const sep = ext === 'csv' ? ',' : '\t';
    const bytes = read(utf16le(`이름${sep}나이\n홍길동${sep}30\n`), ext);
    const json = (await convertFile(bytes, ext, 'json', {}, `data.${ext}`)).buffer.toString('utf-8');
    expect(JSON.parse(json)).toEqual([{ 이름: '홍길동', 나이: '30' }]);
  });
});
