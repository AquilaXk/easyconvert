import { describe, expect, it, vi } from 'vitest';
import { buildCfbfContainer } from '../src/lib/conversions/cfbf-writer';
import { parseCfbf } from '../src/lib/conversions/cfbf-reader';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { repairPptPersistIdSeed } from '../src/lib/conversions/office/ppt-reader';
import { withLegacyOfficeRecovery } from '../src/worker/office-suite-route';
import type { WorkerConversionResult, WorkerVfsPayload } from '../src/worker/worker-types';
import { NO_ENTRY, entryFields, entryId, moveChainSectorToEnd, moveMiniChainSectorToEnd, setEntry } from './helpers/cfbf-layout';
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
const HTTP_UNPROCESSABLE = 422;
const PLAIN_TOKEN = 0xe391c05f;
const ENCRYPTED_TOKEN = 0xf3d1c4df;
const SECTOR_BYTES = 512;
const MINI_SECTOR_BYTES = 64;
const PERSIST_IDS = [1, 2, 3, 4, 5, 6];
/** Persist ids up to 0xABCDE, so raising a seed of 1 to the largest changes three of its four bytes (01 00 00 00 to DE BC 0A 00). */
const WIDE_PERSIST_IDS = [0xabcd9, 0xabcda, 0xabcdb, 0xabcdc, 0xabcdd, 0xabcde];
const WIDE_LARGEST_ID = 0xabcde;
const WIDE_SEED_BYTES_CHANGED = 3;

interface CraftedEdit {
  seed: number;
  /** Persist ids the directory lists, one offset each. */
  persistIds: number[];
  /** Offset of the previous edit; the edit's own offset makes a loop. */
  lastEdit?: 'self' | 0;
  /** Bytes before the persist directory, which move the edit and its seed. */
  prefix?: number;
  padding?: number;
  token?: number;
}

/** The PowerPoint Document stream of one persist directory and one UserEditAtom ([MS-PPT] 2.3.3 and 2.3.4), and the offset of the edit. */
function craftDocument(spec: CraftedEdit): { document: Buffer; editOffset: number } {
  const prefix = spec.prefix ?? 0;
  const directory = Buffer.alloc(8 + 4 + spec.persistIds.length * 4);
  directory.writeUInt16LE(0x1772, 2);
  directory.writeUInt32LE(directory.length - 8, 4);
  directory.writeUInt32LE(((spec.persistIds.length << 20) | spec.persistIds[0]) >>> 0, 8);
  const editOffset = prefix + directory.length;
  const edit = Buffer.alloc(8 + 28);
  edit.writeUInt16LE(0x0ff5, 2);
  edit.writeUInt32LE(28, 4);
  edit.writeUInt32LE(spec.lastEdit === 'self' ? editOffset : 0, 16);
  edit.writeUInt32LE(prefix, 20);
  edit.writeUInt32LE(spec.persistIds[0], 24);
  edit.writeUInt32LE(spec.seed, SEED_OFFSET_IN_EDIT_ATOM);
  return { document: Buffer.concat([Buffer.alloc(prefix), directory, edit, Buffer.alloc(spec.padding ?? 0)]), editOffset };
}

/** The Current User stream ([MS-PPT] 2.3.2) naming the edit at `editOffset`. */
function craftCurrentUser(editOffset: number, token = PLAIN_TOKEN): Buffer {
  const current = Buffer.alloc(8 + 20);
  current.writeUInt16LE(0x0ff6, 2);
  current.writeUInt32LE(20, 4);
  current.writeUInt32LE(20, 8);
  current.writeUInt32LE(token, 12);
  current.writeUInt32LE(editOffset, 16);
  return current;
}

/** A presentation with one persist directory and one UserEditAtom, written from [MS-PPT] 2.3.2, 2.3.3 and 2.3.4 with the compound file writer. */
function craftPresentation(spec: CraftedEdit): { file: Buffer; editOffset: number } {
  const { document, editOffset } = craftDocument(spec);
  const file = buildCfbfContainer([
    { name: 'Current User', data: craftCurrentUser(editOffset, spec.token) },
    { name: DOCUMENT_STREAM, data: document },
  ]);
  return { file, editOffset };
}

const seedOf = (file: Buffer, editOffset: number): number => parseCfbf(file).streams.get(DOCUMENT_STREAM)!.readUInt32LE(editOffset + SEED_OFFSET_IN_EDIT_ATOM);
const changedBytes = (before: Buffer, after: Buffer): number => [...before.keys()].filter((index) => before[index] !== after[index]).length;
/** The prefix that puts the seed of a document with `WIDE_PERSIST_IDS` at `seedOffset`: the edit follows the persist directory. */
const prefixForSeedAt = (seedOffset: number): number => seedOffset - (8 + 4 + WIDE_PERSIST_IDS.length * 4) - SEED_OFFSET_IN_EDIT_ATOM;
const documentStart = (file: Buffer): number => entryFields(file, entryId(file, DOCUMENT_STREAM)).start;

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
    expect(changedBytes(file, repaired)).toBe(1);
  });

  it('writes a seed that starts on the last byte of a mini sector into the next mini sector of the chain, which is not the next in the file', () => {
    const { file, editOffset } = craftPresentation({ seed: 1, persistIds: WIDE_PERSIST_IDS, prefix: prefixForSeedAt(2 * MINI_SECTOR_BYTES - 1) });
    const fragmented = moveMiniChainSectorToEnd(file, documentStart(file), 2);
    expect(seedOf(fragmented, editOffset)).toBe(1);
    const repaired = repairPptPersistIdSeed(fragmented)!;
    expect(seedOf(repaired, editOffset)).toBe(WIDE_LARGEST_ID);
    expect(changedBytes(fragmented, repaired)).toBe(WIDE_SEED_BYTES_CHANGED);
  });

  it.each([
    ['the next sector of the chain lies elsewhere in the file', 2],
    ['the sector it starts in is the last of the file', 1],
  ])('writes a seed that starts on the last byte of a sector into the next sector of the chain where %s', (_, movedIndex) => {
    const { file, editOffset } = craftPresentation({ seed: 1, persistIds: WIDE_PERSIST_IDS, prefix: prefixForSeedAt(2 * SECTOR_BYTES - 1), padding: 6000 });
    const fragmented = moveChainSectorToEnd(file, documentStart(file), movedIndex);
    expect(seedOf(fragmented, editOffset)).toBe(1);
    const repaired = repairPptPersistIdSeed(fragmented)!;
    expect(seedOf(repaired, editOffset)).toBe(WIDE_LARGEST_ID);
    expect(changedBytes(fragmented, repaired)).toBe(WIDE_SEED_BYTES_CHANGED);
  });

  it('reads and patches the PowerPoint Document stream the directory tree reaches, not an unreachable entry of that name', () => {
    const decoyName = 'PowerPoint DocumenX';
    const withDecoy = (seed: number, decoySeed: number): { file: Buffer; editOffset: number } => {
      const { document, editOffset } = craftDocument({ seed, persistIds: PERSIST_IDS });
      const decoy = craftDocument({ seed: decoySeed, persistIds: PERSIST_IDS }).document;
      const file = buildCfbfContainer([
        { name: 'Current User', data: craftCurrentUser(editOffset) },
        { name: DOCUMENT_STREAM, data: document },
        { name: decoyName, data: decoy },
      ]);
      const documentId = entryId(file, DOCUMENT_STREAM);
      const decoyId = entryId(file, decoyName);
      expect(entryFields(file, documentId).right).toBe(decoyId);
      setEntry(file, documentId, { right: NO_ENTRY });
      setEntry(file, decoyId, { name: DOCUMENT_STREAM });
      const container = parseCfbf(file);
      expect(container.streams.get(DOCUMENT_STREAM)).toEqual(decoy);
      expect(container.paths.get(DOCUMENT_STREAM)).toEqual(document);
      return { file, editOffset };
    };
    expect(repairPptPersistIdSeed(withDecoy(6, 1).file)).toBeUndefined();
    const { file, editOffset } = withDecoy(1, 6);
    const repaired = repairPptPersistIdSeed(file)!;
    expect(parseCfbf(repaired).paths.get(DOCUMENT_STREAM)!.readUInt32LE(editOffset + SEED_OFFSET_IN_EDIT_ATOM)).toBe(6);
    expect(changedBytes(file, repaired)).toBe(1);
  });

  it('leaves a seed that already covers the directory alone', () => {
    expect(repairPptPersistIdSeed(craftPresentation({ seed: 6, persistIds: [1, 2, 3, 4, 5, 6] }).file)).toBeUndefined();
    expect(repairPptPersistIdSeed(craftPresentation({ seed: 9, persistIds: [1, 2, 3] }).file)).toBeUndefined();
  });

  it('refuses an encrypted presentation as encrypted', () => {
    expect(() => repairPptPersistIdSeed(craftPresentation({ seed: 1, persistIds: [1, 2, 3], token: ENCRYPTED_TOKEN }).file)).toThrow(EncryptedOfficeDocumentError);
  });

  it('gives up on an edit history that loops, and on bytes that are no compound file', () => {
    expect(repairPptPersistIdSeed(craftPresentation({ seed: 1, persistIds: [1, 2, 3], lastEdit: 'self' }).file)).toBeUndefined();
    expect(repairPptPersistIdSeed(Buffer.from('not a compound file'))).toBeUndefined();
    const { file } = craftPresentation({ seed: 1, persistIds: [1, 2, 3] });
    expect(repairPptPersistIdSeed(file.subarray(0, 700))).toBeUndefined();
  });
});

describe('the office suite run on a presentation it could not load', () => {
  const suiteResult: WorkerConversionResult = { buffer: Buffer.from('%PDF'), mimeType: 'application/pdf', filename: 'out.pdf', size: 4, engineUsed: 'native-soffice-pool', executionTimeMs: 1 };
  const notLoaded = (): Error => new Error('LibreOffice execution completed without producing expected output file');
  /** A stand-in for the office suite that fails on its first run and converts on any later one. */
  const suiteFailingOnce = (failure: Error) => {
    const inputs: Array<Buffer | WorkerVfsPayload> = [];
    const run = vi.fn(async (input: Buffer | WorkerVfsPayload) => {
      inputs.push(input);
      if (inputs.length === 1) throw failure;
      return suiteResult;
    });
    return { run, inputs };
  };

  it('runs it once more on a copy with the seed raised', async () => {
    const { file, editOffset } = craftPresentation({ seed: 3, persistIds: PERSIST_IDS });
    const { run, inputs } = suiteFailingOnce(notLoaded());
    await expect(withLegacyOfficeRecovery(run)(file, 'ppt', 'pdf')).resolves.toBe(suiteResult);
    expect(inputs).toHaveLength(2);
    expect(seedOf(inputs[1] as Buffer, editOffset)).toBe(6);
  });

  it('answers an encrypted presentation as encrypted without running it again', async () => {
    const { file } = craftPresentation({ seed: 3, persistIds: PERSIST_IDS, token: ENCRYPTED_TOKEN });
    const { run } = suiteFailingOnce(notLoaded());
    await expect(withLegacyOfficeRecovery(run)(file, 'ppt', 'pdf')).rejects.toBeInstanceOf(EncryptedOfficeDocumentError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an input file that cannot be read', { inputPath: '/nonexistent/easyconvert/deck.ppt', outputPath: '/nonexistent/easyconvert/deck.pdf' }],
    ['bytes that are no compound file', Buffer.from('not a compound file')],
    ['a seed that already covers the directory', craftPresentation({ seed: 6, persistIds: PERSIST_IDS }).file],
  ])('keeps the error of the suite for %s', async (_, input) => {
    const failure = notLoaded();
    const { run } = suiteFailingOnce(failure);
    await expect(withLegacyOfficeRecovery(run)(input, 'ppt', 'pdf')).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
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

});

/**
 * Three POI test files whose records are damaged. The office suite (24.2 and 26.8) refuses each; Apache POI's HSLF reads the one
 * slide of each and the text pinned here (SlideShowExtractor.getText()), and so does the in-process reader. The seed is not their
 * fault, so they stay refused for the targets the suite writes.
 */
const DAMAGED_SAMPLES: ReadonlyArray<{ id: string; text: string[] }> = [
  { id: 'office-slideshow-2100a8d44da546f97ab7795c500a58bed6cb655d.ppt', text: ['This is a title, it\u2019s in black', 'This is the subtitle, in bold', 'This bit is blue and italic', 'This bit is red (normal)'] },
  { id: 'office-slideshow-60f557c0a46bcb0068b1c3e15589dac383307bc8.ppt', text: ['TEST1', 'TEST2', 'TEST3', 'TEST4'] },
  { id: 'office-slideshow-7ffe3cabb976ebc593dfe2f9461bdeac980a626c.ppt', text: ['Test {txtTot}', 'Another {txtTot}'] },
];

describe('PowerPoint files with damaged records', () => {
  for (const sample of DAMAGED_SAMPLES) {
    oracleTest(`${sample.id} stays a typed refusal for the office suite and its text is read in process`, ['soffice'], async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, sample.id);
      expect(repairPptPersistIdSeed(bytes)).toBeUndefined();
      await expect(dispatchConversion(bytes, 'ppt', 'pdf', {}, 'damaged.ppt')).rejects.toThrow('LibreOffice could not read the .ppt file');
      const text = (await dispatchConversion(bytes, 'ppt', 'txt', {}, 'damaged.ppt')).buffer.toString('utf-8');
      expect(text.split('\n').filter(Boolean)).toEqual(sample.text);
    }, CONVERSION_TIMEOUT_MS);
  }
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
      expect((failure as EncryptedOfficeDocumentError).status).toBe(HTTP_UNPROCESSABLE);
    }, CONVERSION_TIMEOUT_MS);
  }
});
