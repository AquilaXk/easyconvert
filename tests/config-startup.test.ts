import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Start-up validation, observed from outside the process. The oracles are the exit code and the streams of a
 * spawned process: a worker or server with a bad production configuration must stop before it connects to
 * anything, stderr must name the variable that is wrong, and no value may reach stderr.
 */

const ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WORKER_ENTRY = path.join(ROOT, 'src', 'worker', 'index.ts');
const CONFIG_ENTRY = path.join(ROOT, 'tests', 'helpers', 'config-startup-entry.ts');
/** A start-up that stops is quick; a worker that wrongly keeps running is killed at this limit. */
const SPAWN_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 40_000;
const MIN_SECRET_BYTES = 32;

/** An ASCII secret of exactly `bytes` bytes, built from `seed` so that each test has its own recognisable text. */
function secretOf(bytes: number, seed: string): string {
  return seed.repeat(Math.ceil(bytes / seed.length)).slice(0, bytes);
}

const SIGNING_SECRET = secretOf(40, 'startup-signing-');
const VALID_KEK = secretOf(MIN_SECRET_BYTES + 2, 'startup-job-kek-');

/** A complete worker environment for STORAGE_DRIVER=local in production. */
const VALID_WORKER_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  STORAGE_DRIVER: 'local',
  STORAGE_SIGNING_SECRET: SIGNING_SECRET,
  JOB_SECRET_KEK: VALID_KEK,
};

/** The extra variables the web process needs in production. */
const VALID_WEB_ENV: Readonly<Record<string, string>> = {
  ...VALID_WORKER_ENV,
  APP_URL: 'https://convert.example.org',
  JWT_SECRET: secretOf(48, 'startup-jwt-'),
  KEY_HASH_PEPPER: secretOf(48, 'startup-pepper-'),
  WEBHOOK_SECRET_KEK: secretOf(48, 'startup-webhook-kek-'),
};

interface SpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Runs a TypeScript entry under tsx with exactly the given variables (nothing is inherited but PATH and HOME). */
function runEntry(entry: string, args: readonly string[], env: Readonly<Record<string, string>>): SpawnResult {
  const childEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? os.tmpdir(), TMPDIR: os.tmpdir(), ...env };
  const result = spawnSync(process.execPath, [TSX_CLI, entry, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    // Next's typings make NODE_ENV mandatory in ProcessEnv; these runs must start without it.
    env: childEnv as unknown as NodeJS.ProcessEnv,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

/** The `- NAME: rule` lines of the ConfigurationError message in `stderr`. */
function reportedFailures(stderr: string): Array<{ variable: string; rule: string }> {
  return [...stderr.matchAll(/^ {2}- ([A-Z][A-Z0-9_]*): (.+)$/gm)].map((match) => ({ variable: match[1], rule: match[2] }));
}

function expectStartupRefused(result: SpawnResult, variable: string, leakedValue: string): void {
  expect(result.signal, `the process ran until it was killed; stdout: ${result.stdout}`).toBeNull();
  expect(result.status).toBeGreaterThan(0);
  expect(result.stderr).toContain('ConfigurationError');
  expect(result.stderr).toContain(variable);
  expect(result.stderr).not.toContain(leakedValue);
  expect(result.stdout).not.toContain('Worker daemon online');
}

describe('worker entry refuses a bad production configuration', () => {
  const heartbeatFile = path.join(os.tmpdir(), `config-startup-heartbeat-${process.pid}.json`);

  it(
    'exits non-zero for a JOB_SECRET_KEK of 31 bytes and does not print it',
    () => {
      const kek = secretOf(MIN_SECRET_BYTES - 1, 'canary-kek-31-');
      expect(Buffer.byteLength(kek, 'utf8')).toBe(MIN_SECRET_BYTES - 1);
      const result = runEntry(WORKER_ENTRY, [], { ...VALID_WORKER_ENV, JOB_SECRET_KEK: kek, WORKER_HEARTBEAT_FILE: heartbeatFile });
      expectStartupRefused(result, 'JOB_SECRET_KEK', kek);
      expect(reportedFailures(result.stderr)).toEqual([
        { variable: 'JOB_SECRET_KEK', rule: 'must be at least 32 bytes (UTF-8 text, not decoded) in production' },
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits non-zero for an APP_URL that is not an http(s) URL and does not print it',
    () => {
      const appUrl = 'ftp://canary-host.invalid/canary-path';
      const result = runEntry(WORKER_ENTRY, [], { ...VALID_WORKER_ENV, APP_URL: appUrl, WORKER_HEARTBEAT_FILE: heartbeatFile });
      expectStartupRefused(result, 'APP_URL', appUrl);
      expect(reportedFailures(result.stderr)).toEqual([{ variable: 'APP_URL', rule: 'must be a URL with the scheme http or https' }]);
      expect(result.stderr).not.toContain('canary-host');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits non-zero for a prefix length typo in TRUSTED_PROXIES and does not print the list',
    () => {
      const proxies = '203.0.113.0/24, 198.51.100.0/33';
      const result = runEntry(WORKER_ENTRY, [], { ...VALID_WORKER_ENV, TRUSTED_PROXIES: proxies, WORKER_HEARTBEAT_FILE: heartbeatFile });
      expectStartupRefused(result, 'TRUSTED_PROXIES', proxies);
      expect(reportedFailures(result.stderr)).toEqual([
        { variable: 'TRUSTED_PROXIES', rule: 'must be a comma-separated list of IPv4/IPv6 addresses or CIDR ranges' },
      ]);
      expect(result.stderr).not.toContain('198.51.100');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits non-zero for a WORKER_CONCURRENCY outside its range, which the worker used to accept',
    () => {
      const result = runEntry(WORKER_ENTRY, [], { ...VALID_WORKER_ENV, WORKER_CONCURRENCY: '0', WORKER_HEARTBEAT_FILE: heartbeatFile });
      expect(result.signal).toBeNull();
      expect(result.status).toBeGreaterThan(0);
      expect(reportedFailures(result.stderr)).toEqual([
        { variable: 'WORKER_CONCURRENCY', rule: 'must be a whole number from 1 to 1024' },
      ]);
    },
    TEST_TIMEOUT_MS
  );
});

describe('start-up step', () => {
  it(
    'succeeds in development with an empty environment and resolves the documented defaults',
    () => {
      const result = runEntry(CONFIG_ENTRY, ['worker'], {});
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        WORKER_CONCURRENCY: 3,
        WORKER_MAX_JOBS: 1000,
        STORAGE_DRIVER: 'local',
        APP_URL: 'http://localhost:3000',
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'still rejects a malformed value in development instead of falling back to the default',
    () => {
      const result = runEntry(CONFIG_ENTRY, ['worker'], { NODE_ENV: 'development', WORKER_CONCURRENCY: 'three' });
      expect(result.status).toBeGreaterThan(0);
      expect(reportedFailures(result.stderr)).toEqual([
        { variable: 'WORKER_CONCURRENCY', rule: 'must be a whole number from 1 to 1024' },
      ]);
      expect(result.stderr).not.toContain('three');
      expect(result.stdout).toBe('');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'succeeds in production with a complete worker environment',
    () => {
      const result = runEntry(CONFIG_ENTRY, ['worker'], VALID_WORKER_ENV);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        WORKER_CONCURRENCY: 3,
        WORKER_MAX_JOBS: 1000,
        STORAGE_DRIVER: 'local',
        APP_URL: null,
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'succeeds in production with a complete web environment',
    () => {
      const result = runEntry(CONFIG_ENTRY, ['web'], VALID_WEB_ENV);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ STORAGE_DRIVER: 'local', APP_URL: 'https://convert.example.org' });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'makes the web start-up step exit non-zero for an invalid APP_URL without printing it',
    () => {
      const appUrl = 'ftp://canary-web.invalid/canary-path';
      const result = runEntry(CONFIG_ENTRY, ['web'], { ...VALID_WEB_ENV, APP_URL: appUrl });
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(reportedFailures(result.stderr)).toEqual([{ variable: 'APP_URL', rule: 'must be a URL with the scheme http or https' }]);
      expect(result.stderr).not.toContain('canary-web');
      expect(result.stdout).toBe('');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'lists every failing variable of an empty production environment in one error',
    () => {
      const result = runEntry(CONFIG_ENTRY, ['web'], { NODE_ENV: 'production' });
      expect(result.status).toBeGreaterThan(0);
      for (const variable of [
        'STORAGE_DRIVER',
        'STORAGE_SIGNING_SECRET',
        'JOB_SECRET_KEK',
        'JWT_SECRET',
        'KEY_HASH_PEPPER',
        'WEBHOOK_SECRET_KEK',
      ]) {
        expect(result.stderr, variable).toContain(variable);
      }
      expect(result.stdout).toBe('');
    },
    TEST_TIMEOUT_MS
  );
});

describe('web start-up hook', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Runs `register()` with the given variables; process.exit is replaced by a throw so the test can observe it. */
  async function registerWith(env: Readonly<Record<string, string>>): Promise<{ exitCodes: number[]; logged: string; error: unknown }> {
    vi.resetModules();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }
    const exitCodes: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      throw new Error('process.exit called');
    }) as never);
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
    const { register } = await import('../src/instrumentation');
    let error: unknown;
    try {
      await register();
    } catch (caught) {
      error = caught;
    }
    return { exitCodes, logged: logged.join('\n'), error };
  }

  it('exits with status 1 and reports the variable and rule, not the value', async () => {
    const appUrl = 'ftp://canary-register.invalid/canary-path';
    const { exitCodes, logged } = await registerWith({ ...VALID_WEB_ENV, APP_URL: appUrl });
    expect(exitCodes).toEqual([1]);
    expect(reportedFailures(logged)).toEqual([{ variable: 'APP_URL', rule: 'must be a URL with the scheme http or https' }]);
    expect(logged).not.toContain('canary-register');
  });

  it('resolves without exiting for a complete production environment', async () => {
    const { exitCodes, logged, error } = await registerWith(VALID_WEB_ENV);
    expect(exitCodes).toEqual([]);
    expect(logged).toBe('');
    expect(error).toBeUndefined();
  });
});
