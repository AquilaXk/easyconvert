import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTarArchive, inspectArchive } from '../src/lib/conversions/archive';
import { DecompressionLimitError } from '../src/lib/types';
import { nativeZstdZlib } from '../src/lib/conversions/zstd-native';
import { executeWorkerConversion } from '../src/worker/engines';
import { jsonRecords, sha256Hex, zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * tar to zst and zst to tar run libzstd through node:zlib. The outputs are read by the zstd CLI and by the system tar, the
 * inputs are written by the CLI (several frames, skippable frames, no content size), and the bomb guards still stop what they
 * stopped before.
 */
const TOOLS = ['zstd', 'tar'] as const;
const TEST_TIMEOUT_MS = 120_000;
const MIB = 1024 * 1024;
const SKIPPABLE_MAGIC = 0x184d2a50;
const SKIPPABLE_HEADER_BYTES = 8;
const BOMB_BYTES = 40 * MIB;

afterEach(() => {
  vi.restoreAllMocks();
});

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

function withTempFile<T>(name: string, data: Buffer, action: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-zstd-native-'));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return action(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tarMembers(tar: Buffer): Map<string, string> {
  return withTempFile('result.tar', tar, (file) => {
    const members = new Map<string, string>();
    const names = execFileSync('tar', ['-tf', file], { encoding: 'utf8' }).split('\n').filter((name) => name !== '' && !name.endsWith('/'));
    for (const name of names) members.set(name, sha256Hex(execFileSync('tar', ['-xOf', file, name], { maxBuffer: 256 * MIB })));
    return members;
  });
}

const MEMBERS = [
  { filename: 'docs/readme.txt', buffer: zipfText(700_000, 31) },
  { filename: 'docs/records.jsonl', buffer: jsonRecords(500_000, 32) },
];

describe('tar to zst through libzstd', () => {
  oracleTest(
    'writes a frame the zstd CLI tests, whose tar the system tar lists with every member intact, and calls libzstd once',
    [...TOOLS],
    async () => {
      const tar = createTarArchive(MEMBERS).buffer;
      const compress = vi.spyOn(nativeZstdZlib(), 'zstdCompress');
      const result = await executeWorkerConversion(tar, 'tar', 'zst', {}, 'bundle.tar');
      expect(compress).toHaveBeenCalledTimes(1);
      const frame = result.buffer as Buffer;
      withTempFile('out.zst', frame, (file) => {
        execFileSync(getOracleToolPath('zstd') as string, ['-t', file], { stdio: 'ignore' });
        expect(execFileSync(getOracleToolPath('zstd') as string, ['-lv', file], { encoding: 'utf8' })).toMatch(/Check: XXH64/);
      });
      const members = tarMembers(zstdCli(['-d', '-c', '-q'], frame));
      for (const member of MEMBERS) expect(members.get(member.filename), member.filename).toBe(sha256Hex(member.buffer));
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'tar.zst is the same engine, and a frame is no larger than zstd -3 writes for the same tar',
    [...TOOLS],
    async () => {
      const tar = createTarArchive(MEMBERS).buffer;
      const compress = vi.spyOn(nativeZstdZlib(), 'zstdCompress');
      const result = await executeWorkerConversion(tar, 'tar', 'tar.zst', {}, 'bundle.tar');
      expect(compress).toHaveBeenCalledTimes(1);
      const frame = result.buffer as Buffer;
      const unpacked = zstdCli(['-d', '-c', '-q'], frame);
      for (const member of MEMBERS) expect(tarMembers(unpacked).get(member.filename), member.filename).toBe(sha256Hex(member.buffer));
      expect(frame.length).toBeLessThanOrEqual(zstdCli(['-3', '-c', '-q'], unpacked).length);
    },
    TEST_TIMEOUT_MS
  );
});

describe('zst to tar through libzstd', () => {
  oracleTest(
    'reads frames the CLI wrote, several of them with skippable frames among them, as one payload',
    [...TOOLS],
    async () => {
      const first = zipfText(400_000, 41);
      const second = jsonRecords(300_000, 42);
      const stream = Buffer.concat([
        skippableFrame(Buffer.from('written by a tool that adds metadata')),
        zstdCli(['-3', '-c', '-q'], first),
        skippableFrame(Buffer.alloc(0)),
        zstdCli(['-3', '-c', '-q'], second),
      ]);
      const decompress = vi.spyOn(nativeZstdZlib(), 'zstdDecompress');
      const result = await executeWorkerConversion(stream, 'zst', 'tar', {}, 'sample.txt.zst');
      expect(decompress).toHaveBeenCalled();
      const members = tarMembers(result.buffer as Buffer);
      expect([...members.values()]).toEqual([sha256Hex(Buffer.concat([first, second]))]);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'reads a tar.zst the CLI wrote from a pipe, where the frame has no content size, and lists it',
    [...TOOLS],
    async () => {
      const tar = createTarArchive(MEMBERS).buffer;
      const stream = zstdCli(['-3', '-c', '-q'], tar);
      const result = await executeWorkerConversion(stream, 'tar.zst', 'tar', {}, 'bundle.tar.zst');
      const members = tarMembers(result.buffer as Buffer);
      for (const member of MEMBERS) expect(members.get(member.filename), member.filename).toBe(sha256Hex(member.buffer));
      const listing = await inspectArchive(stream, { filename: 'bundle.tar.zst' });
      expect(listing.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(MEMBERS.map((member) => member.filename)));
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'refuses a ratio bomb that carries no size with the archive bomb error, to a tar and to a zip',
    [...TOOLS],
    async () => {
      const bomb = zstdCli(['-1', '-c', '-q'], Buffer.alloc(BOMB_BYTES));
      for (const target of ['tar', 'zip']) {
        const error = await executeWorkerConversion(bomb, 'zst', target, {}, 'bomb.zst').then(
          () => null,
          (thrown: unknown) => thrown
        );
        expect(error, target).toBeInstanceOf(DecompressionLimitError);
        expect((error as Error).message, target).toMatch(/Archive bomb detected/);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'refuses a truncated stream rather than converting its prefix',
    [...TOOLS],
    async () => {
      const frame = zstdCli(['-3', '-c', '-q'], zipfText(800_000, 43));
      const error = await executeWorkerConversion(frame.subarray(0, frame.length - 6), 'zst', 'tar', {}, 'cut.zst').then(
        () => null,
        (thrown: unknown) => thrown
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('ConversionFailedError');
    },
    TEST_TIMEOUT_MS
  );
});
