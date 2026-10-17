import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gunzipHead } from '../src/lib/gzip-head';
import { xmlRootElementName } from '../src/lib/format-signatures';
import { assertNotSpoofedFile, FileExtensionSpoofError, isFormatCompatibleWithMagicBytes, sniffMimeTypeFromMagicBytes } from '../src/lib/registry';
import { assertNotSpoofedFilePath } from '../src/lib/security/file-guard';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * Content variants of formats the spoof check refused although the files are what their names say (#783): compressed
 * AbiWord and compressed SVG (a gzip member whose inflated head opens with the format's root element), raw AAC behind an
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

const gzip = (text: string): Buffer => zlib.gzipSync(Buffer.from(text));

/** Runs libmagic's `file` over bytes the test holds on disk; the caller skips without the tool. */
function libmagicMime(filePath: string): string {
  return execFileSync(getOracleToolPath('file') as string, ['--mime-type', '-b', filePath], { encoding: 'utf8' }).trim();
}

const noLibmagic = skipUnless('file (libmagic)', getOracleToolPath('file') !== null);

describe('gunzipHead (the head of a gzip member without Node zlib)', () => {
  const PROSE = 'The quick brown fox jumps over the lazy dog. '.repeat(400);
  const NOISE = Buffer.from(Array.from({ length: 6000 }, (_, index) => (index * 7919 + (index >> 3) * 31) & 0xff));

  it.each([0, 1, 6, 9])('returns the first bytes of a member compressed at level %i', (level) => {
    const input = Buffer.concat([Buffer.from(PROSE), NOISE, Buffer.from(PROSE)]);
    const member = zlib.gzipSync(input, { level });
    expect(Buffer.from(gunzipHead(member, 5000) as Uint8Array).equals(input.subarray(0, 5000))).toBe(true);
    expect(Buffer.from(gunzipHead(member, input.length + 100) as Uint8Array).equals(input)).toBe(true);
  });

  it('reads a member of fixed Huffman blocks', () => {
    const member = zlib.gzipSync(Buffer.from('abcabcabcabc'), { strategy: zlib.constants.Z_FIXED });
    expect(Buffer.from(gunzipHead(member, 100) as Uint8Array).toString()).toBe('abcabcabcabc');
  });

  it('stops at the budget instead of inflating a stream that expands far past it', () => {
    const bomb = zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024));
    expect(gunzipHead(bomb, 1024)?.length).toBe(1024);
  });

  it('returns the bytes decoded so far when the window ends inside the stream', () => {
    const input = Buffer.from(PROSE);
    const member = zlib.gzipSync(input, { level: 0 });
    const head = gunzipHead(member.subarray(0, 3000), 100000) as Uint8Array;
    expect(head.length).toBeGreaterThan(0);
    expect(Buffer.from(head).equals(input.subarray(0, head.length))).toBe(true);
  });

  it('skips the optional header fields of RFC 1952 (extra, name, comment, header CRC)', () => {
    const body = zlib.deflateRawSync(Buffer.from(SVG));
    const fields = Buffer.concat([Buffer.from([3, 0, 1, 2, 3]), Buffer.from('a.svg\0'), Buffer.from('note\0'), Buffer.from([0, 0])]);
    const header = Buffer.from([0x1f, 0x8b, 8, 0x04 | 0x08 | 0x10 | 0x02, 0, 0, 0, 0, 0, 3]);
    expect(Buffer.from(gunzipHead(Buffer.concat([header, fields, body]), 1000) as Uint8Array).toString()).toBe(SVG);
  });

  it('refuses a stream that is not valid deflate and a header that is not complete', () => {
    const member = gzip(SVG);
    const reservedBlockType = Buffer.concat([member.subarray(0, 10), Buffer.from([0x07, 0, 0, 0, 0])]);
    expect(gunzipHead(reservedBlockType, 100)).toBeUndefined();
    expect(gunzipHead(member.subarray(0, 9), 100)).toBeUndefined();
    const nameNeverEnds = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0x08, 0, 0, 0, 0, 0, 3]), Buffer.from('no terminator')]);
    expect(gunzipHead(nameNeverEnds, 100)).toBeUndefined();
  });

  it('refuses a stored block whose length and complement disagree and a distance before the start', () => {
    const header = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
    expect(gunzipHead(Buffer.concat([header, Buffer.from([0x01, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5])]), 100)).toBeUndefined();
    // A fixed-code block (BFINAL=1, BTYPE=01) whose first symbol is a length-3 match at distance 1, with nothing written yet.
    expect(gunzipHead(Buffer.concat([header, Buffer.from([0x03, 0x02, 0x00])]), 100)).toBeUndefined();
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
    expect(() => assertNotSpoofedFilePath(sample.path, 'zabw', id)).not.toThrow();
  });

  it.for(['okular-checkmark.svgz', 'okular-hisc-apps-okular.svgz', 'tika-testsvg.svgz'])('accepts the real file %s', async (id, ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    expect(isFormatCompatibleWithMagicBytes(sample.bytes, 'svgz')).toBe(true);
  });

  it('accepts a gzip member of an AbiWord document under .zabw and of an SVG under .svgz', () => {
    expect(isFormatCompatibleWithMagicBytes(gzip(ABIWORD), 'zabw')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(gzip(SVG), 'svgz')).toBe(true);
  });

  it('accepts a document whose head is longer than the compressed window shows', () => {
    const padded = `${ABIWORD}\n${'<!-- filler -->\n'.repeat(20000)}`;
    expect(isFormatCompatibleWithMagicBytes(zlib.gzipSync(Buffer.from(padded)).subarray(0, 64 * 1024), 'zabw')).toBe(true);
  });

  it.each([
    ['a page that holds an <svg> element', HTML, 'svgz'],
    ['a page', HTML, 'zabw'],
    ['another XML document', OTHER_XML, 'zabw'],
    ['another XML document', OTHER_XML, 'svgz'],
    ['an SVG document', SVG, 'zabw'],
    ['an AbiWord document', ABIWORD, 'svgz'],
    ['plain text', 'hello', 'zabw'],
  ])('refuses a gzip member of %s under .%s', (_label, text, ext) => {
    const bytes = gzip(text);
    expect(isFormatCompatibleWithMagicBytes(bytes, ext)).toBe(false);
    expect(() => assertNotSpoofedFile(bytes, ext, `file.${ext}`)).toThrow(FileExtensionSpoofError);
  });

  it.each(['zabw', 'svgz'])('refuses a gzip member of a PNG, of a program and of noise under .%s', (ext) => {
    for (const payload of [PNG_HEADER, MZ_HEADER, ELF_HEADER, Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff))]) {
      expect(isFormatCompatibleWithMagicBytes(zlib.gzipSync(payload), ext)).toBe(false);
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
  const compoundFile = (): Buffer => Buffer.concat([CFBF_MAGIC, Buffer.alloc(504)]);
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

  it.each(['sdw', 'sdc', 'sda', 'shw', 'qpw'])('accepts the compound file signature under .%s', (ext) => {
    expect(isFormatCompatibleWithMagicBytes(compoundFile(), ext)).toBe(true);
  });

  it.each(['sdw', 'sdc', 'sda', 'shw', 'qpw'])('refuses programs, pages, pictures and archives under .%s', (ext) => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
    for (const bytes of [MZ_HEADER, ELF_HEADER, PNG_HEADER, zip, gzip(HTML), Buffer.from(HTML.padEnd(64), 'latin1')]) {
      expect(isFormatCompatibleWithMagicBytes(bytes, ext)).toBe(false);
    }
  });

  it('keeps a compound file out of the names of formats that are not compound files', () => {
    expect(isFormatCompatibleWithMagicBytes(compoundFile(), 'png')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(compoundFile(), 'zabw')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(compoundFile(), 'divx')).toBe(false);
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
