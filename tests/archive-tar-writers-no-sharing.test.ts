import { describe, expect, it } from 'vitest';
import { readTarEntries } from '../src/lib/conversions/archive';
import { tarFromMembers, rarToTar, tarToZip, zipToTar, type TarMember } from '../src/lib/conversions/archive-repack';
import { LIMITS, sevenZipToTar, wrapInPlace, type SevenZipOutput } from '../src/lib/conversions/archive-stream';
import { readZipDirectory, readZipEntries } from '../src/lib/conversions/archive-zip-reader';
import { getOracleToolPath } from './helpers/differential-oracle';
import { hostileTarEnd, hostileTarMember } from './helpers/hostile-tar';
import { oracleTest } from './helpers/oracle-test';
import { buildStoredRar4 } from './helpers/rar4-stored';
import { craftSevenZip } from './helpers/seven-zip-craft';
import { craftZip } from './helpers/zip-craft';

/**
 * No tar writer hands out a buffer of its own. Each test converts once, writes 0xff over every byte range of the result,
 * and converts again from a fresh copy of the same input; the second result must equal the first. A header, padding or end
 * block taken from a module-level buffer would carry the 0xff into the second result.
 *
 * The input is copied for each run on purpose: a stored ZIP, RAR or tar member may be a view of the input, which is the
 * contract of `StreamedArchive` (byte ranges that may alias the input or the unpacked bytes, never a buffer of the module).
 */
const BLOCK = 512;
const END_BLOCKS_BYTES = 2 * BLOCK;
const FILL_BYTE = 0xff;
const TEST_TIMEOUT_MS = 60_000;

const ALPHA = Buffer.from('alpha, not a multiple of a block');
const BETA = Buffer.alloc(1500, 7);
const GAMMA = Buffer.alloc(BLOCK * 2, 9);

/** The bytes of one segment, through its own offset and length, whatever the size of the buffer behind it. */
function bytesOf(segment: Uint8Array): Buffer {
  return Buffer.from(segment.buffer, segment.byteOffset, segment.byteLength);
}

function fillWithJunk(segments: readonly Uint8Array[]): void {
  for (const segment of segments) bytesOf(segment).fill(FILL_BYTE);
}

function filesOf(tar: Buffer): Map<string, Buffer> {
  return new Map(
    readTarEntries(tar, { ignoreLinks: true })
      .filter((entry) => entry.type === 'file')
      .map((entry): [string, Buffer] => [entry.filename, Buffer.from(entry.buffer)])
  );
}

/** What the tar must hold, read back by the tar reader and not taken from the writer's own segments. */
function expectFiles(tar: Buffer, expected: Record<string, Buffer>): void {
  const files = filesOf(tar);
  expect([...files.keys()].sort()).toEqual(Object.keys(expected).sort());
  for (const [name, data] of Object.entries(expected)) expect(files.get(name)?.equals(data)).toBe(true);
}

/** The two end blocks of a tar are zeros, also when an earlier test wrote junk over a buffer that a writer wrongly kept. */
function expectZeroEndBlocks(tar: Buffer): void {
  expect(tar.subarray(tar.length - END_BLOCKS_BYTES).every((byte) => byte === 0)).toBe(true);
}

/** Converts, writes junk over the result, converts again, and returns both joined results taken before and after. */
async function convertTwice(convert: () => Promise<readonly Uint8Array[] | undefined> | readonly Uint8Array[] | undefined): Promise<{ first: Buffer; second: Buffer }> {
  const firstSegments = await convert();
  expect(firstSegments).toBeDefined();
  const first = Buffer.concat(firstSegments as readonly Uint8Array[]);
  fillWithJunk(firstSegments as readonly Uint8Array[]);
  const secondSegments = await convert();
  expect(secondSegments).toBeDefined();
  return { first, second: Buffer.concat(secondSegments as readonly Uint8Array[]) };
}

describe('the tar writers of the repack routes', () => {
  /** New member bytes for each run, since a member's data is a range of what the caller gave and the junk is written over it. */
  const membersOf = (): TarMember[] => [
    { filename: 'docs', isDirectory: true, data: Buffer.alloc(0) },
    { filename: 'docs/alpha.txt', isDirectory: false, data: Buffer.from(ALPHA) },
    { filename: 'beta.bin', isDirectory: false, data: Buffer.from(BETA) },
    { filename: 'gamma.bin', isDirectory: false, data: Buffer.from(GAMMA) },
  ];
  const expectedFiles = { 'docs/alpha.txt': ALPHA, 'beta.bin': BETA, 'gamma.bin': GAMMA };

  it('tarFromMembers gives every result end blocks and padding of its own', async () => {
    const { first, second } = await convertTwice(() => tarFromMembers(membersOf()));

    expect(second.equals(first)).toBe(true);
    expectFiles(first, expectedFiles);
    expectZeroEndBlocks(first);
  });

  it('tarFromMembers gives end blocks of their own to a tar of directories only', async () => {
    const { first, second } = await convertTwice(() => tarFromMembers([{ filename: 'only', isDirectory: true, data: Buffer.alloc(0) }]));

    expect(second.equals(first)).toBe(true);
    expect(first).toHaveLength(BLOCK + END_BLOCKS_BYTES);
    expectZeroEndBlocks(first);
  });

  it('zipToTar, for stored and deflated entries', async () => {
    const zip = craftZip([
      { name: 'docs/', method: 0, externalAttributes: ((0o040755 << 16) | 0x10) >>> 0, versionMadeBy: (3 << 8) | 20 },
      { name: 'docs/alpha.txt', data: ALPHA, method: 8 },
      { name: 'beta.bin', data: BETA, method: 0 },
      { name: 'gamma.bin', data: GAMMA, method: 8 },
    ]);

    const { first, second } = await convertTwice(async () => (await zipToTar({ source: { buffer: Buffer.from(zip) } }))?.segments);

    expect(second.equals(first)).toBe(true);
    expectFiles(first, expectedFiles);
    expectZeroEndBlocks(first);
  });

  it('rarToTar, for stored members', async () => {
    const rar = buildStoredRar4([
      { name: 'docs/alpha.txt', data: ALPHA },
      { name: 'beta.bin', data: BETA },
      { name: 'gamma.bin', data: GAMMA },
    ]);

    const { first, second } = await convertTwice(() => rarToTar({ source: { buffer: Buffer.from(rar) } })?.segments);

    expect(second.equals(first)).toBe(true);
    expectFiles(first, expectedFiles);
    expectZeroEndBlocks(first);
  });

  it('tarToZip at level 0, whose stored entries are ranges of the tar it was given', async () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'docs/', typeflag: '5' }),
      hostileTarMember({ name: 'docs/alpha.txt' }, ALPHA),
      hostileTarMember({ name: 'beta.bin' }, BETA),
      hostileTarMember({ name: 'gamma.bin' }, GAMMA),
      hostileTarEnd(),
    ]);

    const { first, second } = await convertTwice(async () => (await tarToZip({ source: { buffer: Buffer.from(tar) }, compressionLevel: 0 }))?.segments);

    expect(second.equals(first)).toBe(true);
    const directory = readZipDirectory(first, LIMITS);
    const read = await readZipEntries(first, directory, { limits: LIMITS });
    expect(new Map(read.map((entry) => [entry.filename, entry.buffer]))).toEqual(new Map(Object.entries(expectedFiles)));
  });

  oracleTest(
    'sevenZipToTar, whose members are cut out of the bytes 7-Zip wrote',
    ['7z'],
    async () => {
      const archive = craftSevenZip([
        { name: 'docs', directory: true },
        { name: 'docs/alpha.txt', data: ALPHA },
        { name: 'beta.bin', data: BETA },
        { name: 'gamma.bin', data: GAMMA },
      ]);

      const { first, second } = await convertTwice(
        async () =>
          (
            await sevenZipToTar({
              p7zBin: getOracleToolPath('7z') as string,
              source: { buffer: Buffer.from(archive) },
              originalFilename: 'sample.7z',
              timeoutMs: 20_000,
            })
          )?.segments
      );

      expect(second.equals(first)).toBe(true);
      expectFiles(first, expectedFiles);
      expectZeroEndBlocks(first);
    },
    TEST_TIMEOUT_MS
  );
});

describe('wrapInPlace', () => {
  const HEADROOM = BLOCK;

  /** What 7-Zip's output looks like to the wrap: the body inside a frame with room for the header before it and the padding and end blocks behind it. */
  function outputOf(body: Buffer, withFrame: boolean): SevenZipOutput {
    const frame = Buffer.alloc(HEADROOM + body.length + BLOCK - 1 + END_BLOCKS_BYTES, FILL_BYTE);
    body.copy(frame, HEADROOM);
    return { stdout: frame.subarray(HEADROOM, HEADROOM + body.length), frame: withFrame ? frame : undefined, headroomBytes: HEADROOM };
  }

  it.each([
    ['in the frame it was given', true],
    ['by copying when there is no frame', false],
  ])('writes a tar of its own %s, and nothing of it is shared with the next one', async (_name, withFrame) => {
    const { first, second } = await convertTwice(() => wrapInPlace(outputOf(ALPHA, withFrame), 'member'));

    expect(second.equals(first)).toBe(true);
    expectFiles(first, { member: ALPHA });
    expectZeroEndBlocks(first);
    expect(first).toHaveLength(BLOCK + BLOCK + END_BLOCKS_BYTES);
    expect(first.subarray(BLOCK + ALPHA.length).every((byte) => byte === 0)).toBe(true);
  });
});
