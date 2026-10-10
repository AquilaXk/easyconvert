import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { extract7zArchive, extract7zArchiveAsync } from '../src/lib/conversions/archive';
import { AesKeyCache, SEVENZIP_MAX_KDF_TOTAL_ROUNDS } from '../src/lib/conversions/archive-sevenzip-aes';
import { InvalidArchivePasswordError, UnsupportedArchiveMethodError } from '../src/lib/types';
import { EVENT_LOOP_BLOCK_BUDGET_MS, shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { craftFolderArchive } from './helpers/seven-zip-folders';

/**
 * The key derivation of an encrypted 7z is the one piece of work an archive can multiply: a non-solid archive repeats
 * the AES coder for every file. The key is derived once per salt for the whole archive, all distinct keys share a
 * budget of rounds that is charged before any hashing, and a large derivation runs on a pool thread so the event loop
 * keeps turning. Reference timings come from `7z t` on the same archive.
 */
const TEST_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 60_000;
const PASSWORD = 'pw-for-the-work-tests';
const ID_AES = [0x06, 0xf1, 0x07, 0x01];
const FILE_COUNT = 200;
const FILE_BYTES = 8192;
const HTTP_UNPROCESSABLE = 422;
const LOOP_TICK_MS = 5;
/** Our read may take this many times as long as `7z t` of the same archive (which includes starting the process). */
const REFERENCE_FACTOR = 20;
const FLOOR_MS = 250;

let workDir = '';

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-zip-aes-work-'));
});

afterAll(async () => {
  await shutdownCpuPool();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function failureOf(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** The longest stretch the event loop went without running a 5 ms timer while `run` was in progress. */
async function maxLoopDelayDuring<T>(run: () => Promise<T>): Promise<{ value: T; maxDelayMs: number; elapsedMs: number }> {
  let last = performance.now();
  let maxDelayMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxDelayMs = Math.max(maxDelayMs, now - last - LOOP_TICK_MS);
    last = now;
  }, LOOP_TICK_MS);
  const started = performance.now();
  try {
    const value = await run();
    return { value, maxDelayMs, elapsedMs: performance.now() - started };
  } finally {
    clearInterval(timer);
  }
}

/** The AES coder properties: a salt of `salt.length` bytes (1-16) and a one-byte IV. */
function aesProperties(cyclesPower: number, salt: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xc0 | cyclesPower, ((salt.length - 1) << 4) | 0x00]), salt, Buffer.alloc(1, 0xa5)]);
}

/** A folder per salt, each holding 16 bytes no key opens: only the CRC can tell, so decryption never succeeds. */
function distinctSaltArchive(salts: Buffer[], cyclesPower: number): Buffer {
  return craftFolderArchive(
    salts.map((salt, index) => ({
      name: `locked${index}.bin`,
      coders: [{ id: ID_AES, properties: aesProperties(cyclesPower, salt) }],
      bindPairs: [],
      packStreams: [Buffer.alloc(16, 0x42)],
      outSizes: [16],
      crc: 0x12345678,
    }))
  );
}

function distinctSalts(count: number): Buffer[] {
  return Array.from({ length: count }, (_, index) => {
    const salt = Buffer.alloc(4);
    salt.writeUInt32LE(index + 1, 0);
    return salt;
  });
}

describe('one key per salt for the whole archive', () => {
  oracleTest(
    `${FILE_COUNT} non-solid files with an encrypted header read in the time of 7z t, in process and off the loop`,
    ['7z'],
    async () => {
      const sevenZip = requireOracleTool('7z');
      const source = path.join(workDir, 'source');
      fs.mkdirSync(source);
      const hashes = new Map<string, string>();
      for (let index = 0; index < FILE_COUNT; index += 1) {
        const bytes = crypto.randomBytes(FILE_BYTES);
        fs.writeFileSync(path.join(source, `f${index}.bin`), bytes);
        hashes.set(`f${index}.bin`, crypto.createHash('sha256').update(bytes).digest('hex'));
      }
      const archivePath = path.join(workDir, 'many.7z');
      execFileSync(sevenZip, ['a', '-t7z', '-y', `-p${PASSWORD}`, '-ms=off', '-mhe=on', archivePath, '.'], { cwd: source, timeout: COMMAND_TIMEOUT_MS, stdio: 'pipe' });
      const archive = fs.readFileSync(archivePath);

      const referenceStarted = performance.now();
      execFileSync(sevenZip, ['t', `-p${PASSWORD}`, archivePath], { timeout: COMMAND_TIMEOUT_MS, stdio: 'pipe' });
      const referenceMs = performance.now() - referenceStarted;
      const bound = Math.max(FLOOR_MS, REFERENCE_FACTOR * referenceMs);

      const syncStarted = performance.now();
      const viaSync = extract7zArchive(archive, { password: PASSWORD });
      const syncMs = performance.now() - syncStarted;
      const asyncRun = await maxLoopDelayDuring(() => extract7zArchiveAsync(archive, { password: PASSWORD }));

      for (const files of [viaSync, asyncRun.value]) {
        expect(files.map((file) => file.filename).sort()).toEqual([...hashes.keys()].sort());
        for (const file of files) expect(crypto.createHash('sha256').update(file.buffer).digest('hex')).toBe(hashes.get(file.filename));
      }
      expect(syncMs, `sync ${syncMs.toFixed(0)} ms, 7z t ${referenceMs.toFixed(0)} ms`).toBeLessThan(bound);
      expect(asyncRun.elapsedMs, `async ${asyncRun.elapsedMs.toFixed(0)} ms, 7z t ${referenceMs.toFixed(0)} ms`).toBeLessThan(bound);
    },
    TEST_TIMEOUT_MS
  );

  it('derives a key once and hands the same key to every later request for it', () => {
    const cache = new AesKeyCache(PASSWORD);
    const request = { cyclesPower: 20, salt: Buffer.from([1, 2, 3, 4]) };
    const started = performance.now();
    const first = cache.keyFor(request);
    for (let index = 0; index < 200; index += 1) expect(cache.keyFor({ ...request, salt: Buffer.from(request.salt) })).toBe(first);
    // 201 derivations of 2^20 rounds would take seconds; one takes about 25 ms.
    expect(performance.now() - started).toBeLessThan(1500);
    expect(cache.keyFor({ cyclesPower: 20, salt: Buffer.from([1, 2, 3, 5]) })).not.toBe(first);
    expect(cache.keyFor({ cyclesPower: 19, salt: request.salt })).not.toBe(first);
  });
});

describe('the rounds of all keys of an archive share one budget', () => {
  it('refuses the key that passes the budget, typed 422, on the calling thread', () => {
    const cache = new AesKeyCache(PASSWORD);
    const power = 22;
    const keysInBudget = SEVENZIP_MAX_KDF_TOTAL_ROUNDS / 2 ** power;
    distinctSalts(keysInBudget).forEach((salt) => cache.keyFor({ cyclesPower: power, salt }));
    const failure = failureOf(() => cache.keyFor({ cyclesPower: power, salt: Buffer.from([9, 9, 9, 9]) }));
    expect(failure).toBeInstanceOf(UnsupportedArchiveMethodError);
    expect((failure as UnsupportedArchiveMethodError).status).toBe(HTTP_UNPROCESSABLE);
    expect((failure as Error).message).toMatch(/more than 2\^26 rounds of key derivation in total/);
  });

  it('refuses 64 folders with distinct salts at the top power before hashing anything, without stalling the loop', async () => {
    const archive = distinctSaltArchive(distinctSalts(64), 24);
    const { value, maxDelayMs, elapsedMs } = await maxLoopDelayDuring(() => rejectionOf(() => extract7zArchiveAsync(archive, { password: PASSWORD })));
    expect(value).toBeInstanceOf(UnsupportedArchiveMethodError);
    expect((value as UnsupportedArchiveMethodError).status).toBe(HTTP_UNPROCESSABLE);
    expect((value as Error).message).toMatch(/more than 2\^26 rounds of key derivation in total/);
    expect(elapsedMs, 'refused from the header alone').toBeLessThan(2000);
    expect(maxDelayMs).toBeLessThan(EVENT_LOOP_BLOCK_BUDGET_MS);
  });

  it('derives three distinct keys at the top power on a pool thread: the loop keeps turning, the wrong password is typed', async () => {
    const archive = distinctSaltArchive(distinctSalts(3), 24);
    const { value, maxDelayMs, elapsedMs } = await maxLoopDelayDuring(() => rejectionOf(() => extract7zArchiveAsync(archive, { password: PASSWORD })));
    expect(value).toBeInstanceOf(InvalidArchivePasswordError);
    // About 0.3 s of hashing per key: on the calling thread that is one stall of the whole time.
    expect(elapsedMs).toBeGreaterThan(EVENT_LOOP_BLOCK_BUDGET_MS);
    expect(maxDelayMs, `${elapsedMs.toFixed(0)} ms of work, longest loop stall ${maxDelayMs.toFixed(0)} ms`).toBeLessThan(EVENT_LOOP_BLOCK_BUDGET_MS);
  }, TEST_TIMEOUT_MS);

  it('stops a derivation on the pool when the job signal fires', async () => {
    const archive = distinctSaltArchive(distinctSalts(3), 24);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('deadline')), 50);
    const failure = await rejectionOf(() => extract7zArchiveAsync(archive, { password: PASSWORD, signal: controller.signal }));
    expect(failure).not.toBeInstanceOf(InvalidArchivePasswordError);
    expect((failure as Error).message).toBe("The sevenZipKdf task was cancelled");
  }, TEST_TIMEOUT_MS);
});
