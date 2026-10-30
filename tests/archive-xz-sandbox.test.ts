import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Whether the simulated host denies `unshare` its namespaces, the way Docker's default seccomp profile does without
 * CAP_SYS_ADMIN. Only the capability probe's own `unshare` call fails; every other child process runs for real.
 */
const host = vi.hoisted(() => ({ denyUnshare: false, inProcessDecodes: 0 }));
const UNSHARE_EPERM_STATUS = 1;

vi.mock('../src/lib/conversions/xz-format', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/xz-format')>();
  return {
    ...actual,
    unpackXzStream: (...args: Parameters<typeof actual.unpackXzStream>) => {
      host.inProcessDecodes += 1;
      return actual.unpackXzStream(...args);
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((file: string, ...rest: unknown[]) => {
    if (host.denyUnshare && file.endsWith('/unshare')) {
      throw Object.assign(new Error('unshare: unshare failed: Operation not permitted'), { status: UNSHARE_EPERM_STATUS });
    }
    return (actual.execFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.execFileSync;
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

import {
  compressXz,
  convertArchive,
  createTarArchive,
  decompressXz,
  getXzBinaryPath,
  packXz,
  packXzAsync,
  unpackXz,
} from '../src/lib/conversions/archive';
import { JOB_DEADLINE_AT, type JobDeadlined } from '../src/lib/conversions/job-time';
import { getPrlimitCapability, getUnshareCapability, resetUnshareCapabilityCache } from '../src/lib/security/process-sandbox';
import { CorruptStreamError, CpuTaskTimeoutError, DecompressionLimitError, SandboxUnavailableError, type ConversionOptions } from '../src/lib/types';
import { skipUnless } from './helpers/strict-skip';

const SPY_MODE = 0o755;
const KIB = 1024;
const GIB = 1024 * 1024 * 1024;
const PAYLOAD = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(500));
const HAS_NAMESPACES = getUnshareCapability().available;
const ON_LINUX = process.platform === 'linux';
const DEADLINE_MS = 300;
const SLOW_SPY_SECONDS = 30;
const BOUND_MS = 10_000;
const TEST_TIMEOUT_MS = 60_000;

let spyDir = '';
let spyLog = '';

/** Records what the native xz was started with, then fails so the in-process engine answers. */
const RECORDING_SPY = (log: string): string => `#!/bin/sh
{
  echo "argv=$*"
  echo "net=$(readlink /proc/self/ns/net)"
  echo "address_space_kib=$(ulimit -v)"
  echo "cpu_seconds=$(ulimit -t)"
  echo "environment=$(env | sort | tr '\\n' ' ')"
} >> "${log}"
exit 3
`;

/** Outlives any deadline. */
const SLOW_SPY = `#!/bin/sh
exec sleep ${SLOW_SPY_SECONDS}
`;

function writeSpy(name: string, body: string): string {
  const file = path.join(spyDir, name);
  writeFileSync(file, body);
  chmodSync(file, SPY_MODE);
  return file;
}

function spyRuns(): Array<Record<string, string>> {
  if (!existsSync(spyLog)) return [];
  const runs: Array<Record<string, string>> = [];
  for (const line of readFileSync(spyLog, 'utf-8').split('\n').filter(Boolean)) {
    const at = line.indexOf('=');
    if (line.startsWith('argv=')) runs.push({});
    if (at > 0 && runs.length > 0) runs[runs.length - 1][line.slice(0, at)] = line.slice(at + 1);
  }
  return runs;
}

beforeAll(() => {
  spyDir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-xz-spy-'));
  spyLog = path.join(spyDir, 'invocations.log');
});

afterAll(() => {
  rmSync(spyDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(spyLog, { force: true });
  host.inProcessDecodes = 0;
  resetUnshareCapabilityCache();
});

afterEach(() => {
  host.denyUnshare = false;
  vi.unstubAllEnvs();
  resetUnshareCapabilityCache();
});

function useSpy(spy: string): void {
  vi.stubEnv('XZ_PATH', spy);
}

function forceSandboxUnavailable(): void {
  host.denyUnshare = true;
  vi.stubEnv('STRICT_SANDBOX', 'true');
  resetUnshareCapabilityCache();
}

// skip-ok: the wrapper is a Linux namespace and the spy reads /proc, so a host without unprivileged namespaces cannot show it.
describe.skipIf(skipUnless('Linux with unprivileged namespaces (unshare -r -n)', ON_LINUX && HAS_NAMESPACES))(
  'the native xz starts under the sandbox wrapper in strict mode',
  () => {
    beforeEach(() => {
      useSpy(writeSpy('xz-recording', RECORDING_SPY(spyLog)));
      vi.stubEnv('STRICT_SANDBOX', 'true');
      vi.stubEnv('EASYCONVERT_XZ_PROBE_VARIABLE', 'leaked');
    });

    function expectConfined(run: Record<string, string>): void {
      expect(run.net, 'own network namespace').not.toBe(readlinkSync('/proc/self/ns/net'));
      expect(Number(run.address_space_kib) * KIB, 'address space rlimit').toBeLessThanOrEqual(GIB);
      expect(Number.isFinite(Number(run.cpu_seconds)), 'CPU time rlimit').toBe(true);
      expect(run.environment, 'sanitized environment').not.toContain('EASYCONVERT_XZ_PROBE_VARIABLE');
    }

    it('compressXz', async () => {
      const stream = await compressXz(PAYLOAD, { compressionLevel: 6 });
      const runs = spyRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].argv).toBe('-T1 -6 -c -q');
      expectConfined(runs[0]);
      expect(unpackXz(stream).equals(PAYLOAD)).toBe(true);
    });

    it('decompressXz', async () => {
      const out = await decompressXz(packXz(PAYLOAD));
      const runs = spyRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].argv).toMatch(/^-d -T1 -c -q --memlimit-decompress=\d+$/);
      expectConfined(runs[0]);
      expect(out.equals(PAYLOAD)).toBe(true);
    });
  }
);

describe('the namespace sandbox is unavailable in strict mode', () => {
  beforeEach(() => {
    useSpy(writeSpy('xz-recording', RECORDING_SPY(spyLog)));
    forceSandboxUnavailable();
  });

  it('compressXz answers with SandboxUnavailableError and never starts xz', async () => {
    await expect(compressXz(PAYLOAD)).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(spyRuns()).toEqual([]);
  });

  it('decompressXz answers with SandboxUnavailableError and never starts xz', async () => {
    await expect(decompressXz(packXz(PAYLOAD))).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(spyRuns()).toEqual([]);
  });

  it('keeps the typed refusal through the conversion entry point for both directions', async () => {
    await expect(convertArchive(packXz(PAYLOAD), 'xz', 'tar', {}, 'payload.xz')).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(convertArchive(createTarArchive([{ filename: 'payload.txt', buffer: PAYLOAD }], {}, 'payload.tar').buffer, 'tar', 'xz', {}, 'payload.tar')).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(spyRuns()).toEqual([]);
  });
});

describe('the job deadline and the abort signal reach the native xz', () => {
  beforeEach(() => {
    useSpy(writeSpy('xz-slow', SLOW_SPY));
  });

  it(
    'decompressXz stops at the job deadline instead of waiting for xz',
    async () => {
      const started = Date.now();
      const options: ConversionOptions & JobDeadlined = { [JOB_DEADLINE_AT]: started + DEADLINE_MS };
      await expect(decompressXz(packXz(PAYLOAD), options)).rejects.toBeInstanceOf(CpuTaskTimeoutError);
      expect(Date.now() - started).toBeLessThan(BOUND_MS);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'compressXz stops when the job signal fires and rethrows its reason',
    async () => {
      const controller = new AbortController();
      const reason = new Error('job cancelled');
      const started = Date.now();
      const run = compressXz(PAYLOAD, { signal: controller.signal });
      setTimeout(() => controller.abort(reason), DEADLINE_MS);
      await expect(run).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(BOUND_MS);
    },
    TEST_TIMEOUT_MS
  );

  it('decompressXz refuses an already aborted signal before starting xz', async () => {
    useSpy(writeSpy('xz-recording', RECORDING_SPY(spyLog)));
    const reason = new Error('job cancelled');
    await expect(decompressXz(packXz(PAYLOAD), { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(spyRuns()).toEqual([]);
  });
});

describe('a compression past the stage limit is a CpuTaskTimeoutError, not a stream from the pure encoder', () => {
  it(
    'compressXz stops at the job deadline',
    async () => {
      useSpy(writeSpy('xz-slow', SLOW_SPY));
      const started = Date.now();
      const options: ConversionOptions & JobDeadlined = { [JOB_DEADLINE_AT]: started + DEADLINE_MS };
      await expect(compressXz(PAYLOAD, options)).rejects.toBeInstanceOf(CpuTaskTimeoutError);
      expect(Date.now() - started).toBeLessThan(BOUND_MS);
    },
    TEST_TIMEOUT_MS
  );
});

const XZ_BINARY = getXzBinaryPath();
const DICTIONARY_MIB = 512;

function xzWrite(args: string[]): Buffer {
  const run = spawnSync(XZ_BINARY as string, ['-T1', '-c', '-q', ...args], { input: PAYLOAD, maxBuffer: 64 * KIB * KIB });
  if (run.status !== 0) throw new Error(`xz ${args.join(' ')} failed: ${run.stderr?.toString()}`);
  return run.stdout;
}

// skip-ok: the refusals under test are the installed xz's own, so a host without xz cannot show them.
describe.skipIf(skipUnless('xz', XZ_BINARY !== null))('a stream the native xz refused is refused, not decoded again in the event loop', () => {
  it('a dictionary above the decoder memory limit is a 413', async () => {
    const stream = xzWrite([`--lzma2=dict=${DICTIONARY_MIB}MiB`]);
    const outcome = await decompressXz(stream).then(
      () => null,
      (error: unknown) => error
    );
    expect(outcome).toBeInstanceOf(DecompressionLimitError);
    expect((outcome as DecompressionLimitError).status).toBe(413);
    expect(host.inProcessDecodes).toBe(0);
  });

  it('a truncated stream is a CorruptStreamError (400)', async () => {
    const stream = xzWrite(['-6']);
    const outcome = await decompressXz(stream.subarray(0, stream.length - 20)).then(
      () => null,
      (error: unknown) => error
    );
    expect(outcome).toBeInstanceOf(CorruptStreamError);
    expect((outcome as CorruptStreamError).status).toBe(400);
    expect(host.inProcessDecodes).toBe(0);
  });

  it('the in-process reader still decodes when the native binary is not installed', async () => {
    const stream = xzWrite(['-6']);
    vi.stubEnv('XZ_PATH', path.join(spyDir, 'no-such-xz'));
    expect((await decompressXz(stream)).equals(PAYLOAD)).toBe(true);
    expect(host.inProcessDecodes).toBe(1);
  });
});

const REAL_INPUT = Buffer.concat([PAYLOAD, Buffer.from(Array.from({ length: 40_000 }, (_, i) => (i * 2_654_435_761) >>> 24))]);

// skip-ok: needs the Linux namespace wrapper and prlimit around the installed xz, so a host without them cannot show the limits.
describe.skipIf(
  skipUnless('Linux with unprivileged namespaces, prlimit and xz', ON_LINUX && HAS_NAMESPACES && getPrlimitCapability().available && XZ_BINARY !== null)
)('the installed xz runs under the real sandbox and prlimit', () => {
  beforeEach(() => {
    vi.stubEnv('STRICT_SANDBOX', 'true');
  });

  it(
    'compresses at level 9 inside the 1 GiB address space and decodes the stream, both natively',
    async () => {
      const reference = spawnSync(XZ_BINARY as string, ['-T1', '-9', '-c', '-q'], { input: REAL_INPUT, maxBuffer: 64 * KIB * KIB }).stdout;
      const stream = await compressXz(REAL_INPUT, { compressionLevel: 9 });
      expect(stream.equals(reference), 'the bytes of xz -T1 -9').toBe(true);
      expect((await packXzAsync(REAL_INPUT, { compressionLevel: 9 })).equals(reference), 'the pure encoder writes another stream').toBe(false);
      expect((await decompressXz(stream)).equals(REAL_INPUT)).toBe(true);
      expect(host.inProcessDecodes, 'no decode in the event loop').toBe(0);
    },
    TEST_TIMEOUT_MS
  );
});
