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
