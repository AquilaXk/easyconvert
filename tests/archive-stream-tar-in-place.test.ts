import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTarEntries } from '../src/lib/conversions/archive';
import { memberNameFor, streamToTar, tarFromEntries, wrapAsMember, type StreamRunOptions } from '../src/lib/conversions/archive-stream';
import { classifyUnpacked } from '../src/lib/conversions/archive-stream-route';
import { convertWithNative7z } from '../src/worker/engines';
import type { executeSandboxedBinary } from '../src/lib/security/process-sandbox';
import { getOracleToolPath } from './helpers/differential-oracle';
import { hostileTarEnd, hostileTarMember } from './helpers/hostile-tar';
import { oracleTest } from './helpers/oracle-test';

type SandboxRun = Awaited<ReturnType<typeof executeSandboxedBinary>>;

const sandboxFrames = vi.hoisted(() => ({ head: 0xaa, tail: 0xbb, started: 0, runs: [] as { frame: Buffer; headroom: number; tailroom: number }[] }));

/** The sandbox runs for real; the rooms around the output it collects are then filled with marker bytes, so that a write into them shows. */
vi.mock('../src/lib/security/process-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/security/process-sandbox')>();
  return {
    ...actual,
    executeSandboxedBinary: async (...args: Parameters<typeof executeSandboxedBinary>): Promise<SandboxRun> => {
      sandboxFrames.started++;
      const run = await actual.executeSandboxedBinary(...args);
      const { stdoutHeadroomBytes: headroom = 0, stdoutTailroomBytes: tailroom = 0 } = args[2] ?? {};
      if (run.stdoutFrame !== undefined) {
        run.stdoutFrame.fill(sandboxFrames.head, 0, headroom);
        run.stdoutFrame.fill(sandboxFrames.tail, run.stdoutFrame.length - tailroom);
        sandboxFrames.runs.push({ frame: run.stdoutFrame, headroom, tailroom });
      }
      return run;
    },
  };
});

const BLOCK = 512;
const GNU_LONG_NAME_BYTES = 505;
/** One record of GNU tar and Python's tarfile: the output is padded with zeros to a multiple of this. */
const TAR_RECORD_BYTES = 20 * BLOCK;
const MIB = 1024 * 1024;
const FRAME_HEAD = 300;
const FRAME_TAIL = 700;
const JUNK_BYTE = 0x58;
const BODY_BYTES = 4096;
type Policy = Pick<StreamRunOptions, 'skipLinks' | 'collisionPolicy'>;
const KEEP_LAST_DUPLICATE: Policy = { collisionPolicy: 'overwrite' };
const SKIP_LINKS: Policy = { skipLinks: true };

function referenceTarFromCopy(tar: Buffer): Buffer {
  return Buffer.concat(tarFromEntries(readTarEntries(Buffer.from(tar), { ignoreLinks: true })));
}

function paxRecord(key: string, value: string): Buffer {
  let length = key.length + value.length + 3;
  let record = `${length} ${key}=${value}\n`;
  while (record.length !== length) {
    length = record.length;
    record = `${length} ${key}=${value}\n`;
  }
  return Buffer.from(record);
}

function gnuLongName(name: string): Buffer {
  return hostileTarMember({ name: '././@LongLink', typeflag: 'L' }, Buffer.from(`${name}\0`));
}

function fileBodies(buffer: Buffer): Uint8Array[] {
  return readTarEntries(buffer, { ignoreLinks: true })
    .filter((entry) => entry.type === 'file' && entry.buffer.length > 0)
    .map((entry) => entry.buffer);
}

/** What the reader hands the rewrite: the bodies are windows onto the very buffer that will be written over. */
function expectBodiesToBeViewsOf(bodies: Uint8Array[], unpacked: Buffer): void {
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(body.buffer).toBe(unpacked.buffer);
    expect(body.byteOffset).toBeGreaterThanOrEqual(unpacked.byteOffset);
    expect(body.byteOffset + body.length).toBeLessThanOrEqual(unpacked.byteOffset + unpacked.length);
  }
}

/** Whether the bytes of `source` lie within `unpacked`, so that writing them into it moves bytes that are already there. */
function isWindowOf(source: Uint8Array, unpacked: Buffer): boolean {
  return source.buffer === unpacked.buffer && source.byteOffset >= unpacked.byteOffset && source.byteOffset + source.length <= unpacked.byteOffset + unpacked.length;
}

/**
 * The bytes that `Uint8Array.prototype.set` and `Buffer.prototype.copy` wrote into `unpacked`: the length of each source of a
 * `set` whose target is a window of it, and what each `copy` into a window of it returned. A body that went through a temporary
 * and back is counted here even though the temporary is no window of `unpacked`.
 */
function bytesWrittenInto(unpacked: Buffer, writes: { mock: { calls: unknown[][]; contexts: unknown[] } }, copies: { mock: { calls: unknown[][]; results: { value: unknown }[] } }): number {
  let total = 0;
  writes.mock.calls.forEach(([source], index) => {
    if (isWindowOf(writes.mock.contexts[index] as Uint8Array, unpacked)) total += (source as Uint8Array).length;
  });
  copies.mock.calls.forEach(([target], index) => {
    if (isWindowOf(target as Uint8Array, unpacked)) total += copies.mock.results[index].value as number;
  });
  return total;
}

interface ByteRange {
  buffer: ArrayBufferLike;
  start: number;
  end: number;
}

function rangeOf(view: Uint8Array, offset = 0, length = view.length - offset): ByteRange {
  return { buffer: view.buffer, start: view.byteOffset + offset, end: view.byteOffset + offset + Math.max(0, length) };
}

function overlap(a: ByteRange, b: ByteRange): boolean {
  return a.buffer === b.buffer && a.start < b.end && b.start < a.end;
}

/** Where the observed `set`, `copy` and `copyWithin` calls wrote, whatever view of the memory they went through. */
function writeTargets(
  writes: { mock: { calls: unknown[][]; contexts: unknown[] } },
  copies: { mock: { calls: unknown[][]; results: { value: unknown }[] } },
  moves: { mock: { calls: unknown[][]; contexts: unknown[] } }
): ByteRange[] {
  const targets = writes.mock.calls.map(([source, offset], index) => rangeOf(writes.mock.contexts[index] as Uint8Array, (offset as number | undefined) ?? 0, (source as Uint8Array).length));
  copies.mock.calls.forEach(([target, targetStart], index) => {
    targets.push(rangeOf(target as Uint8Array, (targetStart as number | undefined) ?? 0, copies.mock.results[index].value as number));
  });
  moves.mock.calls.forEach(([target, start, end], index) => {
    const view = moves.mock.contexts[index] as Uint8Array;
    targets.push(rangeOf(view, target as number, Math.min(((end as number | undefined) ?? view.length) - (start as number), view.length - (target as number))));
  });
  return targets;
}

/** A fresh pool slab, so that the copy and the headers written after it fit in it. */
function startOfPoolSlab(): void {
  let probe = Buffer.allocUnsafe(1);
  for (let attempt = 0; probe.byteOffset !== 0 && attempt < Buffer.poolSize; attempt++) probe = Buffer.allocUnsafe(1);
  expect(probe.byteOffset).toBe(0);
}

interface Routed {
  segments: Uint8Array[];
  /** The buffer the gzip route took over, as it is after the call. */
  unpacked: Buffer;
  /** The bodies the reader finds in that buffer before the call. */
  bodiesBefore: Uint8Array[];
}

/**
 * Runs `streamToTar` on a gzip of `tar`. `place` puts the decoded bytes in the buffer the route will consume
 * (a pooled buffer, a window of a larger one); by default it is the buffer zlib returned.
 */
async function viaGzip(tar: Buffer, request: Policy = {}, place: (decoded: Buffer) => Buffer = (decoded) => decoded): Promise<Routed> {
  const gunzip = zlib.gunzip;
  let unpacked: Buffer = Buffer.alloc(0);
  let bodiesBefore: Uint8Array[] = [];
  const spy = vi.spyOn(zlib, 'gunzip').mockImplementation(((input: Buffer, options: object, callback: (error: Error | null, result: Buffer) => void) =>
    gunzip(input, options, (error, result) => {
      if (error) return callback(error, result);
      unpacked = place(result);
      bodiesBefore = classifyUnpacked(unpacked) === 'plain' ? [] : fileBodies(unpacked);
      return callback(null, unpacked);
    })) as never);
  try {
    const result = await streamToTar({ ...request, compressor: 'gzip', source: { buffer: zlib.gzipSync(tar) }, p7zBin: '', originalFilename: 'sample.tar.gz', timeoutMs: 10_000 });
    return { segments: result?.segments ?? [], unpacked, bodiesBefore };
  } finally {
    spy.mockRestore();
  }
}

async function expectLayoutChanged(tar: Buffer, request: Policy = KEEP_LAST_DUPLICATE): Promise<void> {
  const { unpacked, segments } = await viaGzip(tar, request);

  expect(segments.length).toBeGreaterThan(1);
  expect(Buffer.concat(segments).equals(referenceTarFromCopy(tar))).toBe(true);
  expect(unpacked.equals(tar)).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a tar that gzip, bzip2 or xz carries', () => {
  it('has new headers written over the old ones when every entry keeps its place, and nothing taken from the unpacked bytes is written back into them', async () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt', mode: 0o4755, magic: 'ustar ', version: ' \0', prefix: 'ignored' }, Buffer.from('first body')),
      hostileTarMember({ name: 'dir/', typeflag: '5' }),
      hostileTarMember({ name: 'empty.txt' }),
      hostileTarMember({ name: 'b.bin' }, Buffer.alloc(BODY_BYTES, 7)),
      hostileTarEnd(),
    ]);
    const expected = referenceTarFromCopy(tar);
    expect(expected.equals(tar)).toBe(false);
    const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as Uint8Array;
    const writes = vi.spyOn(typedArray, 'set');
    const copies = vi.spyOn(Buffer.prototype, 'copy');
    const moves = vi.spyOn(typedArray, 'copyWithin');

    const { unpacked, segments, bodiesBefore } = await viaGzip(tar);
    const sources = writes.mock.calls.map(([source]) => source as Uint8Array);

    expectBodiesToBeViewsOf(bodiesBefore, unpacked);
    expect(segments).toHaveLength(1);
    expect(segments[0].buffer).toBe(unpacked.buffer);
    expect(Buffer.concat(segments).equals(expected)).toBe(true);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter((source) => isWindowOf(source, unpacked))).toEqual([]);
    expect(copies.mock.contexts.filter((source) => isWindowOf(source as Uint8Array, unpacked))).toEqual([]);
    const bodyRanges = bodiesBefore.map((body) => rangeOf(body));
    const targets = writeTargets(writes, copies, moves);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((target) => bodyRanges.some((body) => overlap(target, body)))).toEqual([]);
    const bodyBytes = bodiesBefore.reduce((total, body) => total + body.length, 0);
    expect(bodyBytes).toBe('first body'.length + BODY_BYTES);
    expect(bytesWrittenInto(unpacked, writes, copies)).toBe(expected.length - bodyBytes);
  });

  it('writes zeros behind each body, whatever the old padding held', async () => {
    const first = hostileTarMember({ name: 'a.txt', mode: 0o4755, magic: 'ustar ', version: ' \0' }, Buffer.from('first body'));
    const second = hostileTarMember({ name: 'b.bin' }, Buffer.alloc(1500, 7));
    first.fill(JUNK_BYTE, BLOCK + 'first body'.length);
    second.fill(JUNK_BYTE, BLOCK + 1500);
    const tar = Buffer.concat([first, second, hostileTarEnd()]);
    const expected = referenceTarFromCopy(tar);
    expect(tar.includes(JUNK_BYTE)).toBe(true);
    expect(expected.includes(JUNK_BYTE)).toBe(false);

    const { unpacked, segments, bodiesBefore } = await viaGzip(tar);

    expectBodiesToBeViewsOf(bodiesBefore, unpacked);
    expect(segments).toHaveLength(1);
    expect(segments[0].buffer).toBe(unpacked.buffer);
    expect(Buffer.concat(segments).equals(expected)).toBe(true);
    expect(Buffer.concat(segments).includes(JUNK_BYTE)).toBe(false);
  });

  it('keeps the fast path when the unpacked bytes sit in a pooled buffer that the rewritten headers share', async () => {
    const canonical = referenceTarFromCopy(
      Buffer.concat([gnuLongName('n'.repeat(130)), hostileTarMember({ name: 'short' }, Buffer.from('body')), hostileTarEnd()])
    );
    startOfPoolSlab();

    const { unpacked, segments, bodiesBefore } = await viaGzip(canonical, {}, (decoded) => {
      const pooled = Buffer.allocUnsafe(decoded.length);
      decoded.copy(pooled);
      return pooled;
    });

    expect(unpacked.buffer.byteLength).toBe(Buffer.poolSize);
    expectBodiesToBeViewsOf(bodiesBefore, unpacked);
    const generated = tarFromEntries(readTarEntries(unpacked, { ignoreLinks: true })).filter((segment) => !bodiesBefore.includes(segment));
    expect(generated.some((segment) => segment.buffer === unpacked.buffer)).toBe(true);
    expect(segments).toHaveLength(1);
    expect(segments[0].buffer).toBe(unpacked.buffer);
    expect(Buffer.concat(segments).equals(canonical)).toBe(true);
  });

  it('leaves out what follows the end-of-archive blocks', async () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt' }, Buffer.from('visible')),
      hostileTarEnd(),
      hostileTarMember({ name: 'hidden.txt' }, Buffer.from('HIDDEN')),
      hostileTarEnd(),
    ]);

    const { segments } = await viaGzip(tar);

    const joined = Buffer.concat(segments);
    expect(joined.equals(referenceTarFromCopy(tar))).toBe(true);
    expect(joined.includes('HIDDEN')).toBe(false);
    expect(joined).toHaveLength(BLOCK + BLOCK + 2 * BLOCK);
  });

  it('gives the segments back, and writes nothing over the unpacked bytes, when a repeated name drops an entry', async () => {
    await expectLayoutChanged(
      Buffer.concat([
        hostileTarMember({ name: 'dup.txt' }, Buffer.from('first')),
        hostileTarMember({ name: 'keep.txt' }, Buffer.from('kept')),
        hostileTarMember({ name: 'dup.txt', magic: 'ustar ', version: ' \0' }, Buffer.from('second')),
        hostileTarEnd(),
      ])
    );
  });

  it('gives the segments back when a symbolic link is left out', async () => {
    await expectLayoutChanged(
      Buffer.concat([
        hostileTarMember({ name: 'a.txt' }, Buffer.from('body')),
        hostileTarMember({ name: 'link', typeflag: '2', linkname: 'a.txt' }),
        hostileTarMember({ name: 'b.txt' }, Buffer.from('other')),
        hostileTarEnd(),
      ]),
      SKIP_LINKS
    );
  });

  it('gives the segments back when a hard link between two entries is left out, because every later body moves up a block', async () => {
    await expectLayoutChanged(
      Buffer.concat([
        hostileTarMember({ name: 'a.txt' }, Buffer.from('body')),
        hostileTarMember({ name: 'hard', typeflag: '1', linkname: 'a.txt' }),
        hostileTarMember({ name: 'b.txt' }, Buffer.from('other')),
        hostileTarEnd(),
      ]),
      SKIP_LINKS
    );
  });

  it('keeps the fast path, and ends the tar early, when the hard link that is left out is the last entry', async () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt', magic: 'ustar ', version: ' \0' }, Buffer.from('body')),
      hostileTarMember({ name: 'b.txt' }, Buffer.from('other')),
      hostileTarMember({ name: 'hard', typeflag: '1', linkname: 'a.txt' }),
      hostileTarEnd(),
    ]);
    const expected = referenceTarFromCopy(tar);
    expect(expected.length).toBeLessThan(tar.length);

    const { unpacked, segments, bodiesBefore } = await viaGzip(tar, SKIP_LINKS);

    expectBodiesToBeViewsOf(bodiesBefore, unpacked);
    expect(segments).toHaveLength(1);
    expect(segments[0].buffer).toBe(unpacked.buffer);
    expect(segments[0].length).toBe(expected.length);
    expect(Buffer.concat(segments).equals(expected)).toBe(true);
  });

  it('gives the segments back when an entry is dropped for a name that sanitises to nothing', async () => {
    await expectLayoutChanged(
      Buffer.concat([
        hostileTarMember({ name: 'a.txt' }, Buffer.from('kept')),
        hostileTarMember({ name: '.' }, Buffer.alloc(1200, 9)),
        hostileTarMember({ name: 'b.txt' }, Buffer.from('also kept')),
        hostileTarEnd(),
      ])
    );
  });

  it('gives the expected tar, and leaves the unpacked bytes, when the tar ends before its end-of-archive blocks', async () => {
    const tar = hostileTarMember({ name: 'a.txt' }, Buffer.from('body'));
    expect(referenceTarFromCopy(tar).length).toBeGreaterThan(tar.length);

    const { unpacked, segments } = await viaGzip(tar);

    expect(Buffer.concat(segments).equals(referenceTarFromCopy(tar))).toBe(true);
    expect(unpacked.equals(tar)).toBe(true);
  });

  it('gives the segments back when a name over 100 characters grows the header block count', async () => {
    await expectLayoutChanged(
      Buffer.concat([
        hostileTarMember({ name: 'a.txt' }, Buffer.from('x')),
        gnuLongName('n'.repeat(GNU_LONG_NAME_BYTES)),
        hostileTarMember({ name: 'short' }, Buffer.from('y')),
        hostileTarEnd(),
      ])
    );
  });

  it('gives the segments back when a pax extended header is dropped and every body shifts', async () => {
    await expectLayoutChanged(
      Buffer.concat([
        hostileTarMember({ name: 'pax', typeflag: 'x' }, paxRecord('mtime', '1600000000')),
        hostileTarMember({ name: 'a.txt' }, Buffer.from('first body')),
        hostileTarMember({ name: 'b.txt' }, Buffer.from('second body')),
        hostileTarEnd(),
      ])
    );
  });

  it('writes into a window of a larger buffer at the window, not at the start of its memory', async () => {
    const tar = Buffer.concat([hostileTarMember({ name: 'a.txt', magic: 'ustar ', version: ' \0' }, Buffer.from('body')), hostileTarEnd()]);
    let frame = Buffer.alloc(0);

    const { segments, bodiesBefore, unpacked } = await viaGzip(tar, {}, (decoded) => {
      frame = Buffer.concat([Buffer.alloc(FRAME_HEAD, 0xaa), decoded, Buffer.alloc(FRAME_TAIL, 0xbb)]);
      return frame.subarray(FRAME_HEAD, FRAME_HEAD + decoded.length);
    });

    expectBodiesToBeViewsOf(bodiesBefore, unpacked);
    expect(Buffer.concat(segments).equals(referenceTarFromCopy(tar))).toBe(true);
    expect(frame.subarray(0, FRAME_HEAD).every((byte) => byte === 0xaa)).toBe(true);
    expect(frame.subarray(FRAME_HEAD + tar.length).every((byte) => byte === 0xbb)).toBe(true);
  });
});

describe('the bytes that follow the end-of-archive blocks', () => {
  const members = hostileTarMember({ name: 'a.txt', magic: 'ustar ', version: ' \0' }, Buffer.from('ab'));
  const expected = referenceTarFromCopy(Buffer.concat([members, hostileTarEnd()]));

  function tarWithTrailingZeros(count: number): Buffer {
    return Buffer.concat([members, hostileTarEnd(), Buffer.alloc(count)]);
  }

  it.each([
    ['padding to one record, as GNU tar and Python write it', TAR_RECORD_BYTES - expected.length],
    ['one record', TAR_RECORD_BYTES],
  ])('stay in the unpacked buffer, which is cut after the end blocks, when they are %s', async (_name, count) => {
    const { unpacked, segments } = await viaGzip(tarWithTrailingZeros(count));

    expect(unpacked.length - expected.length).toBe(count);
    expect(segments).toHaveLength(1);
    expect(segments[0].buffer).toBe(unpacked.buffer);
    expect(Buffer.concat(segments).equals(expected)).toBe(true);
  });

  it('are left out of the result, and the unpacked bytes are not written, when they are more than one record', async () => {
    const tar = tarWithTrailingZeros(TAR_RECORD_BYTES + 1);

    const { unpacked, segments } = await viaGzip(tar);

    expect(unpacked.length - expected.length).toBe(TAR_RECORD_BYTES + 1);
    expect(Buffer.concat(segments).equals(expected)).toBe(true);
    expect(unpacked.equals(tar)).toBe(true);
  });

  it('do not keep 30 MiB in memory behind the worker result', async () => {
    // The worker accepts the engine only when the path names a file, so a missing one cannot stand in; the gzip route
    // runs no child process, which the count of sandbox runs shows.
    vi.stubEnv('P7ZIP_PATH', process.execPath);
    sandboxFrames.started = 0;

    const result = await convertWithNative7z(zlib.gzipSync(tarWithTrailingZeros(30 * MIB)), 'gz', 'tar', {}, 'sample.tar.gz');

    expect(result?.engineUsed).toBe('native-7z');
    expect(sandboxFrames.started).toBe(0);
    expect(result?.buffer?.equals(expected)).toBe(true);
    // streamedArchiveResult joins the uncut segments with Buffer.concat, which may slice the pool slab but never keeps the 30 MiB.
    expect(result?.buffer?.buffer.byteLength).toBeLessThan(MIB);
  }, 60_000);
});

describe('the segments of a converted tar', () => {
  interface Branch {
    name: string;
    tar: Buffer;
    request: Policy;
    /** Whether the result is the tar cut out of the unpacked buffer. */
    cut: boolean;
    /** Taken when the cases are collected, before any test writes to a result. */
    expected: Buffer;
  }
  const branch = (name: string, tar: Buffer, request: Policy, cut: boolean): Branch => ({
    name,
    tar,
    request,
    cut,
    expected: referenceTarFromCopy(tar),
  });
  const inPlace = Buffer.concat([hostileTarMember({ name: 'a.txt', magic: 'ustar ', version: ' \0' }, Buffer.from('ab')), hostileTarEnd()]);
  const longTail = Buffer.alloc(TAR_RECORD_BYTES + 1);
  const dotOnly = hostileTarMember({ name: './', typeflag: '5' });
  const linkOnly = hostileTarMember({ name: 'link', typeflag: '2', linkname: 'a.txt' });
  const repeatedName = Buffer.concat([
    hostileTarMember({ name: 'dup.txt' }, Buffer.from('first')),
    hostileTarMember({ name: 'keep.txt' }, Buffer.from('kept')),
    hostileTarMember({ name: 'dup.txt' }, Buffer.from('second')),
    hostileTarEnd(),
  ]);
  const plain = Buffer.from('not a tar, only text\n'.repeat(30));
  const branches: Branch[] = [
    branch('every entry in place', inPlace, {}, true),
    branch('a repeated name that changes the layout', repeatedName, KEEP_LAST_DUPLICATE, false),
    branch('more than one record behind the end blocks', Buffer.concat([inPlace, longTail]), {}, false),
    branch('no end blocks', hostileTarMember({ name: 'a.txt' }, Buffer.from('ab')), {}, false),
    branch('only ./, with end blocks', Buffer.concat([dotOnly, hostileTarEnd()]), {}, true),
    branch('only ./, with a long tail', Buffer.concat([dotOnly, hostileTarEnd(), longTail]), {}, false),
    branch('only ./, without end blocks', dotOnly, {}, false),
    branch('only a left-out link, with end blocks', Buffer.concat([linkOnly, hostileTarEnd()]), SKIP_LINKS, true),
    branch('only a left-out link, with a long tail', Buffer.concat([linkOnly, hostileTarEnd(), longTail]), SKIP_LINKS, false),
    branch('only a left-out link, without end blocks', linkOnly, SKIP_LINKS, false),
    {
      name: 'a payload that is not a tar',
      tar: plain,
      request: {},
      cut: false,
      expected: Buffer.concat(wrapAsMember(memberNameFor('sample.tar.gz'), plain)),
    },
  ];

  it.each(branches)('are not shared with a later conversion, for $name', async ({ tar, request, cut, expected }) => {
    const first = await viaGzip(tar, request);
    expect(first.segments.length === 1 && isWindowOf(first.segments[0], first.unpacked)).toBe(cut);
    expect(Buffer.concat(first.segments).equals(expected)).toBe(true);
    for (const segment of first.segments) segment.fill(0xff);

    const second = await viaGzip(tar, request);

    expect(Buffer.concat(second.segments).equals(expected)).toBe(true);
  });
});

describe('a payload that 7-Zip carries out of its sandbox', () => {
  async function throughSandbox(payload: Buffer): Promise<{ segments: Uint8Array[]; frame: Buffer; headroom: number; tailroom: number }> {
    const xz = execFileSync(getOracleToolPath('xz') as string, ['-c'], { input: payload });
    sandboxFrames.runs.length = 0;
    const result = await streamToTar({
      compressor: 'xz',
      source: { buffer: xz },
      p7zBin: getOracleToolPath('7z') as string,
      originalFilename: 'sample.tar.xz',
      timeoutMs: 20_000,
    });
    expect(sandboxFrames.runs).toHaveLength(1);
    const [{ frame, headroom, tailroom }] = sandboxFrames.runs;
    expect(headroom).toBeGreaterThan(0);
    expect(tailroom).toBeGreaterThan(0);
    return { segments: result?.segments ?? [], frame, headroom, tailroom };
  }

  oracleTest('that is a tar is rewritten inside the frame, and the rooms around it stay as they were', ['7z', 'xz'], async () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt', mode: 0o4755, magic: 'ustar ', version: ' \0' }, Buffer.from('first body')),
      hostileTarMember({ name: 'b.bin' }, Buffer.alloc(1500, 7)),
      hostileTarEnd(),
    ]);

    const { segments, frame, headroom, tailroom } = await throughSandbox(tar);

    expect(segments).toHaveLength(1);
    const [segment] = segments;
    expect(segment.byteOffset).toBeGreaterThan(0);
    expect(segment.buffer.byteLength).toBeGreaterThan(segment.byteOffset + segment.length);
    expect(Buffer.from(segment).equals(referenceTarFromCopy(tar))).toBe(true);
    expect(segment.buffer).toBe(frame.buffer);
    expect(frame.subarray(0, headroom).every((byte) => byte === sandboxFrames.head)).toBe(true);
    expect(frame.subarray(frame.length - tailroom).every((byte) => byte === sandboxFrames.tail)).toBe(true);
  });

  oracleTest('that is not a tar is wrapped in the frame, with only the header and the zeros behind the body written into the rooms', ['7z', 'xz'], async () => {
    const payload = Buffer.from('not a tar, only text\n'.repeat(60));
    expect(payload.length % BLOCK).not.toBe(0);
    const expected = Buffer.concat(wrapAsMember(memberNameFor('sample.tar.xz'), payload));

    const { segments, frame, headroom, tailroom } = await throughSandbox(payload);

    expect(segments).toHaveLength(1);
    const [segment] = segments;
    expect(segment.buffer).toBe(frame.buffer);
    expect(segment.byteOffset).toBe(frame.byteOffset);
    expect(Buffer.from(segment).equals(expected)).toBe(true);
    const bodyEnd = headroom + payload.length;
    expect(frame.subarray(0, headroom).equals(expected.subarray(0, headroom))).toBe(true);
    expect(frame.subarray(headroom, bodyEnd).equals(payload)).toBe(true);
    expect(frame.subarray(bodyEnd, expected.length).every((byte) => byte === 0)).toBe(true);
    expect(frame.subarray(expected.length).every((byte) => byte === sandboxFrames.tail)).toBe(true);
    expect(frame.length - bodyEnd).toBe(tailroom);
  });
});
