import { describe, expect, it } from 'vitest';
import { buildCfbfContainer } from '../src/lib/conversions/cfbf-writer';
import { parseCfbf } from '../src/lib/conversions/hwp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { repairPptPersistIdSeed } from '../src/lib/conversions/office/ppt-reader';
import { oracleTest } from './helpers/oracle-test';
import { pdfinfoPages } from './helpers/encrypted-pdf-fixtures';
import { requireRealworldSample } from './helpers/realworld-sample';
import { EncryptedOfficeDocumentError } from '../src/lib/types';

/**
 * Two real PowerPoint 97-2003 files (Apache POI's `backgrounds.ppt` and `pictures.ppt`) give the office suite
 * "source file could not be loaded". Their UserEditAtom ([MS-PPT] 2.3.3) holds a persistIdSeed of 3 while the persist
 * directory lists the ids 1 to 6 and 1 to 7, and the suite sizes its persist table from the seed
 * (filter/source/msfilter/svdfppt.cxx, SdrPowerPointImport constructor) and refuses a directory entry past it. The
 * specification says the seed is at least the largest persist id. Apache POI's HSLF reads the directory and ignores the
 * seed, and reads 4 and 5 slides from them. The file is read after the seed is raised to the largest id.
 */

const CONVERSION_TIMEOUT_MS = 300_000;
const DOCUMENT_STREAM = 'PowerPoint Document';
const SEED_OFFSET_IN_EDIT_ATOM = 28;
const PLAIN_TOKEN = 0xe391c05f;
const ENCRYPTED_TOKEN = 0xf3d1c4df;

interface CraftedEdit {
  seed: number;
  /** Persist ids the directory lists, one offset each. */
  persistIds: number[];
  /** Offset of the previous edit; the edit's own offset makes a loop. */
  lastEdit?: 'self' | 0;
  padding?: number;
  token?: number;
}

/** A presentation with one persist directory and one UserEditAtom, written from [MS-PPT] 2.3.2, 2.3.3 and 2.3.4 with the compound file writer. */
function craftPresentation(spec: CraftedEdit): { file: Buffer; editOffset: number } {
  const directory = Buffer.alloc(8 + 4 + spec.persistIds.length * 4);
  directory.writeUInt16LE(0x1772, 2);
  directory.writeUInt32LE(directory.length - 8, 4);
  directory.writeUInt32LE(((spec.persistIds.length << 20) | spec.persistIds[0]) >>> 0, 8);
  const editOffset = directory.length;
  const edit = Buffer.alloc(8 + 28);
  edit.writeUInt16LE(0x0ff5, 2);
  edit.writeUInt32LE(28, 4);
  edit.writeUInt32LE(spec.lastEdit === 'self' ? editOffset : 0, 16);
  edit.writeUInt32LE(0, 20);
  edit.writeUInt32LE(spec.persistIds[0], 24);
  edit.writeUInt32LE(spec.seed, SEED_OFFSET_IN_EDIT_ATOM);
  const document = Buffer.concat([directory, edit, Buffer.alloc(spec.padding ?? 0)]);
  const current = Buffer.alloc(8 + 20);
  current.writeUInt16LE(0x0ff6, 2);
  current.writeUInt32LE(20, 4);
  current.writeUInt32LE(20, 8);
  current.writeUInt32LE(spec.token ?? PLAIN_TOKEN, 12);
  current.writeUInt32LE(editOffset, 16);
  const file = buildCfbfContainer([
    { name: 'Current User', data: current },
    { name: DOCUMENT_STREAM, data: document },
  ]);
  return { file, editOffset };
}

const seedOf = (file: Buffer, editOffset: number): number => parseCfbf(file).streams.get(DOCUMENT_STREAM)!.readUInt32LE(editOffset + SEED_OFFSET_IN_EDIT_ATOM);

describe('repairPptPersistIdSeed', () => {
  it('raises a seed below the largest persist id to that id in a stream held by the mini stream', () => {
    const { file, editOffset } = craftPresentation({ seed: 3, persistIds: [1, 2, 3, 4, 5, 6] });
    expect(seedOf(file, editOffset)).toBe(3);
    const repaired = repairPptPersistIdSeed(file);
    expect(repaired).toBeDefined();
    expect(repaired).toHaveLength(file.length);
    expect(seedOf(repaired!, editOffset)).toBe(6);
  });

  it('raises it in a stream held by whole sectors, changing nothing else in the file', () => {
    const { file, editOffset } = craftPresentation({ seed: 2, persistIds: [1, 2, 3, 4, 5, 6, 7], padding: 6000 });
    const repaired = repairPptPersistIdSeed(file)!;
    expect(seedOf(repaired, editOffset)).toBe(7);
    const changed = [...file.keys()].filter((index) => file[index] !== repaired[index]);
    expect(changed).toHaveLength(1);
  });

  it('leaves a seed that already covers the directory alone', () => {
    expect(repairPptPersistIdSeed(craftPresentation({ seed: 6, persistIds: [1, 2, 3, 4, 5, 6] }).file)).toBeUndefined();
    expect(repairPptPersistIdSeed(craftPresentation({ seed: 9, persistIds: [1, 2, 3] }).file)).toBeUndefined();
  });

  it('leaves an encrypted presentation alone', () => {
    expect(repairPptPersistIdSeed(craftPresentation({ seed: 1, persistIds: [1, 2, 3], token: ENCRYPTED_TOKEN }).file)).toBeUndefined();
  });

  it('gives up on an edit history that loops, and on bytes that are no compound file', () => {
    expect(repairPptPersistIdSeed(craftPresentation({ seed: 1, persistIds: [1, 2, 3], lastEdit: 'self' }).file)).toBeUndefined();
    expect(repairPptPersistIdSeed(Buffer.from('not a compound file'))).toBeUndefined();
    const { file } = craftPresentation({ seed: 1, persistIds: [1, 2, 3] });
    expect(repairPptPersistIdSeed(file.subarray(0, 700))).toBeUndefined();
  });
});

/** Slides of each file as Apache POI's HSLF counts them (HSLFSlideShow.getSlides()). */
const SAMPLES: ReadonlyArray<{ id: string; seed: number; largestPersistId: number; slides: number }> = [
  { id: 'office-slideshow-backgrounds.ppt', seed: 3, largestPersistId: 6, slides: 4 },
  { id: 'office-slideshow-pictures.ppt', seed: 3, largestPersistId: 7, slides: 5 },
];

describe('PowerPoint files with a persist id seed below the directory', () => {
  for (const sample of SAMPLES) {
    it(`${sample.id} is repaired from ${sample.seed} to ${sample.largestPersistId}`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, sample.id);
      const repaired = repairPptPersistIdSeed(bytes)!;
      expect(repaired).toBeDefined();
      const stream = parseCfbf(repaired).streams.get(DOCUMENT_STREAM)!;
      const original = parseCfbf(bytes).streams.get(DOCUMENT_STREAM)!;
      const differing = [...original.keys()].filter((index) => original[index] !== stream[index]);
      expect(differing).toHaveLength(1);
      // Only the low byte of the 4-byte seed changes, so the first differing index is the start of the field.
      expect(stream.readUInt32LE(differing[0])).toBe(sample.largestPersistId);
    });

    oracleTest(`${sample.id} becomes a PDF of ${sample.slides} pages`, ['soffice', 'pdfinfo'], async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, sample.id);
      const result = await dispatchConversion(bytes, 'ppt', 'pdf', {}, sample.id);
      expect(pdfinfoPages(result.buffer)).toBe(sample.slides);
    }, CONVERSION_TIMEOUT_MS);
  }

  oracleTest('a presentation whose records are overwritten stays a typed refusal, as the office suite cannot read it', ['soffice'], async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'office-slideshow-7ffe3cabb976ebc593dfe2f9461bdeac980a626c.ppt');
    expect(repairPptPersistIdSeed(bytes)).toBeUndefined();
    const run = dispatchConversion(bytes, 'ppt', 'pdf', {}, 'damaged.ppt');
    await expect(run).rejects.toThrow('LibreOffice could not read the .ppt file');
  }, CONVERSION_TIMEOUT_MS);
});

/**
 * Encrypted PowerPoint files: Apache POI's HSLF throws EncryptedPowerPointFileException for each ("PowerPoint file is
 * encrypted. The correct password needs to be set via Biff8EncryptionKey.setCurrentUserPassword()"), and their Current User
 * stream carries the encrypted header token 0xf3d1c4df ([MS-PPT] 2.3.2). The file is intact, so the answer is the typed 422 for an
 * encrypted document, not the 400 that says the file is damaged.
 */
const ENCRYPTED_SAMPLES = [
  'govdocs1-002164.ppt',
  'office-slideshow-ppt_with_png_encrypted.ppt',
  'office-slideshow-password_protected-hello.ppt',
  'office-slideshow-password_protected-56-hello.ppt',
  'office-slideshow-password_protected-np-hello.ppt',
];

describe('Encrypted PowerPoint files', () => {
  for (const id of ENCRYPTED_SAMPLES) {
    oracleTest(`${id} is refused as encrypted`, ['soffice'], async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const failure = await dispatchConversion(bytes, 'ppt', 'pdf', {}, 'locked.ppt').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(EncryptedOfficeDocumentError);
    }, CONVERSION_TIMEOUT_MS);
  }
});
