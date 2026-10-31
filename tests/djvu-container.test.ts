import { describe, expect, it } from 'vitest';
import { DJVU_MAX_INPUT_BYTES, DJVU_MAX_PAGES, readDjvuDocument } from '../src/lib/conversions/djvu-container';
import { DEFAULT_MAX_INPUT_PIXELS } from '../src/lib/conversions/image-input-limits';
import { assertNotSpoofedFile, FileExtensionSpoofError } from '../src/lib/registry';
import { bundledDocument, chunk, form, includeChunk, indirectDocument, oldBundledDocument, pageForm, singlePage } from './helpers/djvu-builder';
import { requireRealworldSample } from './helpers/realworld-sample';
import { expectWithinHangGuard } from './helpers/timing';

/**
 * The structure of a DjVu file is read before `ddjvu` starts (src/lib/conversions/djvu-container.ts). The real files are the three
 * DjVu files of the real-world corpus: a bundled document of 34 pages at 600 dpi, a single colour page, and the Apache Tika file,
 * an indirect document that names eight page files which are not in the corpus.
 */

const HANSARD = 'wc-hansard-1963-malaysia-bill-clause-4.djvu';
const DOGV = 'wc-dogv-12042005.djvu';
const TIKA_INDIRECT = 'tika-testdjvu.djvu';
/** The layout of either hostile file takes about a millisecond on a fast core (1 and 5 ms measured); the guard only catches work that grows with the entries or chunks times the file. */
const EXPECTED_LOCAL_MS = 5;
const HANG_GUARD_MS = 10_000;

const refusalOf = (bytes: Buffer): Error => {
  try {
    readDjvuDocument(bytes);
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('the document was not refused');
};

describe('the layout of real DjVu files', () => {
  it('reads the single page of the Hansard file with the size djvudump prints (2550 x 3300)', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, HANSARD);
    expect(readDjvuDocument(bytes)).toEqual({ bundled: false, pages: [{ width: 2550, height: 3300 }] });
  });

  it('reads the 34 pages of the bundled DOGV document, each 4958 x 7017 as djvudump prints', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, DOGV);
    const layout = readDjvuDocument(bytes);
    expect(layout.bundled).toBe(true);
    expect(layout.pages).toHaveLength(34);
    expect(new Set(layout.pages.map((page) => `${page.width}x${page.height}`))).toEqual(new Set(['4958x7017']));
  });

  it('refuses the Tika document, which is indirect: its eight pages are files next to the index', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, TIKA_INDIRECT);
    expect(refusalOf(bytes)).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('indirect') });
  });

  it('refuses a file cut anywhere inside its form with a typed corruption error', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, HANSARD);
    for (const fraction of [0.01, 0.3, 0.7, 0.99]) {
      const cut = bytes.subarray(0, Math.floor(bytes.length * fraction));
      expect(refusalOf(cut), `${fraction}`).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('truncated') });
    }
  });

  it('refuses a bundled document cut after its directory', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, DOGV);
    expect(refusalOf(bytes.subarray(0, bytes.length - 1))).toMatchObject({ name: 'CorruptStreamError' });
    expect(refusalOf(bytes.subarray(0, Math.floor(bytes.length / 2)))).toMatchObject({ name: 'CorruptStreamError' });
  });
});

describe('documents that must not reach the program', () => {
  it('refuses an indirect directory, whatever the file names', () => {
    expect(refusalOf(indirectDocument(['p0001.djvu', '../../etc/passwd']))).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('indirect') });
  });

  it.each(['INCL', 'NDIR'])('refuses a single page with a %s chunk, which makes the program read the file it names', (id) => {
    const page = singlePage(100, 100, [id === 'INCL' ? includeChunk('dict0001.iff') : chunk('NDIR', Buffer.from('p0001.djvu\n'))]);
    expect(refusalOf(page)).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining(id) });
  });

  it('accepts a page of a bundled document that includes shared data, which the program reads from the bundle only', () => {
    const shared = form('DJVI', [chunk('Djbz', Buffer.alloc(4))]);
    const layout = readDjvuDocument(bundledDocument([shared, pageForm(100, 200, [includeChunk('dict0001.iff')])]));
    expect(layout.pages).toEqual([{ width: 100, height: 200 }]);
  });

  it('refuses the obsolete DIR0 directory', () => {
    expect(refusalOf(oldBundledDocument())).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('DIR0') });
  });

  it('refuses a form that is neither a page nor a document, and a file without the magic', () => {
    expect(refusalOf(Buffer.concat([Buffer.from('AT&T'), form('DJVI', [])]))).toMatchObject({ name: 'CorruptStreamError' });
    expect(refusalOf(Buffer.concat([Buffer.from('AT&T'), form('PM44', [])]))).toMatchObject({ name: 'CorruptStreamError' });
    expect(refusalOf(Buffer.from('%PDF-1.7\n%%EOF\n'.repeat(4)))).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('AT&TFORM') });
  });

  it('refuses a page without a size, a page whose first chunk is not INFO, and a short INFO chunk', () => {
    expect(refusalOf(singlePage(0, 100))).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('empty page') });
    expect(refusalOf(singlePage(100, 0))).toMatchObject({ name: 'CorruptStreamError' });
    expect(refusalOf(Buffer.concat([Buffer.from('AT&T'), form('DJVU', [chunk('BG44', Buffer.alloc(8))])]))).toMatchObject({ message: expect.stringContaining('INFO') });
    expect(refusalOf(Buffer.concat([Buffer.from('AT&T'), form('DJVU', [chunk('INFO', Buffer.alloc(3))])]))).toMatchObject({ message: expect.stringContaining('shorter') });
  });

  it('refuses a page over the pixel limit of the image inputs, from its header and before any decoding', () => {
    const side = Math.floor(Math.sqrt(DEFAULT_MAX_INPUT_PIXELS)) + 1;
    expect(refusalOf(singlePage(side, side))).toMatchObject({ name: 'InputPixelLimitError', status: 413 });
    expect(readDjvuDocument(singlePage(10_000, 10_000)).pages).toHaveLength(1);
  });

  it('refuses a chunk longer than the form that holds it', () => {
    const page = singlePage(10, 10, [chunk('BG44', Buffer.alloc(16))]);
    page.writeUInt32BE(0x7fffff00, page.length - 16 - 4);
    expect(refusalOf(page)).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('longer') });
  });

  it('refuses a directory whose offset lies outside the document', () => {
    const document = bundledDocument([pageForm(10, 10)]);
    const directoryOffset = 16 + 8 + 3;
    document.writeUInt32BE(document.length + 100, directoryOffset);
    expect(refusalOf(document)).toMatchObject({ name: 'CorruptStreamError' });
    document.writeUInt32BE(0, directoryOffset);
    expect(refusalOf(document)).toMatchObject({ name: 'CorruptStreamError' });
  });
});

describe('the limits of the structure', () => {
  it(`refuses a document that lists more than ${DJVU_MAX_PAGES} pages, which the directory can only reach by naming a page again`, () => {
    const listed = Array.from({ length: DJVU_MAX_PAGES + 1 }, () => 0);
    const document = bundledDocument([pageForm(10, 10)], listed);
    expect(refusalOf(document)).toMatchObject({ name: 'PayloadLimitError', status: 413 });
    expect(readDjvuDocument(bundledDocument([pageForm(10, 10)], listed.slice(1))).pages).toHaveLength(DJVU_MAX_PAGES);
  });

  it('reads a directory of 65,535 entries over one page once, in time that does not grow with the entries', () => {
    const page = pageForm(10, 10, [chunk('BG44', Buffer.alloc(1 << 20))]);
    const document = bundledDocument([page], Array.from({ length: 65_535 }, () => 0));
    const started = process.hrtime.bigint();
    expect(refusalOf(document)).toMatchObject({ name: 'PayloadLimitError' });
    expectWithinHangGuard('the layout', Number(process.hrtime.bigint() - started) / 1e6, { guardMs: HANG_GUARD_MS, expectedLocalMs: EXPECTED_LOCAL_MS });
  });

  it('refuses a file over the input limit before reading it', () => {
    const bytes = Buffer.allocUnsafeSlow(DJVU_MAX_INPUT_BYTES + 1);
    bytes.write('AT&TFORM', 0, 'latin1');
    expect(refusalOf(bytes)).toMatchObject({ name: 'PayloadLimitError' });
  });

  it('reads a page with a hundred thousand chunks in one pass', () => {
    const many = Array.from({ length: 100_000 }, () => chunk('ANTa', Buffer.alloc(2)));
    const started = process.hrtime.bigint();
    expect(readDjvuDocument(singlePage(10, 10, many)).pages).toHaveLength(1);
    expectWithinHangGuard('the layout', Number(process.hrtime.bigint() - started) / 1e6, { guardMs: HANG_GUARD_MS, expectedLocalMs: EXPECTED_LOCAL_MS });
  });
});

describe('the name of a DjVu file against its bytes', () => {
  const djvu = singlePage(10, 10);

  it('accepts DjVu bytes under .djvu and .djv, and refuses any other bytes under those names', () => {
    expect(() => assertNotSpoofedFile(djvu, 'djvu')).not.toThrow();
    expect(() => assertNotSpoofedFile(djvu, 'djv')).not.toThrow();
    for (const impostor of [Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'), Buffer.from('plain text that is not a book'), Buffer.concat([Buffer.from('AT&T'), form('DJVI', [])])]) {
      expect(() => assertNotSpoofedFile(impostor, 'djvu')).toThrow(FileExtensionSpoofError);
      expect(() => assertNotSpoofedFile(impostor, 'djv')).toThrow(FileExtensionSpoofError);
    }
  });

  it('refuses DjVu bytes under the name of another format', () => {
    for (const name of ['pdf', 'png', 'txt', 'jpg']) expect(() => assertNotSpoofedFile(djvu, name), name).toThrow(FileExtensionSpoofError);
  });
});
