import { describe, expect, it } from 'vitest';
import { checkDjvuContainer, DJVU_MAX_COMPONENT_BYTES, DJVU_MAX_DIRECTORY_FILES, DJVU_MAX_INPUT_BYTES } from '../src/lib/conversions/djvu-container';
import { assertNotSpoofedFile, FileExtensionSpoofError } from '../src/lib/registry';
import { bundledDocument, bundleOf, chunk, form, includeChunk, indirectDocument, oldBundledDocument, pageForm, singlePage } from './helpers/djvu-builder';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';
import { expectWithinHangGuard } from './helpers/timing';

/**
 * What of a DjVu file is read before the programs of djvulibre start (src/lib/conversions/djvu-container.ts): the bytes of the
 * container and the directory header of a bundle. The pages, their sizes and their count are reported by `djvused`, and
 * checked in tests/djvu-report.test.ts and tests/djvu-render.test.ts. The real files are the three DjVu files of the real-world
 * corpus: a bundled document of 34 pages at 600 dpi, a single colour page, and the Apache Tika file, an indirect document that
 * names eight page files which are not in the corpus.
 */

const HANSARD = 'wc-hansard-1963-malaysia-bill-clause-4.djvu';
const DOGV = 'wc-dogv-12042005.djvu';
const TIKA_INDIRECT = 'tika-testdjvu.djvu';
/** The container of either hostile file takes about a millisecond on a fast core (1 and 5 ms measured); the guard only catches work that grows with the entries or chunks times the file. */
const EXPECTED_LOCAL_MS = 5;
const HANG_GUARD_MS = 10_000;
const MAX_COUNT_IN_HEADER = 65_535;
const NEWER_DIRECTORY_VERSION = 2;

const haveBzz = !skipWithoutTools('bzz');

const refusalOf = (bytes: Buffer): Error => {
  try {
    checkDjvuContainer(bytes);
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('the document was not refused');
};

describe('the container of real DjVu files', () => {
  it('accepts the single page of the Hansard file, which names nothing, and refuses it with a name of another file appended', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, HANSARD);
    expect(() => checkDjvuContainer(bytes)).not.toThrow();
    const include = includeChunk('dict0001.iff');
    const named = Buffer.concat([bytes, include]);
    named.writeUInt32BE(bytes.readUInt32BE(8) + include.length, 8);
    expect(refusalOf(named)).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('INCL') });
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

  it('accepts the bundled DOGV document, whose directory lists two shared dictionaries and 34 pages, and refuses it cut by one byte', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, DOGV);
    expect(() => checkDjvuContainer(bytes)).not.toThrow();
    expect(refusalOf(bytes.subarray(0, bytes.length - 1))).toMatchObject({ name: 'CorruptStreamError' });
    expect(refusalOf(bytes.subarray(0, Math.floor(bytes.length / 2)))).toMatchObject({ name: 'CorruptStreamError' });
  });
});

describe('documents that must not reach the programs', () => {
  it('refuses an indirect directory, whatever the file names', () => {
    expect(refusalOf(indirectDocument(['p0001.djvu', '../../etc/passwd']))).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('indirect') });
  });

  it.each(['INCL', 'NDIR'])('refuses a single page with a %s chunk, which makes the program read the file it names', (id) => {
    const page = singlePage(100, 100, [id === 'INCL' ? includeChunk('dict0001.iff') : chunk('NDIR', Buffer.from('p0001.djvu\n'))]);
    expect(refusalOf(page)).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining(id) });
  });

  it('refuses the obsolete DIR0 directory', () => {
    expect(refusalOf(oldBundledDocument())).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('DIR0') });
  });

  it('refuses a form that is neither a page nor a document, and a file without the magic', () => {
    expect(refusalOf(Buffer.concat([Buffer.from('AT&T'), form('DJVI', [])]))).toMatchObject({ name: 'CorruptStreamError' });
    expect(refusalOf(Buffer.concat([Buffer.from('AT&T'), form('PM44', [])]))).toMatchObject({ name: 'CorruptStreamError' });
    expect(refusalOf(Buffer.from('%PDF-1.7\n%%EOF\n'.repeat(4)))).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('AT&TFORM') });
  });

  it('refuses a chunk longer than the form that holds it', () => {
    const page = singlePage(10, 10, [chunk('BG44', Buffer.alloc(16))]);
    page.writeUInt32BE(0x7fffff00, page.length - 16 - 4);
    expect(refusalOf(page)).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('longer') });
  });

  it('refuses a file over the input limit before reading it', () => {
    const bytes = Buffer.allocUnsafeSlow(DJVU_MAX_INPUT_BYTES + 1);
    bytes.write('AT&TFORM', 0, 'latin1');
    expect(refusalOf(bytes)).toMatchObject({ name: 'PayloadLimitError' });
  });

  it('reads a page with a hundred thousand chunks in one pass, to the name of another file after the last of them', () => {
    const many = Array.from({ length: 100_000 }, () => chunk('ANTa', Buffer.alloc(2)));
    const started = process.hrtime.bigint();
    expect(() => checkDjvuContainer(singlePage(10, 10, many))).not.toThrow();
    expectWithinHangGuard('the container', Number(process.hrtime.bigint() - started) / 1e6, { guardMs: HANG_GUARD_MS, expectedLocalMs: EXPECTED_LOCAL_MS });
    expect(refusalOf(singlePage(10, 10, [...many, includeChunk('dict0001.iff')]))).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('INCL') });
  });
});

describe.skipIf(!haveBzz)('the directory of a bundle', () => {
  const page = pageForm(10, 10);
  const files = (count: number) => Array.from({ length: count }, (_, index) => ({ form: page, kind: 'page' as const, id: `p${index}.djvu` }));

  it('accepts directories of version 0, which keeps a size beside each offset, and version 1, and refuses an indirect directory by its missing bundle flag, a directory of a later version, and an empty one', () => {
    for (const version of [0, 1] as const) expect(() => checkDjvuContainer(bundleOf(files(3), { version })), `version ${version}`).not.toThrow();
    const bytes = bundleOf(files(1));
    const directoryFlags = 16 + 8;
    const indirect = Buffer.from(bytes);
    indirect[directoryFlags] = 1;
    expect(refusalOf(indirect)).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('indirect') });
    const newer = Buffer.from(bytes);
    newer[directoryFlags] = 0x80 | NEWER_DIRECTORY_VERSION;
    expect(refusalOf(newer)).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('newer') });
    const empty = Buffer.from(bytes);
    empty.writeUInt16BE(0, directoryFlags + 1);
    expect(refusalOf(empty)).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('no files') });
  });

  it(`accepts a directory of ${DJVU_MAX_DIRECTORY_FILES} entries over one page in time that does not grow with the entries, and refuses one more before any program reads it`, () => {
    const big = pageForm(10, 10, [chunk('BG44', Buffer.alloc(1 << 20))]);
    const entriesOf = (count: number) => Array.from({ length: count }, (_, index) => ({ component: 0, kind: 'page' as const, id: `p${index}.djvu` }));
    const bytes = bundledDocument([big], entriesOf(DJVU_MAX_DIRECTORY_FILES));
    const started = process.hrtime.bigint();
    expect(() => checkDjvuContainer(bytes)).not.toThrow();
    expectWithinHangGuard('the container', Number(process.hrtime.bigint() - started) / 1e6, { guardMs: HANG_GUARD_MS, expectedLocalMs: EXPECTED_LOCAL_MS });
    expect(refusalOf(bundledDocument([big], entriesOf(DJVU_MAX_DIRECTORY_FILES + 1)))).toMatchObject({ name: 'PayloadLimitError', status: 413 });
    expect(refusalOf(bundledDocument([big], entriesOf(MAX_COUNT_IN_HEADER)))).toMatchObject({ name: 'PayloadLimitError', status: 413 });
  });

  /** A page component of exactly `length` bytes, its FORM header included: 12 bytes of FORM header and type, 18 of INFO and a JUNK chunk. */
  const pageOfLength = (length: number): Buffer => pageForm(10, 10, [chunk('JUNK', Buffer.alloc(length - 38))]);

  it('refuses a bundle with a component of 16 MiB or more, whose size its directory cannot record, and accepts one of 16 MiB less two bytes and a single page of any size', () => {
    const bundleWith = (length: number) => bundleOf([{ form: page, kind: 'page', id: 'a.djvu' }, { form: pageOfLength(length), kind: 'page', id: 'b.djvu' }]);
    expect(() => checkDjvuContainer(bundleWith(DJVU_MAX_COMPONENT_BYTES - 1))).not.toThrow();
    for (const length of [DJVU_MAX_COMPONENT_BYTES + 1, DJVU_MAX_COMPONENT_BYTES + 3]) {
      expect(refusalOf(bundleWith(length))).toMatchObject({
        name: 'DjvuComponentSizeError',
        status: 422,
        message: `The DjVu document holds a component of ${length} bytes. A bundled DjVu document records the size of each component in 24 bits, so djvulibre cannot read a component of 16777216 bytes (16 MiB) or more; a page that large converts as a single-page DjVu file.`,
      });
    }
    expect(() => checkDjvuContainer(Buffer.concat([Buffer.from('AT&T', 'latin1'), pageOfLength(DJVU_MAX_COMPONENT_BYTES + 3)]))).not.toThrow();
  });

  it('walks a bundle of 500,000 chunks after its directory to its last component in time that does not grow with the file, and leaves a chunk that overruns the bundle to djvulibre', () => {
    const bundle = bundleOf(files(1));
    const withChunksBefore = (last: Buffer) => {
      const padded = Buffer.concat([bundle, Buffer.from('ANTa\0\0\0\0'.repeat(500_000), 'latin1'), last]);
      padded.writeUInt32BE(padded.length - 8 - 4, 8);
      return padded;
    };
    const started = process.hrtime.bigint();
    expect(() => checkDjvuContainer(withChunksBefore(Buffer.alloc(0)))).not.toThrow();
    expectWithinHangGuard('the component walk', Number(process.hrtime.bigint() - started) / 1e6, { guardMs: HANG_GUARD_MS, expectedLocalMs: EXPECTED_LOCAL_MS });
    expect(refusalOf(withChunksBefore(pageOfLength(DJVU_MAX_COMPONENT_BYTES + 1)))).toMatchObject({ name: 'DjvuComponentSizeError', status: 422 });
    const overrun = Buffer.concat([bundle, Buffer.from('FORM\x7f\0\0\0DJVU', 'latin1')]);
    overrun.writeUInt32BE(overrun.length - 8 - 4, 8);
    expect(() => checkDjvuContainer(overrun)).not.toThrow();
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
