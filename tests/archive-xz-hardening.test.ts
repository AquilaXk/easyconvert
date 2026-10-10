import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertArchive, decompressXz, unpackXz } from '../src/lib/conversions/archive';
import {
  CorruptStreamError,
  DecompressionLimitError,
  UnsupportedArchiveMethodError,
} from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { expectNoHangOnInput } from './helpers/timing';
import { zipCrc32 } from './helpers/zip-craft';

/**
 * .xz decoding follows the file format specification (version 1.2.0) and is judged by `xz` itself: every stream is
 * written by the `xz` command line, decoded again by `xz -dc`, and the in-process reader must return the same bytes
 * (compared by SHA-256). Damaged streams are compared with `xz -t`: where the reference refuses a stream, the reader
 * must refuse it with a typed error, never return other bytes and never hang.
 */

const TIMEOUT_MS = 180_000;
const MIB = 1024 * 1024;
const XZ_TOOLS = ['xz'] as const;

let workDir = '';
let sample: Buffer = Buffer.alloc(0);
let machineCode: Buffer = Buffer.alloc(0);

function xzPath(): string {
  return getOracleToolPath('xz') as string;
}

/** Deterministic x86-like bytes: CALL/JMP opcodes with 32-bit displacements, the pattern the branch filters rewrite. */
function pseudoX86(length: number): Buffer {
  const out = Buffer.alloc(length);
  let state = 0x2545f491;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  let at = 0;
  while (at < length) {
    const roll = next() % 5;
    if (roll < 2 && at + 5 <= length) {
      out[at] = roll === 0 ? 0xe8 : 0xe9;
      out.writeInt32LE((next() % 20_000) - 10_000, at + 1);
      at += 5;
    } else {
      out[at] = next() & 0xff;
      at += 1;
    }
  }
  return out;
}

function readPrefix(file: string, length: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const out = Buffer.alloc(length);
    fs.readSync(fd, out, 0, length, 0);
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xz-hardening-'));
  const text = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(4000));
  const random = crypto.randomBytes(120_000);
  const binary = readPrefix(process.execPath, 300_000);
  sample = Buffer.concat([text, random, binary, text.subarray(0, 50_000)]);
  machineCode = pseudoX86(400_000);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Raised when the installed xz is too old for an option (--arm64 needs 5.4, --riscv 5.6): oracleTest turns it into a skip. */
class XzOptionUnavailableError extends Error {
  readonly isOracleSkip = true;
}

function encode(input: Buffer, args: string[]): Buffer {
  const run = spawnSync(xzPath(), ['-c', ...args], { input, maxBuffer: 256 * MIB });
  if (run.status === 0) return run.stdout;
  const message = run.stderr?.toString() ?? '';
  if (/unrecognized option|try 'xz --help'|unsupported filter|invalid filter/i.test(message)) {
    throw new XzOptionUnavailableError(`xz does not support ${args.join(' ')}: ${message.trim()}`);
  }
  throw new Error(`xz ${args.join(' ')} failed: ${message.trim()}`);
}

function referenceDecode(stream: Buffer): Buffer {
  return execFileSync(xzPath(), ['-dc', '-q'], { input: stream, maxBuffer: 256 * MIB });
}

function referenceAccepts(stream: Buffer): boolean {
  return spawnSync(xzPath(), ['-t', '-q'], { input: stream }).status === 0;
}

function attempt(run: () => Buffer): { ok: true; value: Buffer } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number }).status;
}

describe('every check type and block layout decodes like xz -dc', () => {
  const layouts: Array<[string, string[]]> = [
    ['CRC-32, one block', ['-C', 'crc32']],
    ['no check', ['-C', 'none']],
    ['CRC-64 in 64 KiB blocks (-T0)', ['-T0', '--block-size=64KiB', '-C', 'crc64']],
    ['SHA-256 in 100 KiB blocks', ['--block-size=100KiB', '-C', 'sha256']],
    ['CRC-64 in blocks of four threads', ['-T4', '--block-size=50KiB', '-C', 'crc64', '-1']],
  ];
  for (const [label, args] of layouts) {
    oracleTest(
      label,
      [...XZ_TOOLS],
      () => {
        const stream = encode(sample, args);
        expect(referenceAccepts(stream)).toBe(true);
        expect(sha256(unpackXz(stream))).toBe(sha256(sample));
        expect(sha256(decompressXz(stream))).toBe(sha256(referenceDecode(stream)));
      },
      TIMEOUT_MS
    );
  }

  oracleTest(
    'concatenated streams and stream padding between and after them',
    [...XZ_TOOLS],
    () => {
      const first = encode(sample, ['-C', 'crc32']);
      const second = encode(machineCode, ['-T0', '--block-size=64KiB', '-C', 'crc64']);
      const third = encode(sample.subarray(0, 1000), ['-C', 'sha256']);
      const stream = Buffer.concat([first, Buffer.alloc(8), second, Buffer.alloc(4), third, Buffer.alloc(12)]);
      expect(referenceAccepts(stream)).toBe(true);
      const expected = referenceDecode(stream);
      expect(expected.length).toBe(sample.length + machineCode.length + 1000);
      expect(sha256(unpackXz(stream))).toBe(sha256(expected));
      expect(sha256(decompressXz(stream))).toBe(sha256(expected));
    },
    TIMEOUT_MS
  );
});

describe('branch and delta filters are decoded like xz -dc', () => {
  const filters: Array<[string, string[]]> = [
    ['x86', ['--x86']],
    ['x86 with a start offset', ['--x86=start=4096']],
    ['PowerPC', ['--powerpc']],
    ['IA-64', ['--ia64']],
    ['ARM', ['--arm']],
    ['ARM Thumb', ['--armthumb']],
    ['ARM64', ['--arm64']],
    ['SPARC', ['--sparc']],
    ['Delta distance 1', ['--delta=dist=1']],
    ['Delta distance 4', ['--delta=dist=4']],
    ['Delta distance 256', ['--delta=dist=256']],
    ['Delta then x86', ['--delta=dist=2', '--x86']],
    ['x86 then Delta in several blocks', ['--x86', '--delta=dist=3']],
  ];
  for (const [label, chain] of filters) {
    oracleTest(
      label,
      [...XZ_TOOLS],
      () => {
        const input = label.includes('several blocks') ? Buffer.concat([machineCode, sample]) : machineCode;
        const args = [...chain, '--lzma2=preset=1', ...(label.includes('several blocks') ? ['--block-size=64KiB', '-C', 'crc64'] : [])];
        const stream = encode(input, args);
        expect(referenceAccepts(stream)).toBe(true);
        expect(stream.length).toBeGreaterThan(0);
        const expected = referenceDecode(stream);
        expect(sha256(expected)).toBe(sha256(input));
        expect(sha256(unpackXz(stream))).toBe(sha256(expected));
        expect(sha256(decompressXz(stream))).toBe(sha256(expected));
      },
      TIMEOUT_MS
    );
  }

  oracleTest(
    'a filter this reader does not decode (RISC-V) answers 422 instead of returning undecoded bytes',
    [...XZ_TOOLS],
    () => {
      const stream = encode(machineCode, ['--riscv', '--lzma2=preset=1']);
      const outcome = attempt(() => unpackXz(stream));
      expect(outcome.ok).toBe(false);
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(UnsupportedArchiveMethodError);
      expect(statusOf(error)).toBe(422);
    }
  );
});

/** Rewrites a 4-byte little-endian CRC-32 that covers `[from, to)` of `stream`. */
function refreshCrc(stream: Buffer, from: number, to: number, at: number): void {
  stream.writeUInt32LE(zipCrc32(stream.subarray(from, to)), at);
}

describe('damaged streams are refused with a typed error, in step with xz -t', () => {
  oracleTest(
    'a stream cut at any point is malformed',
    [...XZ_TOOLS],
    async () => {
      const stream = encode(sample.subarray(0, 200_000), ['-T0', '--block-size=64KiB', '-C', 'crc64']);
      const cuts = [0, 5, 11, 12, 20, 40, 1000, Math.floor(stream.length / 2), stream.length - 40, stream.length - 24, stream.length - 13, stream.length - 12, stream.length - 1];
      for (const cut of cuts) {
        const truncated = stream.subarray(0, cut);
        expect(referenceAccepts(truncated), `reference accepts a stream cut at ${cut}`).toBe(false);
        const { largeResult } = await expectNoHangOnInput(`cut at ${cut}`, (input: Buffer) => attempt(() => unpackXz(input)), truncated);
        expect(largeResult.ok, `cut at ${cut}`).toBe(false);
        expect((largeResult as { error: unknown }).error, `cut at ${cut}`).toBeInstanceOf(CorruptStreamError);
      }
    },
    TIMEOUT_MS
  );

  oracleTest(
    'a flipped bit anywhere is refused when xz -t refuses it, and otherwise decodes to the same bytes',
    [...XZ_TOOLS],
    async () => {
      const original = sample.subarray(0, 60_000);
      const stream = encode(original, ['--block-size=20KiB', '-C', 'crc64', '-1']);
      const expected = sha256(original);
      let refused = 0;
      for (let step = 0; step < 60; step++) {
        const position = Math.floor(((step + 0.5) * stream.length) / 60);
        const damaged = Buffer.from(stream);
        damaged[position] ^= 1 << (step % 8);
        const outcome = await expectNoHangOnInput(`bit flip at ${position}`, (input: Buffer) => attempt(() => unpackXz(input)), damaged);
        if (referenceAccepts(damaged)) {
          expect(outcome.largeResult.ok, `reference accepts the flip at ${position}`).toBe(true);
          expect(sha256((outcome.largeResult as { value: Buffer }).value), `flip at ${position}`).toBe(expected);
        } else {
          refused++;
          expect(outcome.largeResult.ok, `reference refuses the flip at ${position}`).toBe(false);
          const error = (outcome.largeResult as { error: unknown }).error;
          expect(error, `flip at ${position}: ${String(error)}`).toBeInstanceOf(CorruptStreamError);
        }
      }
      expect(refused).toBeGreaterThan(50);
    },
    TIMEOUT_MS
  );

  oracleTest(
    'garbage after the last stream is refused',
    [...XZ_TOOLS],
    () => {
      const stream = Buffer.concat([encode(sample.subarray(0, 5000), ['-C', 'crc32']), Buffer.from('trailing bytes')]);
      expect(referenceAccepts(stream)).toBe(false);
      const outcome = attempt(() => unpackXz(stream));
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: unknown }).error).toBeInstanceOf(CorruptStreamError);
    }
  );

  oracleTest(
    'a reserved check type is a 422, not a stream that is read without its check',
    [...XZ_TOOLS],
    () => {
      const stream = encode(sample.subarray(0, 5000), ['-C', 'crc32']);
      const patched = Buffer.from(stream);
      patched[7] = 0x02;
      refreshCrc(patched, 6, 8, 8);
      patched[patched.length - 3] = 0x02;
      refreshCrc(patched, patched.length - 8, patched.length - 2, patched.length - 12);
      const outcome = attempt(() => unpackXz(patched));
      expect(outcome.ok).toBe(false);
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(UnsupportedArchiveMethodError);
      expect(statusOf(error)).toBe(422);
    }
  );

  oracleTest(
    'an LZMA2 dictionary size byte above 40 is malformed',
    [...XZ_TOOLS],
    () => {
      const stream = encode(sample.subarray(0, 5000), ['-C', 'crc32']);
      const patched = Buffer.from(stream);
      const headerSize = (patched[12] + 1) * 4;
      // The dictionary byte is the LZMA2 filter's single property.
      const dictAt = patched.indexOf(Buffer.from([0x21, 0x01]), 12) + 2;
      patched[dictAt] = 41;
      refreshCrc(patched, 12, 12 + headerSize - 4, 12 + headerSize - 4);
      expect(referenceAccepts(patched)).toBe(false);
      const outcome = attempt(() => unpackXz(patched));
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: unknown }).error).toBeInstanceOf(CorruptStreamError);
    }
  );
});

describe('a decompression bomb is a 413 and stops early', () => {
  oracleTest(
    '600 MiB of zeros made by xz -9',
    [...XZ_TOOLS],
    async () => {
      const zeros = path.join(workDir, 'zeros.bin');
      execFileSync('head', ['-c', String(600 * MIB), '/dev/zero'], { stdio: ['ignore', fs.openSync(zeros, 'w'), 'inherit'] });
      const stream = execFileSync(xzPath(), ['-9', '-c', '-q', '-T0', zeros], { maxBuffer: 64 * MIB });
      fs.rmSync(zeros);
      expect(referenceAccepts(stream)).toBe(true);
      for (const [label, run] of [
        ['in-process reader', (input: Buffer) => attempt(() => unpackXz(input))],
        ['decompressXz', (input: Buffer) => attempt(() => decompressXz(input))],
      ] as const) {
        const { largeResult } = await expectNoHangOnInput(label, run, stream, 60_000);
        expect(largeResult.ok, label).toBe(false);
        const error = (largeResult as { error: unknown }).error;
        expect(error, label).toBeInstanceOf(DecompressionLimitError);
        expect(statusOf(error), label).toBe(413);
      }
      const converted = await attempt2(() => convertArchive(stream, 'xz', 'tar', {}, 'zeros.xz'));
      expect(converted).toBeInstanceOf(DecompressionLimitError);
      expect(statusOf(converted)).toBe(413);
    },
    TIMEOUT_MS
  );

  it('a damaged stream keeps its 400 through the conversion entry point', async () => {
    const stream = Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.alloc(40, 7)]);
    const error = await attempt2(() => convertArchive(stream, 'xz', 'tar', {}, 'broken.xz'));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect(statusOf(error)).toBe(400);
  });
});

async function attempt2(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('the stream was accepted');
}
