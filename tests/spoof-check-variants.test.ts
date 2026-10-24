import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { xmlRootElementName } from '../src/lib/format-signatures';
import { FileExtensionSpoofError, isFormatCompatibleWithMagicBytes, sniffMimeTypeFromMagicBytes } from '../src/lib/registry';
import { assertCompoundFileKindInObject, assertNotSpoofedFile, assertNotSpoofedFilePath } from '../src/lib/security/file-guard';
import { gunzipHead } from '../src/lib/security/gzipped-xml-root';
import { OBJECT_HEADER_BYTES } from '../src/lib/storage/object-header';
import { buildCompoundFile, placeDirectory } from './helpers/cfb-craft';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * Content variants of formats the spoof check refused although the files are what their names say (#783): compressed
 * AbiWord and compressed SVG (a gzip member whose inflated head opens with the format's root element, which the server
 * side gate reads and the registry does not), raw AAC behind an
 * ID3v2 tag or in an MP4 box structure, DivX in an AVI container, and the compound-file formats StarWriter, StarCalc,
 * StarDraw, Corel Presentations and Quattro Pro. Accepted cases are real files from the corpus or headers written from the
 * layout in the specification; the independent oracle for a container is the system `file` (libmagic) where it is installed.
 * Every refused case is a file of another kind under the same name.
 */

const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
const ABIWORD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE abiword PUBLIC "-//ABISOURCE//DTD AWML 1.0 Strict//EN" "http://www.abisource.com/awml.dtd">\n<abiword version="3.0.5"><section><p>hello</p></section></abiword>';
const HTML = '<!DOCTYPE html><html><body><script>alert(1)</script><svg></svg></body></html>';
const OTHER_XML = '<?xml version="1.0"?><note><to>x</to></note>';
const PNG_HEADER = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const MZ_HEADER = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 1)]);
const ELF_HEADER = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 1)]);
const CFBF_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const GZIP_HEADER = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];

/**
 * A gzip member (RFC 1952) written from the layout in the specification: the header, the data as stored deflate blocks
 * (RFC 1951 3.2.4) and the CRC-32 and size trailer. No compressor is involved, so the bytes do not depend on one.
 */
function gzip(content: string | Buffer, header: Buffer = Buffer.from(GZIP_HEADER)): Buffer {
  const data = typeof content === 'string' ? Buffer.from(content) : content;
  const blocks: Buffer[] = [];
  for (let at = 0; at < Math.max(data.length, 1); at += 0xffff) {
    const chunk = data.subarray(at, at + 0xffff);
    const last = at + 0xffff >= data.length ? 1 : 0;
    const blockHeader = Buffer.alloc(5);
    blockHeader.writeUInt8(last, 0);
    blockHeader.writeUInt16LE(chunk.length, 1);
    blockHeader.writeUInt16LE(~chunk.length & 0xffff, 3);
    blocks.push(blockHeader, chunk);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(zlib.crc32(data), 0);
  trailer.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, ...blocks, trailer]);
}

const gzipTool = getOracleToolPath('gzip');
const noGzipTool = skipUnless('gzip', gzipTool !== null);

/** `content` compressed by the system `gzip` at `level`, or by the default level. */
function gzipWithTool(content: Buffer, level = 6): Buffer {
  return execFileSync(gzipTool as string, ['-c', `-${level}`], { input: content, maxBuffer: 256 * 1024 * 1024 });
}

/** Runs libmagic's `file` over bytes the test holds on disk; the caller skips without the tool. */
function libmagicMime(filePath: string): string {
  return execFileSync(getOracleToolPath('file') as string, ['--mime-type', '-b', filePath], { encoding: 'utf8' }).trim();
}

const noLibmagic = skipUnless('file (libmagic)', getOracleToolPath('file') !== null);

describe('gunzipHead (the head of a gzip member, read with the bounded inflate)', () => {
  const PROSE = 'The quick brown fox jumps over the lazy dog. '.repeat(400);
  const NOISE = Buffer.from(Array.from({ length: 6000 }, (_, index) => (index * 7919 + (index >> 3) * 31) & 0xff));
  const INPUT = Buffer.concat([Buffer.from(PROSE), NOISE, Buffer.from(PROSE)]);

  it.for([1, 6, 9])('reads a member that the system gzip wrote at level %i', (level, ctx) => {
    if (noGzipTool) return ctx.skip();
    const member = gzipWithTool(INPUT, level);
    const head = gunzipHead(member, 5000) as Buffer;
    expect(head.length).toBeGreaterThan(0);
    expect(head.length).toBeLessThanOrEqual(5000);
    expect(head.equals(INPUT.subarray(0, head.length))).toBe(true);
    expect((gunzipHead(member, INPUT.length + 100) as Buffer).equals(INPUT)).toBe(true);
  });

  it('reads a member of fixed Huffman blocks as the system gzip writes it for a short input', (ctx) => {
    if (noGzipTool) return ctx.skip();
    expect((gunzipHead(gzipWithTool(Buffer.from('abcabcabcabc')), 100) as Buffer).toString()).toBe('abcabcabcabc');
  });

  it('reads a member of stored blocks written from the specification', () => {
    expect((gunzipHead(gzip(SVG), 1000) as Buffer).toString()).toBe(SVG);
  });

  it('stops at the budget instead of inflating a stream that expands far past it', (ctx) => {
    if (noGzipTool) return ctx.skip();
    const bomb = gzipWithTool(Buffer.alloc(50 * 1024 * 1024), 9);
    expect(gunzipHead(bomb, 1024)?.length ?? 0).toBeLessThanOrEqual(1024);
    expect(() => assertNotSpoofedFile(bomb, 'svgz', 'bomb.svgz')).toThrow(FileExtensionSpoofError);
  });

  it('returns the bytes decoded so far when the window ends inside the stream', (ctx) => {
    if (noGzipTool) return ctx.skip();
    const head = gunzipHead(gzipWithTool(INPUT).subarray(0, 3000), 100000) as Buffer;
    expect(head.length).toBeGreaterThan(0);
    expect(head.equals(INPUT.subarray(0, head.length))).toBe(true);
  });

  it('skips the optional header fields of RFC 1952 (extra, name, comment, header CRC)', () => {
    const header = Buffer.from([0x1f, 0x8b, 8, 0x04 | 0x08 | 0x10 | 0x02, 0, 0, 0, 0, 0, 3]);
    const fields = Buffer.concat([Buffer.from([3, 0, 1, 2, 3]), Buffer.from('a.svg\0'), Buffer.from('note\0')]);
    // FHCRC is the low 16 bits of the CRC-32 of every header byte before it (RFC 1952 section 2.3.1).
    const headerCrc = Buffer.alloc(2);
    headerCrc.writeUInt16LE(zlib.crc32(Buffer.concat([header, fields])) & 0xffff);
    expect((gunzipHead(gzip(SVG, Buffer.concat([header, fields, headerCrc])), 1000) as Buffer).toString()).toBe(SVG);
  });

  it('refuses a stream that is not valid deflate, a header that is not complete and a stored block whose length check fails', () => {
    const reservedBlockType = Buffer.concat([Buffer.from(GZIP_HEADER), Buffer.from([0x07, 0, 0, 0, 0])]);
    expect(gunzipHead(reservedBlockType, 100)).toBeUndefined();
    expect((gunzipHead(gzip(SVG).subarray(0, 9), 100) ?? Buffer.alloc(0)).length).toBe(0);
    const badComplement = Buffer.concat([Buffer.from(GZIP_HEADER), Buffer.from([0x01, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5])]);
    expect(gunzipHead(badComplement, 100)).toBeUndefined();
  });
});

describe('the root element of an XML head', () => {
  it.each([
    ['a declaration', '<?xml version="1.0"?><svg/>', 'svg'],
    ['a byte order mark and comments', 'ï»¿  <?xml version="1.0"?>\n<!-- licence -->\n<!-- more --><abiword version="1">', 'abiword'],
    ['a doctype with an internal subset', '<?xml version="1.0"?><!DOCTYPE svg [ <!ENTITY ns "http://example.org/ns"> ]>\n<svg xmlns="http://www.w3.org/2000/svg">', 'svg'],
    ['an upper case doctype', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><SVG width="1">', 'svg'],
    ['a page', HTML, 'html'],
  ])('names the root after %s', (_label, text, expected) => {
    expect(xmlRootElementName(Buffer.from(text, 'latin1'))).toBe(expected);
  });

  it.each([
    ['binary bytes', PNG_HEADER.toString('latin1')],
    ['text with no markup', 'hello world <svg>'],
    ['a prolog that never closes', '<?xml version="1.0"?><!-- unfinished <svg>'],
    ['an element whose name has a prefix', '<ns:svg xmlns:ns="x">'],
  ])('finds no root in %s', (_label, text) => {
    expect(xmlRootElementName(Buffer.from(text, 'latin1'))).toBeUndefined();
  });
});

describe('compressed AbiWord (.zabw) and compressed SVG (.svgz)', () => {
  it.for(['abiword-next_layout.zabw', 'lo-hello.zabw'])('accepts the real file %s', async (id, ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    expect(isFormatCompatibleWithMagicBytes(sample.bytes, 'zabw')).toBe(true);
    expect(() => assertNotSpoofedFile(sample.bytes, 'zabw', id)).not.toThrow();
    expect(() => assertNotSpoofedFilePath(sample.path, 'zabw', id)).not.toThrow();
  });

  it.for(['okular-checkmark.svgz', 'okular-hisc-apps-okular.svgz', 'tika-testsvg.svgz'])('accepts the real file %s', async (id, ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    expect(isFormatCompatibleWithMagicBytes(sample.bytes, 'svgz')).toBe(true);
    expect(() => assertNotSpoofedFile(sample.bytes, 'svgz', id)).not.toThrow();
    expect(() => assertNotSpoofedFilePath(sample.path, 'svgz', id)).not.toThrow();
  });

  it('accepts a gzip member of an AbiWord document under .zabw and of an SVG under .svgz', () => {
    expect(xmlRootElementName(gunzipHead(gzip(ABIWORD), 1000) as Buffer)).toBe('abiword');
    expect(xmlRootElementName(gunzipHead(gzip(SVG), 1000) as Buffer)).toBe('svg');
    expect(() => assertNotSpoofedFile(gzip(ABIWORD), 'zabw', 'doc.zabw')).not.toThrow();
    expect(() => assertNotSpoofedFile(gzip(SVG), 'svgz', 'drawing.svgz')).not.toThrow();
  });

  it('accepts a document whose head is longer than the compressed window shows', (ctx) => {
    if (noGzipTool) return ctx.skip();
    const padded = `${ABIWORD}\n${'<!-- filler -->\n'.repeat(20000)}`;
    const window = gzipWithTool(Buffer.from(padded)).subarray(0, OBJECT_HEADER_BYTES);
    expect(xmlRootElementName(gunzipHead(window) as Buffer)).toBe('abiword');
    expect(() => assertNotSpoofedFile(window, 'zabw', 'big.zabw')).not.toThrow();
  });

  it('accepts a document whose compressed window inflates to more than the head budget', (ctx) => {
    if (noGzipTool) return ctx.skip();
    const padded = `${SVG.replace('<svg', '<!-- c -->'.repeat(3) + '<svg')}${'<!-- filler -->\n'.repeat(200000)}`;
    const window = gzipWithTool(Buffer.from(padded), 9).subarray(0, OBJECT_HEADER_BYTES);
    expect(xmlRootElementName(gunzipHead(window) as Buffer)).toBe('svg');
    expect(() => assertNotSpoofedFile(window, 'svgz', 'big.svgz')).not.toThrow();
  });

  it.each([
    { what: 'a page that holds an <svg> element', text: HTML, ext: 'svgz' },
    { what: 'a page', text: HTML, ext: 'zabw' },
    { what: 'another XML document', text: OTHER_XML, ext: 'zabw' },
    { what: 'another XML document', text: OTHER_XML, ext: 'svgz' },
    { what: 'an SVG document', text: SVG, ext: 'zabw' },
    { what: 'an AbiWord document', text: ABIWORD, ext: 'svgz' },
    { what: 'plain text', text: 'hello', ext: 'zabw' },
  ])('refuses a gzip member of $what under .$ext', ({ text, ext }) => {
    expect(() => assertNotSpoofedFile(gzip(text), ext, `file.${ext}`)).toThrow(FileExtensionSpoofError);
  });

  it('leaves the root element to the server side gate: the registry alone takes any well-formed gzip member under the names', () => {
    expect(isFormatCompatibleWithMagicBytes(gzip(HTML), 'svgz')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(gzip(HTML), 'zabw')).toBe(true);
  });

  it.each(['zabw', 'svgz'])('refuses a gzip member of a PNG, of a program and of noise under .%s', (ext) => {
    for (const payload of [PNG_HEADER, MZ_HEADER, ELF_HEADER, Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff))]) {
      expect(() => assertNotSpoofedFile(gzip(payload), ext, `file.${ext}`)).toThrow(FileExtensionSpoofError);
    }
  });

  it('refuses a gzip header that RFC 1952 does not allow, a truncated header and a stream that is not gzip', () => {
    const notDeflate = gzip(ABIWORD);
    notDeflate[2] = 7;
    expect(isFormatCompatibleWithMagicBytes(notDeflate, 'zabw')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(gzip(ABIWORD).subarray(0, 9), 'zabw')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(PNG_HEADER, 'zabw')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(MZ_HEADER, 'svgz')).toBe(false);
  });

  it('keeps accepting any gzip member under the gzip names', () => {
    expect(isFormatCompatibleWithMagicBytes(gzip(HTML), 'gz')).toBe(true);
    expect(() => assertNotSpoofedFile(gzip(HTML), 'gz', 'page.gz')).not.toThrow();
  });

  it('agrees with libmagic that the real compressed documents are gzip members', async (ctx) => {
    if (noLibmagic) return ctx.skip();
    for (const id of ['abiword-next_layout.zabw', 'okular-checkmark.svgz']) {
      const sample = await requireRealworldSample(ctx, id);
      expect(libmagicMime(sample.path)).toBe('application/gzip');
      expect(sniffMimeTypeFromMagicBytes(sample.bytes)).toBe('application/gzip');
    }
  });
});

describe('raw AAC (.aac)', () => {
  const adts = (): Buffer => Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc, 0x21, 0x00, 0x49, 0x90, 0x02]);
  /** ID3v2 header (ID3v2.4 section 3.1) with the synchsafe size of `size` and a tag body of that many zero bytes. */
  const id3Tag = (size: number, flags = 0): Buffer => {
    const header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, flags, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    return Buffer.concat([header, Buffer.alloc(size), flags & 0x10 ? Buffer.alloc(10) : Buffer.alloc(0)]);
  };

  it.for(['fate-ct_faac-adts.aac', 'fate-foo.aac', 'fate-id3v2.aac', 'tika-testaacid3.aac'])('accepts the real file %s', async (id, ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    expect(sniffMimeTypeFromMagicBytes(sample.bytes)).toBe('audio/aac');
    expect(isFormatCompatibleWithMagicBytes(sample.bytes, 'aac')).toBe(true);
  });

  it('agrees with libmagic that the real files are ADTS AAC, behind an ID3 tag or not', async (ctx) => {
    if (noLibmagic) return ctx.skip();
    for (const id of ['fate-ct_faac-adts.aac', 'fate-id3v2.aac', 'tika-testaacid3.aac']) {
      const sample = await requireRealworldSample(ctx, id);
      expect(libmagicMime(sample.path)).toBe('audio/x-hx-aac-adts');
    }
  });

  it.each([
    ['an ID3v2.3 tag', Buffer.concat([id3Tag(200), adts()])],
    ['an ID3v2.4 tag with a footer', Buffer.concat([id3Tag(50, 0x10), adts()])],
    ['an ADIF header', Buffer.concat([Buffer.from('ADIF'), Buffer.alloc(24)])],
    ['an MPEG-4 audio box structure', Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypM4A '), Buffer.alloc(4), Buffer.from('M4A mp42')])],
  ])('accepts a file that opens with %s', (_label, bytes) => {
    expect(isFormatCompatibleWithMagicBytes(bytes, 'aac')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'adts')).toBe(true);
  });

  it('accepts an ID3 tag that runs past the header window, whose frames cannot be seen', () => {
    const window = Buffer.concat([id3Tag(100 * 1024)]).subarray(0, 64 * 1024);
    expect(isFormatCompatibleWithMagicBytes(window, 'aac')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(window, 'mp3')).toBe(true);
  });

  it('still reads an ID3-tagged MP3 as MP3 and refuses it under the AAC names', () => {
    const mp3 = Buffer.concat([id3Tag(200), Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0])]);
    expect(sniffMimeTypeFromMagicBytes(mp3)).toBe('audio/mpeg');
    expect(isFormatCompatibleWithMagicBytes(mp3, 'mp3')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(mp3, 'aac')).toBe(false);
  });

  it.each([
    ['a program behind an ID3 tag', Buffer.concat([id3Tag(200), MZ_HEADER])],
    ['an ID3 header with an invalid size', Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x80, 0, 0, 0]), MZ_HEADER])],
    ['an ID3 header of an unknown version', Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x09, 0x00, 0x00, 0, 0, 0, 0]), adts()])],
    ['a PNG', PNG_HEADER],
    ['a program', MZ_HEADER],
    ['a video MP4', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from('isomiso2')])],
    ['a RIFF WAVE file', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(16)])],
  ])('refuses %s under .aac', (_label, bytes) => {
    expect(isFormatCompatibleWithMagicBytes(bytes, 'aac')).toBe(false);
    expect(() => assertNotSpoofedFile(bytes, 'aac', 'song.aac')).toThrow(FileExtensionSpoofError);
  });
});

describe('DivX (.divx) and Xvid (.xvid) video', () => {
  const riff = (formType: string): Buffer => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x5e, 0xe8, 0x19, 0x00]), Buffer.from(formType, 'latin1'), Buffer.from('LIST'), Buffer.alloc(32)]);

  it('accepts the real AVI-based file', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'samples-small.divx');
    expect(sniffMimeTypeFromMagicBytes(sample.bytes)).toBe('video/x-msvideo');
    expect(isFormatCompatibleWithMagicBytes(sample.bytes, 'divx')).toBe(true);
  });

  it('accepts the real file that is not an AVI file, whose first bytes no signature names', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'fate-lmlm4_cifat30fps.divx');
    expect(isFormatCompatibleWithMagicBytes(sample.bytes, 'divx')).toBe(true);
  });

  it('agrees with libmagic that the real file is an AVI file', async (ctx) => {
    if (noLibmagic) return ctx.skip();
    const sample = await requireRealworldSample(ctx, 'samples-small.divx');
    expect(libmagicMime(sample.path)).toBe('video/x-msvideo');
  });

  it.each(['divx', 'xvid', 'avi'])('accepts a RIFF "AVI " header under .%s', (ext) => {
    expect(isFormatCompatibleWithMagicBytes(riff('AVI '), ext)).toBe(true);
  });

  it.each(['divx', 'xvid'])('refuses a RIFF WAVE file, a WebP image and other kinds under .%s', (ext) => {
    expect(isFormatCompatibleWithMagicBytes(riff('WAVE'), ext)).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(riff('WEBP'), ext)).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(PNG_HEADER, ext)).toBe(false);
    expect(() => assertNotSpoofedFile(MZ_HEADER, ext, `clip.${ext}`)).toThrow(FileExtensionSpoofError);
    expect(() => assertNotSpoofedFile(ELF_HEADER, ext, `clip.${ext}`)).toThrow(FileExtensionSpoofError);
  });

  it('still keeps an AVI file out of the names of other formats', () => {
    expect(isFormatCompatibleWithMagicBytes(riff('AVI '), 'mp4')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(riff('AVI '), 'wav')).toBe(false);
  });
});

describe('compound-file documents (.sdw, .sdc, .sda, .shw, .qpw)', () => {
  const COREL_PRESENTATIONS_CLASS_ID = Buffer.from([0x62, 0xfe, 0x2e, 0x40, 0x99, 0x19, 0x1b, 0x10, 0x99, 0xae, 0x04, 0x02, 0x1c, 0x00, 0x70, 0x02]);
  const NAMING_STREAMS: Readonly<Record<string, string>> = { sdw: 'StarWriterDocument', sdc: 'StarCalcDocument', sda: 'StarDrawDocument3', qpw: 'NativeContent_MAIN' };
  /** A compound file of the kind `ext` as the engines tell it: the stream that names it, or for Corel Presentations the class ID of the root storage. */
  const compoundFileOf = (ext: string): Buffer => {
    const file = buildCompoundFile([{ name: NAMING_STREAMS[ext] ?? 'PerfectOffice_MAIN', data: Buffer.from('x') }]);
    if (ext === 'shw') COREL_PRESENTATIONS_CLASS_ID.copy(file, (file.readUInt32LE(48) + 1) * 512 + 80);
    return file;
  };
  const bareSignature = (): Buffer => Buffer.concat([CFBF_MAGIC, Buffer.alloc(504)]);
  const REAL_FILES: readonly (readonly [string, string])[] = [
    ['sdw', 'lo-sfxstandalonedocinfoobject.sdw'],
    ['sdw', 'lo-writer_3.1.sdw'],
    ['sdw', 'tika-teststaroffice-5.2-writer.sdw'],
    ['sdc', 'lo-calc_3.1.sdc'],
    ['sdc', 'tika-teststaroffice-5.2-calc.sdc'],
    ['sda', 'lo-draw_3.1.sda'],
    ['sda', 'tika-teststaroffice-5.2-draw.sda'],
    ['shw', 'office-testcorel.shw'],
    ['shw', 'tika-testcorel.shw'],
    ['qpw', 'opf-testquattro.qpw'],
  ];

  it.for(REAL_FILES)('accepts the real .%s file %s', async ([ext, id], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    expect(isFormatCompatibleWithMagicBytes(sample.bytes, ext)).toBe(true);
    expect(() => assertNotSpoofedFilePath(sample.path, ext, id)).not.toThrow();
  });

  it('agrees with libmagic that every real file is a compound file', async (ctx) => {
    if (noLibmagic) return ctx.skip();
    for (const [, id] of REAL_FILES) {
      const sample = await requireRealworldSample(ctx, id);
      expect(libmagicMime(sample.path)).toMatch(/^application\/(vnd\.ms-office|CDFV2|x-ole-storage)/);
    }
  });

  it.each(['sdw', 'sdc', 'sda', 'shw', 'qpw'])('accepts a compound file of its own kind under .%s', (ext) => {
    expect(isFormatCompatibleWithMagicBytes(compoundFileOf(ext), ext)).toBe(true);
    expect(() => assertNotSpoofedFile(compoundFileOf(ext), ext, `file.${ext}`)).not.toThrow();
  });

  it.each(['sdw', 'sdc', 'sda', 'shw', 'qpw'])('refuses the container signature with no directory under .%s', (ext) => {
    expect(isFormatCompatibleWithMagicBytes(bareSignature(), ext)).toBe(false);
    expect(() => assertNotSpoofedFile(bareSignature(), ext, `file.${ext}`)).toThrow(FileExtensionSpoofError);
  });

  it('refuses the compound file of each kind under the names of the other four', () => {
    const kinds = ['sdw', 'sdc', 'sda', 'shw', 'qpw'];
    for (const kind of kinds) {
      for (const claimed of kinds.filter((candidate) => candidate !== kind)) {
        expect(isFormatCompatibleWithMagicBytes(compoundFileOf(kind), claimed), `a .${kind} file named .${claimed}`).toBe(false);
        expect(() => assertNotSpoofedFile(compoundFileOf(kind), claimed, `file.${claimed}`), `a .${kind} file named .${claimed}`).toThrow(FileExtensionSpoofError);
      }
    }
  });

  it.each(['sdw', 'sdc', 'sda', 'shw', 'qpw'])('refuses a Word document under .%s', (ext) => {
    const word = buildCompoundFile([{ name: 'WordDocument', data: Buffer.from('x') }, { name: '1Table', data: Buffer.from('x') }]);
    expect(isFormatCompatibleWithMagicBytes(word, ext)).toBe(false);
  });

  it('takes a file for what it is when only the start is given and the directory lies past it, and refuses a whole file with that fault', () => {
    const header = (length: number): Buffer => {
      const file = Buffer.alloc(length);
      compoundFileOf('sdw').copy(file, 0, 0, 512);
      file.writeUInt32LE(OBJECT_HEADER_BYTES / 512 + 40, 48);
      return file;
    };
    expect(isFormatCompatibleWithMagicBytes(header(OBJECT_HEADER_BYTES), 'sdw')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(header(OBJECT_HEADER_BYTES - 1), 'sdw')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(header(OBJECT_HEADER_BYTES + 1), 'sdw')).toBe(false);
  });

  it.each([0xfffffffa, 0xfffffffe, 0xffffffff])('refuses a header whose first directory sector is the marker %d, in a buffer of the whole header window too', (sector) => {
    for (const length of [OBJECT_HEADER_BYTES - 1, OBJECT_HEADER_BYTES, OBJECT_HEADER_BYTES + 1]) {
      const file = Buffer.alloc(length);
      compoundFileOf('sdw').copy(file, 0, 0, 512);
      file.writeUInt32LE(sector, 48);
      expect(isFormatCompatibleWithMagicBytes(file, 'sdw'), `${length} bytes`).toBe(false);
    }
  });

  describe('whose directory lies past the first 64 KiB', () => {
    const SECTORS_IN_WINDOW = OBJECT_HEADER_BYTES / 512;
    const WORD_97_CLASS_ID = Buffer.from([0x06, 0x09, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]);
    const largeDocument = (kind: 'word' | 'writer'): Buffer => {
      const small =
        kind === 'word'
          ? buildCompoundFile([{ name: 'WordDocument', data: Buffer.from('x') }, { name: '1Table', data: Buffer.from('x') }])
          : compoundFileOf('sdw');
      if (kind === 'word') WORD_97_CLASS_ID.copy(small, (small.readUInt32LE(48) + 1) * 512 + 80);
      return placeDirectory(small, { directorySectors: [SECTORS_IN_WINDOW + 150] });
    };
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'compound-directory-'));
    afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const stored = (name: string, bytes: Buffer): string => {
      const file = path.join(scratch, name);
      fs.writeFileSync(file, bytes);
      return file;
    };

    /** A store that serves ranges as the object store does: a range past the end of the object is an error. */
    const store = (bytes: Buffer) => {
      const requests: { start: number; end: number }[] = [];
      return {
        requests,
        openReadStream: async (_key: string, range?: { start: number; end: number }) => {
          if (!range || range.end >= bytes.length) throw new Error(`range ${range?.start}-${range?.end} is past the end`);
          requests.push(range);
          return Readable.from([bytes.subarray(range.start, range.end + 1)]);
        },
      };
    };

    it('is refused by path when it is a Word document named .sdw, and accepted when it is a StarWriter document', () => {
      const word = stored('large-word.sdw', largeDocument('word'));
      const writer = stored('large-writer.sdw', largeDocument('writer'));
      expect(() => assertNotSpoofedFilePath(word, 'sdw', 'large-word.sdw')).toThrow(FileExtensionSpoofError);
      expect(() => assertNotSpoofedFilePath(writer, 'sdw', 'large-writer.sdw')).not.toThrow();
      expect(() => assertNotSpoofedFilePath(writer, 'sdc', 'large-writer.sdc')).toThrow(FileExtensionSpoofError);
    });

    it('is refused as a whole buffer, and its first 64 KiB alone are still taken on the container signature', () => {
      const word = largeDocument('word');
      expect(() => assertNotSpoofedFile(word, 'sdw', 'large-word.sdw')).toThrow(FileExtensionSpoofError);
      expect(() => assertNotSpoofedFile(word.subarray(0, OBJECT_HEADER_BYTES), 'sdw', 'large-word.sdw')).not.toThrow();
    });

    it('is refused in a store by range requests that stay inside the object, and accepted when it is StarWriter', async () => {
      for (const [kind, ext, accepted] of [['word', 'sdw', false], ['writer', 'sdw', true], ['writer', 'sdc', false]] as const) {
        const bytes = largeDocument(kind);
        const backend = store(bytes);
        const check = assertCompoundFileKindInObject(backend, 'uploads/large', bytes.length, bytes.subarray(0, OBJECT_HEADER_BYTES), ext, `large.${ext}`);
        if (accepted) await check;
        else await expect(check).rejects.toBeInstanceOf(FileExtensionSpoofError);
        expect(backend.requests.length, `${kind} as .${ext}`).toBeGreaterThan(0);
        expect(backend.requests.length).toBeLessThanOrEqual(3);
      }
    });

    it('is not read at all when the header is the whole file or the extension is not a compound-only one', async () => {
      const backend = store(largeDocument('word'));
      const whole = compoundFileOf('sdw');
      await assertCompoundFileKindInObject(backend, 'uploads/small', whole.length, whole, 'sdw');
      await assertCompoundFileKindInObject(backend, 'uploads/doc', 10_000_000, Buffer.alloc(OBJECT_HEADER_BYTES), 'doc');
      expect(backend.requests).toHaveLength(0);
    });

    it('is refused by path when its first directory sector is the end-of-chain marker in a file of exactly 64 KiB', () => {
      const file = Buffer.alloc(OBJECT_HEADER_BYTES);
      compoundFileOf('sdw').copy(file, 0, 0, 512);
      file.writeUInt32LE(0xfffffffe, 48);
      expect(() => assertNotSpoofedFilePath(stored('end-of-chain.sdw', file), 'sdw', 'end-of-chain.sdw')).toThrow(FileExtensionSpoofError);
    });
  });

  it.each(['sdw', 'sdc', 'sda', 'shw', 'qpw'])('refuses programs, pages, pictures and archives under .%s', (ext) => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
    for (const bytes of [MZ_HEADER, ELF_HEADER, PNG_HEADER, zip, gzip(HTML), Buffer.from(HTML.padEnd(64), 'latin1')]) {
      expect(isFormatCompatibleWithMagicBytes(bytes, ext)).toBe(false);
    }
  });

  it('keeps a compound file out of the names of formats that are not compound files', () => {
    expect(isFormatCompatibleWithMagicBytes(compoundFileOf('sdw'), 'png')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(compoundFileOf('sdw'), 'zabw')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(compoundFileOf('sdw'), 'divx')).toBe(false);
  });
});

describe('formats that already passed keep their signatures', () => {
  it.for([['tika-testai_ps.ai', 'ai'], ['pil-hopper.heif', 'heif'], ['libheif-lightning_mini.heif', 'heif'], ['libheif-uncompressed_comp_rgb_tiled_row_tile_align.heif', 'heif']] as const)(
    'accepts the real file %s',
    async ([id, ext], ctx) => {
      const sample = await requireRealworldSample(ctx, id);
      expect(isFormatCompatibleWithMagicBytes(sample.bytes, ext)).toBe(true);
    }
  );

  it('accepts the AVC image brands of ISO/IEC 23008-12 under the HEIF names and nothing else under them', () => {
    const ftyp = (major: string): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from(`ftyp${major}`), Buffer.alloc(4), Buffer.from('mif1')]);
    expect(isFormatCompatibleWithMagicBytes(ftyp('avci'), 'heif')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(ftyp('avcs'), 'heic')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(ftyp('avci'), 'mp4')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(ftyp('avci'), 'avif')).toBe(false);
  });
});

describe('where the raw AAC check can and cannot see the frame behind an ID3v2 tag', () => {
  const ID3_HEADER_BYTES = 10;
  const ADTS_FRAME = [0xff, 0xf1];
  const NOT_A_FRAME = [0x4d, 0x5a];

  /** A buffer of `length` bytes that opens with an ID3v2.3 tag ending at `payloadOffset`, with `payload` there as far as it fits. */
  function taggedBuffer(length: number, payloadOffset: number, payload: readonly number[]): Buffer {
    const size = payloadOffset - ID3_HEADER_BYTES;
    const buffer = Buffer.alloc(length);
    buffer.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    payload.forEach((byte, index) => {
      if (payloadOffset + index < length) buffer[payloadOffset + index] = byte;
    });
    return buffer;
  }

  describe('a file shorter than the header window, which is the whole file', () => {
    const offset = 110;

    it.each([offset, offset + 1])('refuses a tag that ends at or one byte before the end of a %i-byte file: no frame follows', (length) => {
      expect(isFormatCompatibleWithMagicBytes(taggedBuffer(length, offset, ADTS_FRAME), 'aac')).toBe(false);
      expect(() => assertNotSpoofedFile(taggedBuffer(length, offset, ADTS_FRAME), 'aac', 'tag-only.aac')).toThrow(FileExtensionSpoofError);
    });

    it('accepts a file whose frame sync is the last two bytes, and refuses bytes of another kind there', () => {
      expect(sniffMimeTypeFromMagicBytes(taggedBuffer(offset + 2, offset, ADTS_FRAME))).toBe('audio/aac');
      expect(isFormatCompatibleWithMagicBytes(taggedBuffer(offset + 2, offset, ADTS_FRAME), 'aac')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(taggedBuffer(offset + 2, offset, NOT_A_FRAME), 'aac')).toBe(false);
    });

    it('refuses a tag that claims more bytes than the file holds', () => {
      expect(isFormatCompatibleWithMagicBytes(taggedBuffer(OBJECT_HEADER_BYTES - 1, OBJECT_HEADER_BYTES + 500, ADTS_FRAME), 'aac')).toBe(false);
    });
  });

  describe('a full header window, where the tag may run on past what can be read', () => {
    const length = OBJECT_HEADER_BYTES;

    it.each([length, length - 1, length + 1000])('accepts a tag that ends %i bytes into the file: the frame cannot be seen', (offset) => {
      expect(isFormatCompatibleWithMagicBytes(taggedBuffer(length, offset, ADTS_FRAME), 'aac')).toBe(true);
    });

    it('reads the frame when both of its bytes are inside the window', () => {
      expect(isFormatCompatibleWithMagicBytes(taggedBuffer(length, length - 2, ADTS_FRAME), 'aac')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(taggedBuffer(length, length - 2, NOT_A_FRAME), 'aac')).toBe(false);
    });
  });
});

describe('ADIF', () => {
  it.each(['csv', 'txt', 'adi'])('does not turn a text file that opens with the word into AAC (.%s)', (ext) => {
    const log = Buffer.from('ADIF Export from a station logger\n<EOH>\n<CALL:5>W1AW <EOR>\n');
    expect(sniffMimeTypeFromMagicBytes(log)).toBeUndefined();
    expect(isFormatCompatibleWithMagicBytes(log, ext)).toBe(true);
  });

  it.each(['aac', 'adts'])('accepts an ADIF header (ISO/IEC 13818-7 section 6.2.2) under .%s', (ext) => {
    const adif = Buffer.concat([Buffer.from('ADIF'), Buffer.alloc(24)]);
    expect(isFormatCompatibleWithMagicBytes(adif, ext)).toBe(true);
  });
});

describe('gzip-only names', () => {
  it.each(['zabw', 'svgz'])('refuse bytes that are not a gzip member under .%s', (ext) => {
    const bytes = [
      Buffer.from(HTML.padEnd(64), 'latin1'),
      Buffer.from(ABIWORD, 'latin1'),
      Buffer.from(SVG, 'latin1'),
      Buffer.from('plain text that no signature names, long enough to be a file', 'latin1'),
      Buffer.concat([Buffer.from('wOFF'), Buffer.alloc(60)]),
    ];
    for (const payload of bytes) {
      expect(isFormatCompatibleWithMagicBytes(payload, ext)).toBe(false);
      expect(() => assertNotSpoofedFile(payload, ext, `file.${ext}`)).toThrow(FileExtensionSpoofError);
    }
  });
});

describe('extensions that are names of Object.prototype', () => {
  it.each(['constructor', '__proto__', 'hasownproperty', 'valueof'])('refuse a ZIP package and a gzip member named .%s', (ext) => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
    expect(isFormatCompatibleWithMagicBytes(zip, ext)).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(gzip(SVG), ext)).toBe(false);
  });
});

describe('executable and Parquet signatures win over an ISO base media box', () => {
  const ftypAfter = (magic: readonly number[]): Buffer => {
    const box = Buffer.alloc(24);
    box.set(magic);
    box.write('ftypisom', 4, 'latin1');
    return box;
  };

  it.each([
    ['a DOS or Windows program', [0x4d, 0x5a]],
    ['a Parquet file', [0x50, 0x41, 0x52, 0x31]],
  ])('refuses %s whose bytes 4 to 8 spell ftyp under .mp4', (_label, magic) => {
    const bytes = ftypAfter(magic);
    expect(() => assertNotSpoofedFile(bytes, 'mp4', 'clip.mp4')).toThrow(FileExtensionSpoofError);
  });

  it('keeps a plain ftyp box an MP4 file', () => {
    expect(isFormatCompatibleWithMagicBytes(ftypAfter([0, 0, 0, 0x18]), 'mp4')).toBe(true);
  });
});

describe('every server entry point calls the server side gate', () => {
  /** Every TypeScript file under src, found by walking the tree. */
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it('imports the registry assertNotSpoofedFile nowhere but in the gate itself', () => {
    const SRC = path.join(process.cwd(), 'src');
    const importsRegistryCheck = (file: string): boolean =>
      /import\s*\{[^}]*\bassertNotSpoofedFile\b[^}]*\}\s*from\s*'[^']*\/registry'/.test(fs.readFileSync(file, 'utf8'));
    const offenders = sourceFiles(SRC).filter(importsRegistryCheck).map((file) => path.relative(SRC, file));
    expect(offenders).toEqual(['lib/security/file-guard.ts']);
  });
});
