import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressZstdNative, decompressZstdNative, nativeZstdZlib } from '../src/lib/conversions/zstd-native';
import { ConversionFailedError, CpuTaskAbortedError, DecompressionLimitError } from '../src/lib/types';
import { jsonRecords, sha256Hex, zipfText } from './helpers/archive-corpus';
import { oracleTest } from './helpers/oracle-test';
import { ARCHIVE_RATIO_FLOOR_BYTES } from '../src/lib/conversions/archive-extraction-safety';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildFrame, buildRleBombFrame, rawBlock } from './helpers/zstd-frames';

/**
 * The archive zstd engine is libzstd through node:zlib. Everything the product writes is read back by the reference CLI, and
 * everything the CLI writes (one frame, several frames, skippable frames, frames without a content size) is read by the
 * product. node:zlib's own decoder stops after the first frame, skips a leading skippable frame as the end of the input and
 * returns the prefix of a truncated frame without an error, so the cases that would pass silently are pinned here.
 */
const TOOLS = ['zstd'] as const;
const TEST_TIMEOUT_MS = 120_000;
const MIB = 1024 * 1024;
const DEFAULT_LEVEL = 3;
const SKIPPABLE_MAGIC = 0x184d2a50;
const SKIPPABLE_HEADER_BYTES = 8;
const MAX_UNCOMPRESSED_BYTES = 500 * MIB;
const FLOOR_BLOCKS_PLUS_ONE = 257;
const RATIO_BOMB_BYTES = 40 * MIB;

function zstdCli(args: string[], input: Buffer): Buffer {
  const bin = getOracleToolPath('zstd');
  if (bin === null) throw new Error('zstd is required');
  return execFileSync(bin, args, { input, maxBuffer: 1024 * MIB, stdio: ['pipe', 'pipe', 'ignore'] });
}

function skippableFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(SKIPPABLE_HEADER_BYTES);
  header.writeUInt32LE(SKIPPABLE_MAGIC, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function sample(): Buffer {
  return Buffer.concat([zipfText(900_000, 11), jsonRecords(600_000, 12)]);
}

/** What the zstd routes answer when the request is cancelled. */
const ABORT_MESSAGE = 'The zstd task was cancelled';

async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  return null;
}

describe('compressZstdNative', () => {
  oracleTest(
    'writes a frame the zstd CLI tests and decodes to the input, with the content checksum and the content size recorded',
    [...TOOLS],
    async () => {
      const input = sample();
      const frame = await compressZstdNative(input);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-native-'));
      try {
        const file = path.join(dir, 'out.zst');
        fs.writeFileSync(file, frame);
        const bin = getOracleToolPath('zstd') as string;
        execFileSync(bin, ['-t', file], { stdio: 'ignore' });
        expect(sha256Hex(zstdCli(['-d', '-c', '-q'], frame))).toBe(sha256Hex(input));
        const listing = execFileSync(bin, ['-lv', file], { encoding: 'utf8' });
        expect(listing).toMatch(/Check: XXH64/);
        expect(listing).toContain(`Decompressed Size: `);
        expect(listing).toContain(`(${input.length} B)`);
        expect(listing).toMatch(/# Zstandard Frames: 1\b/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'runs at the level the engine has always used: no larger than zstd -3 and clearly larger than zstd -9',
    [...TOOLS],
    async () => {
      const input = sample();
      const frame = await compressZstdNative(input);
      const level3 = zstdCli(['-3', '-c', '-q'], input).length;
      const level9 = zstdCli(['-9', '-c', '-q'], input).length;
      expect(frame.length).toBeLessThanOrEqual(level3);
      expect(frame.length).toBeGreaterThan(level9);
    },
    TEST_TIMEOUT_MS
  );

  it('asks libzstd for level 3, the checksum and the pledged content size', async () => {
    const spy = vi.spyOn(nativeZstdZlib(), 'zstdCompress');
    try {
      const input = Buffer.from('level pin '.repeat(2000));
      await compressZstdNative(input);
      expect(spy).toHaveBeenCalledTimes(1);
      const options = spy.mock.calls[0][1] as { params: Record<number, number>; pledgedSrcSize: number };
      expect(options.params[nativeZstdZlib().constants.ZSTD_c_compressionLevel]).toBe(DEFAULT_LEVEL);
      expect(options.params[nativeZstdZlib().constants.ZSTD_c_checksumFlag]).toBe(1);
      expect(options.pledgedSrcSize).toBe(input.length);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a level outside the zstd range instead of passing it on', async () => {
    for (const level of [0, 23]) {
      const error = await rejection(compressZstdNative(Buffer.from('x'), { level }));
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect((error as Error).message).toBe(`Unsupported zstd compression level ${level}: expected an integer from 1 to 19.`);
    }
  });

  oracleTest(
    'writes a frame for an empty input that the CLI reads back as nothing',
    [...TOOLS],
    async () => {
      const frame = await compressZstdNative(Buffer.alloc(0));
      expect(zstdCli(['-d', '-c', '-q'], frame)).toHaveLength(0);
      expect((await decompressZstdNative(frame)).length).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  it('stops with the abort error when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(compressZstdNative(sample(), { signal: controller.signal }));
    expect(error).toBeInstanceOf(CpuTaskAbortedError);
    expect((error as CpuTaskAbortedError).message).toBe(ABORT_MESSAGE);
  });

  it('stops while the native job runs when the signal fires', async () => {
    const controller = new AbortController();
    const pending = rejection(compressZstdNative(sample(), { level: 19, signal: controller.signal }));
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(CpuTaskAbortedError);
    expect((error as CpuTaskAbortedError).message).toBe(ABORT_MESSAGE);
  });
});

describe('decompressZstdNative', () => {
  oracleTest(
    'reads a frame the CLI wrote, with and without a recorded content size',
    [...TOOLS],
    async () => {
      const input = sample();
      const withSize = zstdCli(['-3', '-c', '-q', '--no-check'], input);
      expect(sha256Hex(await decompressZstdNative(withSize))).toBe(sha256Hex(input));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-native-'));
      try {
        // From a pipe the CLI does not know the size: the frame has no content size field.
        const streamed = zstdCli(['-3', '-c', '-q'], input);
        const file = path.join(dir, 'streamed.zst');
        fs.writeFileSync(file, streamed);
        expect(execFileSync(getOracleToolPath('zstd') as string, ['-lv', file], { encoding: 'utf8' })).not.toMatch(/Decompressed Size/);
        expect(sha256Hex(await decompressZstdNative(streamed))).toBe(sha256Hex(input));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'reads every frame of a multi-frame stream and skips skippable frames before, between and after them',
    [...TOOLS],
    async () => {
      const first = zipfText(300_000, 21);
      const second = jsonRecords(200_000, 22);
      const third = Buffer.from('tail');
      const frames = [first, second, third].map((part) => zstdCli(['-3', '-c', '-q'], part));
      const plain = Buffer.concat(frames);
      const withSkippable = Buffer.concat([
        skippableFrame(Buffer.from('metadata')),
        frames[0],
        skippableFrame(Buffer.alloc(0)),
        frames[1],
        frames[2],
        skippableFrame(Buffer.from('trailer')),
      ]);
      const expected = Buffer.concat([first, second, third]);
      expect(zstdCli(['-d', '-c', '-q'], withSkippable).equals(expected)).toBe(true);
      expect((await decompressZstdNative(plain)).equals(expected)).toBe(true);
      expect((await decompressZstdNative(withSkippable)).equals(expected)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it('reads a stream of nothing but skippable frames as empty, as the CLI does', async () => {
    expect((await decompressZstdNative(skippableFrame(Buffer.from('only metadata')))).length).toBe(0);
  });

  oracleTest(
    'refuses a truncated frame, a flipped checksum and bytes after the last frame',
    [...TOOLS],
    async () => {
      const frame = zstdCli(['-3', '-c', '-q'], sample());
      const flipped = Buffer.from(frame);
      flipped[flipped.length - 1] ^= 0xff;
      const truncated = /^Malformed Zstandard (?:compressed |raw |RLE )?(?:block|frame): (?:truncated|missing content checksum)/;
      const cases: Array<[string, Buffer, RegExp]> = [
        ['truncated by six bytes', frame.subarray(0, frame.length - 6), truncated],
        ['truncated to the first block', frame.subarray(0, 200), truncated],
        ['truncated in the second of two frames', Buffer.concat([frame, frame.subarray(0, frame.length - 6)]), truncated],
        ['flipped checksum', flipped, /^Malformed Zstandard frame: .*checksum/],
        ['three bytes after the frame', Buffer.concat([frame, Buffer.from([1, 2, 3])]), /^Malformed Zstandard stream: trailing bytes after the last frame\.$/],
        ['eight garbage bytes after the frame', Buffer.concat([frame, Buffer.alloc(8, 7)]), /^Invalid Zstandard magic signature: 0x7070707 at offset \d+$/],
        ['not a frame', Buffer.from('this is not a zstd stream at all'), /^Invalid Zstandard magic signature: 0x73696874 at offset 0$/],
      ];
      for (const [name, input, message] of cases) {
        const error = await rejection(decompressZstdNative(input));
        expect(error, name).toBeInstanceOf(ConversionFailedError);
        expect((error as Error).message, name).toMatch(message);
      }
    },
    TEST_TIMEOUT_MS
  );

  it('refuses a frame that names a dictionary, with the message the pure decoder gives', async () => {
    const frame = buildFrame([rawBlock(Buffer.from('payload'))], { singleSegment: true, contentSize: 7, dictionaryId: 42 });
    const error = await rejection(decompressZstdNative(frame));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).message).toMatch(/requires dictionary 42/);
  });

  it('refuses a window beyond the decoder limit before decoding anything', async () => {
    const frame = buildFrame([rawBlock(Buffer.from('payload'))], { windowLog: 28 });
    const error = await rejection(decompressZstdNative(frame));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).message).toMatch(/window size/);
  });

  it('refuses a content size that the frame does not decode to', async () => {
    const frame = buildFrame([rawBlock(Buffer.from('payload'))], { singleSegment: true, contentSize: 9 });
    const error = await rejection(decompressZstdNative(frame));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).message).toMatch(/content size|Malformed Zstandard frame/);
  });

  it('refuses a ratio bomb with the archive bomb error, with and without a declared size', async () => {
    const withoutSize = await rejection(decompressZstdNative(buildRleBombFrame(FLOOR_BLOCKS_PLUS_ONE)));
    expect(withoutSize).toBeInstanceOf(DecompressionLimitError);
    expect((withoutSize as Error).message).toMatch(/Archive bomb detected: compression ratio/);
    const declared = buildFrame([rawBlock(Buffer.alloc(0))], { windowLog: 17, contentSize: 200 * MIB });
    const withSize = await rejection(decompressZstdNative(declared));
    expect(withSize).toBeInstanceOf(DecompressionLimitError);
    expect((withSize as Error).message).toMatch(/Archive bomb detected: compression ratio/);
  });

  it('refuses a declared size above the absolute cap, at any ratio', async () => {
    const frame = buildFrame([rawBlock(Buffer.alloc(0))], { windowLog: 17, contentSize: 600 * MIB });
    const error = await rejection(decompressZstdNative(frame));
    expect(error).toBeInstanceOf(DecompressionLimitError);
    expect((error as Error).message).toContain(`uncompressed size exceeds limit of ${MAX_UNCOMPRESSED_BYTES} bytes`);
  });

  oracleTest(
    'refuses a bomb whose frame carries no size, which only the output bound can stop',
    [...TOOLS],
    async () => {
      const bomb = zstdCli(['-1', '-c', '-q'], Buffer.alloc(RATIO_BOMB_BYTES));
      expect(bomb.length * 100).toBeLessThan(RATIO_BOMB_BYTES);
      const decode = vi.spyOn(nativeZstdZlib(), 'zstdDecompress');
      try {
        const error = await rejection(decompressZstdNative(bomb));
        expect(error).toBeInstanceOf(DecompressionLimitError);
        expect((error as Error).message).toMatch(/Archive bomb detected/);
        // libzstd is told to stop at the ratio floor, so the bomb is never held in memory whole.
        expect(decode).toHaveBeenCalledTimes(1);
        expect((decode.mock.calls[0][1] as { maxOutputLength: number }).maxOutputLength).toBe(ARCHIVE_RATIO_FLOOR_BYTES);
      } finally {
        decode.mockRestore();
      }
    },
    TEST_TIMEOUT_MS
  );

  it('stops with the abort error when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const frame = await compressZstdNative(Buffer.from('abort me '.repeat(1000)));
    const error = await rejection(decompressZstdNative(frame, { signal: controller.signal }));
    expect(error).toBeInstanceOf(CpuTaskAbortedError);
    expect((error as CpuTaskAbortedError).message).toBe(ABORT_MESSAGE);
  });
});
