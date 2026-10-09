import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { skipUnless } from './helpers/strict-skip';

/**
 * The compose files are read with the `yaml` package (anchors and merge keys expanded by its parser) and, where Docker
 * Compose is installed, through `docker compose config`, which expands them independently. Nothing here comes from the
 * code that produced the files; the expected hardening is written out from issue 567 and the Docker run reference.
 */

type ComposeValue = string | number | boolean | null;

interface ComposeService {
  profiles?: string[];
  tmpfs?: string[];
  security_opt?: string[];
  cap_drop?: string[];
  read_only?: boolean;
  pids_limit?: number;
  environment?: Record<string, ComposeValue> | string[];
  deploy?: { resources?: { limits?: { cpus?: string; memory?: string; pids?: number } } };
  devices?: string[];
  container_name?: string;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
}

const ROOT = path.resolve(__dirname, '..');
const BASE_PATH = path.join(ROOT, 'docker-compose.yml');
const PROD_PATH = path.join(ROOT, 'docker-compose.prod.yml');

const SECCOMP_OPT = 'seccomp=./docker/seccomp-worker.json';
const WORKER_SERVICES = ['worker', 'worker-light', 'worker-cpu', 'worker-memory', 'worker-gpu'];
const SPLIT_SERVICES = ['worker-light', 'worker-cpu', 'worker-memory', 'worker-gpu'];
/** Queue names of `ResourceClass` in src/lib/types.ts, written out so a renamed queue breaks this test. */
const EXPECTED_QUEUES: Record<string, string> = {
  'worker-light': 'light',
  'worker-cpu': 'cpu',
  'worker-memory': 'memory',
  'worker-gpu': 'gpu',
};
const DEFAULT_SERVICES = ['redis', 'worker'];
const COMPOSE_TIMEOUT_MS = 60_000;

/** Variables that must never carry a default: secrets, keys, and the cloud identifiers of the object store. */
const NO_DEFAULT_NAME = /(_SECRET|_KEY)|^OCI_NAMESPACE$|^OCI_ENDPOINT$/;

function loadYaml(file: string): ComposeFile {
  return parse(readFileSync(file, 'utf-8'), { merge: true }) as ComposeFile;
}

/** Environment as { name: value } from either compose form; a bare `NAME` entry is a pass-through (null). */
function environmentOf(service: ComposeService): Record<string, string | null> {
  const raw = service.environment ?? {};
  if (!Array.isArray(raw)) {
    return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, value === null ? null : String(value)]));
  }
  const result: Record<string, string | null> = {};
  for (const entry of raw) {
    const separator = entry.indexOf('=');
    if (separator === -1) result[entry] = null;
    else result[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return result;
}

/** True when a value is a pass-through (`NAME`, `NAME:`), a bare `${NAME}` or a required `${NAME:?message}`. */
function hasNoDefault(name: string, value: string | null): boolean {
  if (value === null) return true;
  return value === `\${${name}}` || value.startsWith(`\${${name}:?`);
}

const base = loadYaml(BASE_PATH);
const prod = loadYaml(PROD_PATH);

describe('docker-compose.yml worker hardening', () => {
  it('defines the default worker plus the split and gpu workers', () => {
    expect(Object.keys(base.services).sort()).toEqual(['redis', ...WORKER_SERVICES].sort());
  });

  it.each(WORKER_SERVICES)('%s mounts every tmpfs with nosuid and nodev, and /tmp also noexec', (name) => {
    const tmpfs = base.services[name].tmpfs ?? [];
    expect(tmpfs.length).toBeGreaterThanOrEqual(2);
    for (const mount of tmpfs) {
      const options = new Set(mount.slice(mount.indexOf(':') + 1).split(','));
      expect(options.has('nodev'), mount).toBe(true);
      expect(options.has('nosuid'), mount).toBe(true);
    }
    const temp = tmpfs.find((mount) => mount.startsWith('/tmp:'));
    expect(temp).toBe('/tmp:size=8g,noexec,nosuid,nodev');
  });

  it.each(WORKER_SERVICES)('%s applies the worker seccomp profile with no-new-privileges, read-only root and no capabilities', (name) => {
    const service = base.services[name];
    expect(service.security_opt).toEqual(['no-new-privileges:true', SECCOMP_OPT]);
    expect(service.cap_drop).toEqual(['ALL']);
    expect(service.read_only).toBe(true);
    expect(service.pids_limit).toBe(256);
    expect(service.deploy?.resources?.limits?.pids).toBe(256);
  });

  it('keeps no cap_add and no stale SYS_ADMIN note', () => {
    const text = readFileSync(BASE_PATH, 'utf-8');
    expect(text).not.toMatch(/cap_add/);
    expect(text).not.toMatch(/SYS_ADMIN/);
  });

  it('starts exactly redis and one cloud-free worker by default', () => {
    const defaults = Object.entries(base.services)
      .filter(([, service]) => (service.profiles ?? []).length === 0)
      .map(([name]) => name)
      .sort();
    expect(defaults).toEqual(DEFAULT_SERVICES);
    const env = environmentOf(base.services.worker);
    expect(env.STORAGE_DRIVER).toBe('local');
    expect(env.NODE_ENV).toBe('development');
    expect(env.STRICT_SANDBOX).toBe('true');
    expect(env.WORKER_QUEUES).toBeUndefined();
    for (const [name, value] of Object.entries(env)) {
      if (NO_DEFAULT_NAME.test(name)) expect(value, name).toBeNull();
    }
  });

  it('puts the split workers behind the split profile, each on its own queue', () => {
    for (const name of SPLIT_SERVICES) {
      const service = base.services[name];
      expect(service.profiles, name).toContain('split');
      expect(environmentOf(service).WORKER_QUEUES, name).toBe(EXPECTED_QUEUES[name]);
    }
    expect(base.services['worker-gpu'].profiles).toContain('gpu');
    expect(base.services['worker-gpu'].devices).toEqual(['/dev/dri:/dev/dri']);
    for (const name of ['worker', 'worker-light', 'worker-cpu', 'worker-memory']) {
      expect(base.services[name].devices, name).toBeUndefined();
    }
  });

  it('expands the shared worker block so the split workers differ only in name, queue, concurrency and limits', () => {
    const reference = base.services.worker;
    const ALLOWED_DIFFERENCES = new Set(['container_name', 'profiles', 'environment', 'deploy', 'devices']);
    for (const name of SPLIT_SERVICES) {
      const service = base.services[name] as Record<string, unknown>;
      for (const key of Object.keys(reference) as Array<keyof ComposeService>) {
        if (ALLOWED_DIFFERENCES.has(key)) continue;
        expect(service[key], `${name}.${key}`).toEqual(reference[key]);
      }
      const referenceEnv = environmentOf(reference);
      const env = environmentOf(base.services[name]);
      const ALLOWED_ENV = new Set(['WORKER_QUEUES', 'WORKER_CONCURRENCY', 'WORKER_MAX_RSS_MB', 'HWACCEL_ENABLED']);
      for (const [variable, value] of Object.entries(env)) {
        if (!ALLOWED_ENV.has(variable)) expect(value, `${name}.${variable}`).toBe(referenceEnv[variable]);
      }
      for (const variable of Object.keys(referenceEnv)) {
        expect(variable in env, `${name} keeps ${variable}`).toBe(true);
      }
    }
    const names = WORKER_SERVICES.map((name) => base.services[name].container_name);
    expect(new Set(names).size).toBe(WORKER_SERVICES.length);
  });
});

describe('compose files carry no default for secrets, keys or cloud identifiers', () => {
  const sources: Array<[string, ComposeFile]> = [
    ['docker-compose.yml', base],
    ['docker-compose.prod.yml', prod],
  ];

  it.each(sources)('%s has no :- or hard-coded value for a secret, key, OCI_NAMESPACE or OCI_ENDPOINT', (_file, compose) => {
    let checked = 0;
    for (const [serviceName, service] of Object.entries(compose.services)) {
      for (const [name, value] of Object.entries(environmentOf(service))) {
        if (!NO_DEFAULT_NAME.test(name)) continue;
        checked += 1;
        expect(hasNoDefault(name, value), `${serviceName}.${name}=${String(value)}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('has no interpolation default (:- or -) anywhere for those names in the raw text', () => {
    for (const file of [BASE_PATH, PROD_PATH]) {
      const text = readFileSync(file, 'utf-8');
      const defaults = [...text.matchAll(/\$\{([A-Z0-9_]+):?-/g)].map((match) => match[1]);
      expect(defaults.filter((name) => NO_DEFAULT_NAME.test(name)), file).toEqual([]);
    }
  });

  it('requires the storage driver, signing secret and sealing key in production, for every worker', () => {
    const text = readFileSync(PROD_PATH, 'utf-8');
    expect(text).toMatch(/STORAGE_DRIVER=\$\{STORAGE_DRIVER:\?/);
    expect(text).toMatch(/STORAGE_SIGNING_SECRET=\$\{STORAGE_SIGNING_SECRET:\?/);
    expect(text).toMatch(/JOB_SECRET_KEK=\$\{JOB_SECRET_KEK:\?/);
    expect(Object.keys(prod.services).sort()).toEqual([...WORKER_SERVICES].sort());
    for (const name of WORKER_SERVICES) {
      expect(environmentOf(prod.services[name]).NODE_ENV, name).toBe('production');
    }
  });
});

interface ComposeCliResult {
  available: boolean;
  run: (args: string[], env?: Record<string, string>) => { status: number | null; stdout: string; stderr: string };
}

function composeCli(): ComposeCliResult {
  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync('docker', ['compose', ...args], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: COMPOSE_TIMEOUT_MS,
      // A minimal environment: a developer's own JOB_SECRET_KEK or OCI_* would otherwise show up in the output.
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } as unknown as NodeJS.ProcessEnv,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { available: run(['version']).status === 0, run };
}

const compose = composeCli();

describe.skipIf(skipUnless('docker compose', compose.available))('docker compose config agrees with the YAML parse', () => {
  const PROD_ENV = { STORAGE_DRIVER: 'local', STORAGE_SIGNING_SECRET: 'x'.repeat(32), JOB_SECRET_KEK: 'y'.repeat(32) };

  function config(args: string[], env: Record<string, string> = {}): ComposeFile {
    const result = compose.run([...args, 'config', '--format', 'json'], env);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as ComposeFile;
  }

  it('lists exactly redis and worker without a profile, and all five workers with split and gpu', () => {
    const plain = compose.run(['config', '--services']);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout.split('\n').filter(Boolean).sort()).toEqual(DEFAULT_SERVICES);
    const all = compose.run(['--profile', 'split', '--profile', 'gpu', 'config', '--services']);
    expect(all.stdout.split('\n').filter(Boolean).sort()).toEqual(['redis', ...WORKER_SERVICES].sort());
  });

  it('expands the anchor into the same tmpfs, seccomp and queue settings the parser saw', () => {
    const effective = config(['--profile', 'split']);
    for (const name of WORKER_SERVICES) {
      const service = effective.services[name];
      expect(service.tmpfs, name).toEqual(base.services[name].tmpfs);
      expect(service.security_opt, name).toEqual(base.services[name].security_opt);
    }
    for (const name of SPLIT_SERVICES) {
      expect(environmentOf(effective.services[name]).WORKER_QUEUES, name).toBe(EXPECTED_QUEUES[name]);
    }
  });

  it('shows no value for the secret and cloud-identifier variables of the local file', () => {
    const effective = config([]);
    for (const [name, value] of Object.entries(environmentOf(effective.services.worker))) {
      if (NO_DEFAULT_NAME.test(name)) expect(value, name).toBeNull();
    }
  });

  it('applies the production overlay to every worker and leaves the cloud identifiers unset', () => {
    const effective = config(['-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml', '--profile', 'split'], PROD_ENV);
    for (const name of WORKER_SERVICES) {
      const env = environmentOf(effective.services[name]);
      expect(env.NODE_ENV, name).toBe('production');
      expect(env.OCI_NAMESPACE, name).toBeNull();
      expect(env.OCI_ENDPOINT, name).toBeNull();
      expect(env.S3_SECRET_ACCESS_KEY, name).toBeNull();
    }
  });

  it('refuses the production overlay without a signing secret', () => {
    const result = compose.run(['-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml', 'config'], {
      STORAGE_DRIVER: 'local',
      JOB_SECRET_KEK: 'y'.repeat(32),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('STORAGE_SIGNING_SECRET');
  });
});
