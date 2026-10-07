import { describe, expect, it } from 'vitest';
import { FORMAT_REGISTRY, isFormatCompatibleWithMagicBytes } from '../src/lib/registry';

/**
 * The magic-byte gate must accept every genuine file of a format whose container is shared with other formats.
 * Inputs are hand-assembled from the container specifications: an ISO base media file starts with an `ftyp` box
 * (ISO/IEC 14496-12 section 4.3: size, 'ftyp', major brand, minor version, compatible brands), and a Matroska or
 * WebM file starts with an EBML header whose DocType names the profile (RFC 8794 section 11.2.6).
 */

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const EBML_DOCTYPE_ID = [0x42, 0x82];

function ftypBox(majorBrand: string): Buffer {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'ascii');
  box.write(majorBrand, 8, 'ascii');
  box.write(majorBrand, 16, 'ascii');
  return box;
}

function ebmlHeader(docType: string): Buffer {
  return Buffer.concat([Buffer.from(EBML_MAGIC), Buffer.from([0x9f]), Buffer.from(EBML_DOCTYPE_ID), Buffer.from([0x80 | docType.length]), Buffer.from(docType, 'ascii')]);
}

/** Each extension with the major brand a real file of that format carries (brand registries: 3GPP TS 26.244, ISO/IEC 14496-12 Annex E). */
const ISO_BASE_MEDIA_FILES: readonly (readonly [string, string])[] = [
  ['mp4', 'isom'],
  ['m4a', 'M4A '],
  ['m4b', 'M4B '],
  ['m4v', 'M4V '],
  ['mov', 'qt  '],
  ['3gp', '3gp4'],
  ['3gpp', '3gp5'],
  ['3g2', '3g2a'],
  ['f4v', 'F4V '],
  ['cr3', 'crx '],
];

describe('ISO base media file extensions', () => {
  it.each(ISO_BASE_MEDIA_FILES)('a real .%s file (major brand %j) passes the gate', (extension, brand) => {
    expect(FORMAT_REGISTRY[extension]?.extension).toBe(extension);
    expect(isFormatCompatibleWithMagicBytes(ftypBox(brand), extension)).toBe(true);
  });

  it.each(['png', 'pdf', 'docx', 'zip', 'mp3', 'flac'])('an MP4 file under the .%s name is still refused', (extension) => {
    expect(isFormatCompatibleWithMagicBytes(ftypBox('isom'), extension)).toBe(false);
  });
});

describe('EBML file extensions', () => {
  it.each([
    ['webm', 'webm'],
    ['weba', 'webm'],
    ['mkv', 'matroska'],
    ['mka', 'matroska'],
  ])('a real .%s file (EBML DocType %j) passes the gate', (extension, docType) => {
    expect(FORMAT_REGISTRY[extension]?.extension).toBe(extension);
    expect(isFormatCompatibleWithMagicBytes(ebmlHeader(docType), extension)).toBe(true);
  });

  it.each(['png', 'pdf', 'docx', 'mp4', 'mp3'])('a WebM file under the .%s name is still refused', (extension) => {
    expect(isFormatCompatibleWithMagicBytes(ebmlHeader('webm'), extension)).toBe(false);
  });
});

describe('CorelDRAW files', () => {
  const riff = (formType: string): Buffer => {
    const header = Buffer.alloc(16);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(8, 4);
    header.write(formType, 8, 'latin1');
    return header;
  };

  it.each(['CDR6', 'CDRX'])('a RIFF container with form type %s passes the gate under the .cdr name', (formType) => {
    expect(isFormatCompatibleWithMagicBytes(riff(formType), 'cdr')).toBe(true);
  });

  it('a ZIP package (CorelDRAW X4 and later) passes', () => {
    expect(isFormatCompatibleWithMagicBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]), 'cdr')).toBe(true);
  });

  it.each([
    ['an SVG document', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')],
    ['a RIFF WAVE file', riff('WAVE')],
    ['plain text', Buffer.from('this is not a drawing at all')],
  ])('%s under the .cdr name is refused', (_name, bytes) => {
    expect(isFormatCompatibleWithMagicBytes(bytes, 'cdr')).toBe(false);
  });
});

/**
 * Container of each format, from its specification: Office Open XML and OpenDocument packages are ZIP files
 * (ECMA-376 Part 2; OASIS ODF 1.3 section 3), Office 97-2003 files are OLE2 compound files ([MS-CFB]),
 * a comic book archive is a renamed RAR or 7z file.
 */
const ZIP_PACKAGE_EXTENSIONS = [
  'docm', 'xlsm', 'pptm', 'ppsx', 'ott', 'ots', 'otp', 'sxw', 'sxi', 'sxd', 'xps', 'oxps', 'pages', 'numbers', 'ibooks', 'war', 'ear', 'et',
];
const COMPOUND_FILE_EXTENSIONS = ['dot', 'xlt', 'pot', 'pps', 'msg', 'vsd', 'pub', 'et', 'wps', 'dps'];
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const COMPOUND_FILE_HEADER = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(16)]);
const RAR_HEADER = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0, 0, 0, 0, 0]);
const SEVEN_ZIP_HEADER = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 0, 0, 0, 0, 0, 0]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('ZIP-based, OLE2-based and renamed archive formats', () => {
  it.each(ZIP_PACKAGE_EXTENSIONS)('a ZIP package under the .%s name passes the gate', (extension) => {
    expect(FORMAT_REGISTRY[extension]?.extension).toBe(extension);
    expect(isFormatCompatibleWithMagicBytes(ZIP_HEADER, extension)).toBe(true);
  });

  it.each(COMPOUND_FILE_EXTENSIONS)('an OLE2 compound file under the .%s name passes the gate', (extension) => {
    expect(FORMAT_REGISTRY[extension]?.extension).toBe(extension);
    expect(isFormatCompatibleWithMagicBytes(COMPOUND_FILE_HEADER, extension)).toBe(true);
  });

  it('a RAR archive passes as .cbr and a 7z archive as .cb7', () => {
    expect(isFormatCompatibleWithMagicBytes(RAR_HEADER, 'cbr')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(SEVEN_ZIP_HEADER, 'cb7')).toBe(true);
  });

  it.each(['docm', 'ott', 'xps', 'dot', 'msg', 'cbr', 'cb7'])('a PNG image under the .%s name is still refused', (extension) => {
    expect(isFormatCompatibleWithMagicBytes(PNG_HEADER, extension)).toBe(false);
  });

  it.each(['docm', 'xps', 'pages'])('a compound file under the ZIP-only name .%s is refused', (extension) => {
    expect(isFormatCompatibleWithMagicBytes(COMPOUND_FILE_HEADER, extension)).toBe(false);
  });
});

/**
 * Compressed tar archives keep the compression wrapper's magic: a .tar.gz starts with the gzip header (RFC 1952: ID1 ID2
 * 0x1f 0x8b, method 8), a .tar.bz2 or .bz with "BZh" and a block size digit then the block magic 0x314159265359 (the
 * bzip2 format), a .tar.zst with the Zstandard magic number 0xFD2FB528 little-endian (RFC 8878 section 3.1.1).
 */
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 0, 0]);
const BZIP2_HEADER = Buffer.concat([Buffer.from('BZh9', 'ascii'), Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0, 0])]);
const ZSTD_HEADER = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x00, 0x01, 0x00, 0x00]);

describe('compressed tar archives and bzip2 streams under their registry names', () => {
  it.each([
    ['tar.gz', GZIP_HEADER],
    ['tar.bz2', BZIP2_HEADER],
    ['tar.bz', BZIP2_HEADER],
    ['bz', BZIP2_HEADER],
    ['tar.zst', ZSTD_HEADER],
  ] as const)('a genuine stream under the .%s name passes the gate', (extension, header) => {
    expect(FORMAT_REGISTRY[extension]?.extension).toBe(extension);
    expect(isFormatCompatibleWithMagicBytes(header, extension)).toBe(true);
  });

  it.each(['tar.gz', 'tar.bz2', 'tar.zst'])('a PNG image under the .%s name is still refused', (extension) => {
    expect(isFormatCompatibleWithMagicBytes(PNG_HEADER, extension)).toBe(false);
  });

  it('a gzip stream under a bzip2 name is still refused', () => {
    expect(isFormatCompatibleWithMagicBytes(GZIP_HEADER, 'tar.bz2')).toBe(false);
  });
});
