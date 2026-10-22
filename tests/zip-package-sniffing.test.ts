import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEADER_WINDOW_BYTES } from '../src/lib/format-signatures';
import { assertNotSpoofedFile, FileExtensionSpoofError, isFormatCompatibleWithMagicBytes, sniffMimeTypeFromMagicBytes } from '../src/lib/registry';

/**
 * A ZIP package is told apart by the names in its local file headers and by the media type its first entry `mimetype` holds
 * (EPUB OCF 3.3 section 4.3.3, OpenDocument 1.3 part 2 section 3.3, ECMA-376 part 2 / ISO/IEC 29500-2 sections 7.3.3 and 7.3.7,
 * ZIP APPNOTE 4.3.7). Bytes inside an entry's data, compressed or not, say nothing about the package.
 *
 * The packages in `fixtures/zip-packages` are written by Python's zipfile and by Info-ZIP `zip` (`generate.py`), not by this
 * repository's ZIP writer; the rest are documents other tools wrote, kept as fixtures by other tests.
 */

const FIXTURES = path.join(__dirname, 'fixtures');
const PACKAGES = path.join(FIXTURES, 'zip-packages');
const read = (...parts: string[]): Buffer => fs.readFileSync(path.join(FIXTURES, ...parts));

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const EPUB = 'application/epub+zip';
const ODT = 'application/vnd.oasis.opendocument.text';
const ODS = 'application/vnd.oasis.opendocument.spreadsheet';
const ODP = 'application/vnd.oasis.opendocument.presentation';
const HWPX = 'application/hwp+zip';
const ZIP = 'application/zip';
const PACKAGE_MIME_TYPES: ReadonlySet<string | undefined> = new Set([DOCX, XLSX, PPTX, EPUB, ODT, ODS, ODP, HWPX, ZIP]);

const ZIP_LOCAL_HEADER = 0x04034b50;
const HEADER_BYTES = 30;
const DATA_DESCRIPTOR_FLAG = 0x08;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

/** Package, expected type, and the names the package is fit to carry. */
const PACKAGE_FIXTURES: ReadonlyArray<readonly [string, string, string, readonly string[]]> = [
  // Written by Python zipfile; an entry's data (level 0 deflate keeps its text as literal bytes) names the folders of other packages.
  ['zip-packages/epub-chapter-names-office-folders.epub', 'epub', EPUB, ['epub']],
  ['zip-packages/odt-content-names-office-folders.odt', 'odt', ODT, ['odt']],
  ['zip-packages/ods-content-names-office-folders.ods', 'ods', ODS, ['ods']],
  ['zip-packages/odp-content-names-office-folders.odp', 'odp', ODP, ['odp']],
  ['zip-packages/ott-content-names-office-folders.ott', 'ott', ODT, ['ott', 'odt']],
  ['zip-packages/odg-content-names-office-folders.odg', 'odg', ZIP, ['odg', 'odt', 'ods', 'epub', 'docx', 'zip']],
  ['zip-packages/plain-text-names-office-folders.zip', 'zip', ZIP, ['zip', 'docx', 'xlsx', 'epub']],
  // A package whose first entry is not [Content_Types].xml, written by Python zipfile.
  ['zip-packages/docx-content-types-not-first.docx', 'docx', DOCX, ['docx']],
  ['zip-packages/xlsx-names-only.xlsx', 'xlsx', XLSX, ['xlsx']],
  ['zip-packages/pptx-names-only.pptx', 'pptx', PPTX, ['pptx']],
  // Sizes in data descriptors (bit 3): the local headers hold zeros, also for the stored `mimetype`.
  ['zip-packages/epub-data-descriptor.epub', 'epub', EPUB, ['epub']],
  ['zip-packages/docx-data-descriptor.docx', 'docx', DOCX, ['docx']],
  // Written by Info-ZIP zip: without and with the extended timestamp extra field on every entry.
  ['zip-packages/epub-info-zip.epub', 'epub', EPUB, ['epub']],
  ['zip-packages/epub-info-zip-extra-fields.epub', 'epub', EPUB, ['epub']],
  // Documents written by other tools.
  ['sample.docx', 'docx', DOCX, ['docx']],
  ['sample.xlsx', 'xlsx', XLSX, ['xlsx']],
  ['golden/office/multi-column-annotated.docx', 'docx', DOCX, ['docx']],
  ['golden/office/drawingml-shapes-presentation.pptx', 'pptx', PPTX, ['pptx']],
  ['golden/office/multi-sheet-enterprise.xlsx', 'xlsx', XLSX, ['xlsx']],
  ['golden/office/multi-sheet-enterprise.ods', 'ods', ODS, ['ods']],
  ['document/book.epub', 'epub', EPUB, ['epub']],
  ['golden/document/multi-column-annotated.hwpx', 'hwpx', HWPX, ['hwpx']],
  ['office-sources/drawing-two-pages.odg', 'odg', ZIP, ['odg', 'zip']],
  ['sample.zip', 'zip', ZIP, ['zip', 'docx']],
];

const PACKAGE_EXTENSIONS = ['docx', 'xlsx', 'pptx', 'epub', 'odt', 'ods', 'odp', 'hwpx'] as const;
const OWN_EXTENSION_OF: Readonly<Record<string, string>> = { [DOCX]: 'docx', [XLSX]: 'xlsx', [PPTX]: 'pptx', [EPUB]: 'epub', [ODT]: 'odt', [ODS]: 'ods', [ODP]: 'odp', [HWPX]: 'hwpx' };

/** One local file header (APPNOTE 4.3.7) and the bytes after it. */
function localEntry(name: string, options: { flags?: number; method?: number; storedLength?: number; extra?: Buffer; data?: Buffer } = {}): Buffer {
  const data = options.data ?? Buffer.alloc(0);
  const extra = options.extra ?? Buffer.alloc(0);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(ZIP_LOCAL_HEADER, 0);
  header.writeUInt16LE(options.flags ?? 0, 6);
  header.writeUInt16LE(options.method ?? 0, 8);
  header.writeUInt32LE(options.storedLength ?? data.length, 18);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, Buffer.from(name), extra, data]);
}

/** A data descriptor with the signature (APPNOTE 4.3.9) for an entry whose compressed data is `size` bytes. */
function dataDescriptor(size: number): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

/** Bytes from a fixed sequence, not random, so a failure reproduces. */
function noise(length: number, seed: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

describe('the type of a ZIP package', () => {
  it.each(PACKAGE_FIXTURES)('%s is %s', (file, _extension, expected) => {
    expect(sniffMimeTypeFromMagicBytes(read(file))).toBe(expected);
  });

  it('is not taken from bytes in an entry that spell the folder of another package', () => {
    const epub = read('zip-packages/epub-chapter-names-office-folders.epub');
    // The reproduction: the folder names are literal bytes inside the first 4096 bytes, in the chapter's data.
    expect(epub.subarray(0, 4096).toString('latin1')).toContain('xl/');
    expect(epub.subarray(0, 4096).toString('latin1')).toContain('word/');
    expect(sniffMimeTypeFromMagicBytes(epub)).toBe(EPUB);
  });

  it('is the same for a whole file and for its first header window', () => {
    for (const [file] of PACKAGE_FIXTURES) {
      const whole = Buffer.concat([read(file), noise(3 * HEADER_WINDOW_BYTES, 7)]);
      expect(sniffMimeTypeFromMagicBytes(whole.subarray(0, HEADER_WINDOW_BYTES)), file).toBe(sniffMimeTypeFromMagicBytes(whole));
    }
  });

  it('reads the media type of a first entry named mimetype whatever follows it in the data', () => {
    const entries = (mediaType: string): Buffer => Buffer.concat([localEntry('mimetype', { data: Buffer.from(mediaType) }), localEntry('content.xml', { data: Buffer.from('word/ xl/ ppt/') })]);
    expect(sniffMimeTypeFromMagicBytes(entries('application/epub+zip'))).toBe(EPUB);
    expect(sniffMimeTypeFromMagicBytes(entries('application/vnd.oasis.opendocument.text'))).toBe(ODT);
    expect(sniffMimeTypeFromMagicBytes(entries('application/vnd.oasis.opendocument.spreadsheet-template'))).toBe(ODS);
    expect(sniffMimeTypeFromMagicBytes(entries('application/vnd.oasis.opendocument.presentation'))).toBe(ODP);
    expect(sniffMimeTypeFromMagicBytes(entries('application/hwp+zip'))).toBe(HWPX);
    expect(sniffMimeTypeFromMagicBytes(entries('application/epub+zip\n'))).toBe(EPUB);
  });

  it('is plain ZIP when the first entry named mimetype holds another or no media type, or is not stored', () => {
    const rest = localEntry('content.xml', { data: Buffer.from('<x/>') });
    const withMimetype = (entry: Buffer): Buffer => Buffer.concat([entry, rest]);
    expect(sniffMimeTypeFromMagicBytes(withMimetype(localEntry('mimetype', { data: Buffer.from('application/vnd.oasis.opendocument.graphics') })))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(withMimetype(localEntry('mimetype', { data: Buffer.from('application/epub+zipx') })))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(withMimetype(localEntry('mimetype', { data: Buffer.from('application/epub+zip'.padEnd(2000, ' ')) })))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(withMimetype(localEntry('mimetype', { method: 8, data: Buffer.from('application/epub+zip') })))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(withMimetype(localEntry('mimetype')))).toBe(ZIP);
  });

  it('is taken from a mimetype entry only when it is the first entry', () => {
    const late = Buffer.concat([localEntry('content.xml', { data: Buffer.from('<x/>') }), localEntry('mimetype', { data: Buffer.from('application/epub+zip') })]);
    expect(sniffMimeTypeFromMagicBytes(late)).toBe(ZIP);
  });

  it('is taken from the first entry that is under a main-part folder of a package, in order', () => {
    const names = (...entryNames: string[]): Buffer => Buffer.concat(entryNames.map((name) => localEntry(name, { data: Buffer.from('word/ xl/ ppt/') })));
    expect(sniffMimeTypeFromMagicBytes(names('[Content_Types].xml', '_rels/.rels', 'word/document.xml'))).toBe(DOCX);
    expect(sniffMimeTypeFromMagicBytes(names('[Content_Types].xml', 'xl/workbook.xml'))).toBe(XLSX);
    expect(sniffMimeTypeFromMagicBytes(names('docProps/app.xml', 'ppt/presentation.xml'))).toBe(PPTX);
    expect(sniffMimeTypeFromMagicBytes(names('xl/workbook.xml', 'word/document.xml'))).toBe(XLSX);
    expect(sniffMimeTypeFromMagicBytes(names('[Content_Types].xml', '_rels/.rels', 'docProps/app.xml'))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(names('notes/word/a.txt', 'myxl/b.txt', 'Word/c.txt'))).toBe(ZIP);
  });

  it('is HWPX for a package with a Contents/section entry and no other marker', () => {
    const names = Buffer.concat([localEntry('version.xml'), localEntry('Contents/header.xml'), localEntry('Contents/section0.xml')]);
    expect(sniffMimeTypeFromMagicBytes(names)).toBe(HWPX);
  });
});

describe('a ZIP package that is cut, odd or hostile', () => {
  it('never throws and always names a package type when cut at any length', () => {
    for (const [file] of PACKAGE_FIXTURES) {
      const bytes = read(file);
      for (let length = 0; length <= bytes.length; length++) {
        const sniffed = sniffMimeTypeFromMagicBytes(bytes.subarray(0, length));
        if (length >= 4) expect(PACKAGE_MIME_TYPES.has(sniffed), `${file} cut at ${length}`).toBe(true);
      }
    }
  });

  it('with the first header cut inside its name is plain ZIP', () => {
    const header = localEntry('mimetype', { data: Buffer.from('application/epub+zip') });
    for (let length = 4; length < HEADER_BYTES + 'mimetype'.length; length++) {
      expect(sniffMimeTypeFromMagicBytes(header.subarray(0, length)), `cut at ${length}`).toBe(ZIP);
    }
  });

  it('with a stored mimetype that a data descriptor sizes is read when the descriptor gives the size of the data', () => {
    const sized = (data: string, descriptor: Buffer): Buffer => Buffer.concat([localEntry('mimetype', { flags: DATA_DESCRIPTOR_FLAG, storedLength: 0, data: Buffer.from(data) }), descriptor]);
    const media = 'application/epub+zip';
    expect(sniffMimeTypeFromMagicBytes(sized(media, dataDescriptor(media.length)))).toBe(EPUB);
    expect(sniffMimeTypeFromMagicBytes(sized(media, dataDescriptor(media.length + 1)))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(sized(media, Buffer.alloc(0)))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(sized(media, Buffer.from('more text')))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(sized(media.padEnd(400, 'a'), dataDescriptor(400)))).toBe(ZIP);
  });

  it('with data descriptors on the entries before the marking entry reads on, also past bytes that spell a descriptor signature', () => {
    const spelled = Buffer.concat([Buffer.from('compressed bytes '), dataDescriptor(1), Buffer.from(' and more')]);
    const bytes = Buffer.concat([
      localEntry('[Content_Types].xml', { flags: DATA_DESCRIPTOR_FLAG, storedLength: 0, method: 8, data: spelled }),
      dataDescriptor(spelled.length),
      localEntry('_rels/.rels', { flags: DATA_DESCRIPTOR_FLAG, storedLength: 0, method: 8 }),
      dataDescriptor(0),
      localEntry('xl/workbook.xml'),
    ]);
    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe(XLSX);
  });

  it('with a data descriptor that no entry data matches stops at that entry, and is plain ZIP', () => {
    const bytes = Buffer.concat([localEntry('docProps/core.xml', { flags: DATA_DESCRIPTOR_FLAG, storedLength: 0, data: Buffer.from('abc') }), dataDescriptor(99), localEntry('word/document.xml')]);
    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe(ZIP);
  });

  it('with a header that claims sizes far past the bytes is plain ZIP, not an error', () => {
    const huge = (name: string): Buffer => localEntry(name, { storedLength: 0xffffffff, data: Buffer.from('xx') });
    expect(sniffMimeTypeFromMagicBytes(huge('docProps/core.xml'))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(Buffer.concat([huge('docProps/core.xml'), localEntry('word/document.xml')]))).toBe(ZIP);
    const longExtra = localEntry('mimetype', { extra: Buffer.alloc(0xffff), data: Buffer.from('application/epub+zip') });
    expect(sniffMimeTypeFromMagicBytes(longExtra.subarray(0, 4000))).toBe(ZIP);
    const longName = Buffer.alloc(HEADER_BYTES + 100);
    longName.writeUInt32LE(ZIP_LOCAL_HEADER, 0);
    longName.writeUInt16LE(0xffff, 26);
    expect(sniffMimeTypeFromMagicBytes(longName)).toBe(ZIP);
  });

  it('with noise after the signature never throws and is plain ZIP unless an entry name says otherwise', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), noise(256 + seed, seed)]);
      expect(PACKAGE_MIME_TYPES.has(sniffMimeTypeFromMagicBytes(bytes)), `seed ${seed}`).toBe(true);
    }
  });

  it('with ten thousand tiny entries is read in bounded time and does not look past the first entries it reads', () => {
    const tiny = Array.from({ length: 10_000 }, (_, index) => localEntry(`f${index}.txt`));
    const bytes = Buffer.concat([...tiny, localEntry('[Content_Types].xml'), localEntry('word/document.xml')]);
    expect(bytes.length).toBeGreaterThan(HEADER_WINDOW_BYTES);
    const started = performance.now();
    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe(ZIP);
    for (let run = 0; run < 50; run++) sniffMimeTypeFromMagicBytes(bytes);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('with the marking entry past the header window is plain ZIP', () => {
    const bytes = Buffer.concat([localEntry('media/big.bin', { data: noise(HEADER_WINDOW_BYTES, 3) }), localEntry('word/document.xml')]);
    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe(ZIP);
  });

  it('that is empty or only a record signature is plain ZIP', () => {
    expect(sniffMimeTypeFromMagicBytes(Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBe(ZIP);
    expect(sniffMimeTypeFromMagicBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(ZIP);
  });
});

describe('the upload gate on ZIP packages', () => {
  it.each(PACKAGE_FIXTURES)('%s passes under its own names', (file, _extension, _expected, names) => {
    for (const name of names) expect(isFormatCompatibleWithMagicBytes(read(file), name), `${file} under .${name}`).toBe(true);
  });

  it('refuses a package under the name of a different package, whatever its data spells', () => {
    for (const [file, , expected, names] of PACKAGE_FIXTURES) {
      const own = OWN_EXTENSION_OF[expected];
      if (own === undefined) continue;
      for (const extension of PACKAGE_EXTENSIONS.filter((candidate) => !names.includes(candidate))) {
        expect(isFormatCompatibleWithMagicBytes(read(file), extension), `${file} under .${extension}`).toBe(false);
      }
    }
  });

  it('refuses the EPUB whose chapter names the other folders under the names of the packages they belong to, with the spoof error', () => {
    const epub = read('zip-packages/epub-chapter-names-office-folders.epub');
    for (const extension of ['docx', 'xlsx', 'pptx', 'odt']) {
      expect(() => assertNotSpoofedFile(epub, extension, `book.${extension}`)).toThrow(FileExtensionSpoofError);
    }
    expect(() => assertNotSpoofedFile(epub, 'epub', 'book.epub')).not.toThrow();
  });

  it('accepts a package of no known type under every ZIP name, as before', () => {
    const odg = read('zip-packages/odg-content-names-office-folders.odg');
    for (const extension of ['odg', 'zip', 'docx', 'epub', 'jar']) expect(isFormatCompatibleWithMagicBytes(odg, extension), extension).toBe(true);
  });

  it('refuses a ZIP package under names that are not ZIP names', () => {
    const docx = read('sample.docx');
    for (const extension of ['pdf', 'png', 'txt', 'doc']) expect(isFormatCompatibleWithMagicBytes(docx, extension), extension).toBe(false);
  });
});
