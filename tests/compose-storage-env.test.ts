import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { StorageConfigError } from '../src/lib/storage/errors';
import {
  KNOWN_PUBLIC_SIGNING_SECRETS,
  assertSigningSecretConfigured,
  isRemoteStorageConfig,
  resolveStorageConfig,
} from '../src/lib/storage/storage-config';

/**
 * The compose files must hand the workers an environment their storage configuration accepts.
 *
 * - `docker-compose.yml` is local development: it must start with no cloud settings and no secret
 *   (running `docker compose up`, or Redis alone, must never ask for one), and must not invent
 *   credentials.
 * - `docker-compose.prod.yml` is the production stack of the shared host (a complete file, not an overlay): it selects
 *   NODE_ENV=production, defaults the driver to local and refuses to start without the settings production needs.
 *
 * Oracles, none from src/: the `yaml` package parses the files (anchors and merge keys expanded); variable
 * interpolation follows the
 * Compose specification (`${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?error}`,
 * `${VAR?error}`, `$$`) plus pass-through entries (`NAME`, `NAME:`: the shell's value when set, unset
 * otherwise), implemented below; expected endpoints are written out by hand from
 * Oracle's documented S3 compatibility endpoint format.
 */

const ROOT = path.join(__dirname, '..');
const LOCAL_FILE = 'docker-compose.yml';
const PRODUCTION_FILE = 'docker-compose.prod.yml';
const WORKER_SERVICES = ['worker', 'worker-light', 'worker-cpu', 'worker-memory', 'worker-gpu'] as const;
const SIGNING_SECRET_BYTES = 32;

type Environment = Record<string, string>;

interface ComposeFile {
  services?: Record<string, { environment?: string[] | Record<string, string | number | null> }>;
}

const INTERPOLATION_PATTERN = /\$(\$|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\})/g;

interface Interpolated {
  value: string;
  /** Variables that a `:?` / `?` form required and the environment did not provide. */
  missing: string[];
}

function interpolate(template: string, env: Environment): Interpolated {
  const missing: string[] = [];
  const value = template.replace(INTERPOLATION_PATTERN, (_match, escaped: string, name?: string, operator?: string, argument = '') => {
    if (escaped === '$') return '$';
    const actual = env[name as string];
    const isSet = actual !== undefined;
    const isUsable = isSet && actual !== '';
    switch (operator) {
      case ':-':
        return isUsable ? actual : argument;
      case '-':
        return isSet ? actual : argument;
      case ':?':
        if (!isUsable) missing.push(name as string);
        return actual ?? '';
      case '?':
        if (!isSet) missing.push(name as string);
        return actual ?? '';
      default:
        return actual ?? '';
    }
  });
  return { value, missing };
}

function readCompose(file: string): ComposeFile {
  return parse(fs.readFileSync(path.join(ROOT, file), 'utf-8'), { merge: true }) as ComposeFile;
}

/** [name, template] pairs; a null template is a pass-through (`NAME` in the list form, `NAME:` in the mapping form). */
function environmentEntries(raw: string[] | Record<string, string | number | null> | undefined): Array<[string, string | null]> {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      const equals = entry.indexOf('=');
      return equals === -1 ? [entry, null] : [entry.slice(0, equals), entry.slice(equals + 1)];
    });
  }
  return Object.entries(raw).map(([name, value]) => [name, value === null ? null : String(value)]);
}

/** The environment of one service after merging the files in order (later files win per variable) and interpolating. */
function resolveServiceEnvironment(files: string[], service: string, shell: Environment): { env: Environment; missing: string[] } {
  const merged = new Map<string, string | null>();
  for (const file of files) {
    for (const [name, value] of environmentEntries(readCompose(file).services?.[service]?.environment)) {
      merged.set(name, value);
    }
  }
  const env: Environment = {};
  const missing: string[] = [];
  for (const [name, template] of merged) {
    if (template === null) {
      if (shell[name] !== undefined) env[name] = shell[name];
      continue;
    }
    const result = interpolate(template, shell);
    env[name] = result.value;
    missing.push(...result.missing);
  }
  return { env, missing };
}

function randomSecret(): string {
  return crypto.randomBytes(SIGNING_SECRET_BYTES).toString('hex');
}

describe('interpolation helper (Compose specification examples)', () => {
  it.each([
    ['${A}', {}, '', []],
    ['${A:-d}', {}, 'd', []],
    ['${A:-d}', { A: '' }, 'd', []],
    ['${A-d}', { A: '' }, '', []],
    ['${A-d}', {}, 'd', []],
    ['${A:-d}', { A: 'x' }, 'x', []],
    ['${A:?why}', {}, '', ['A']],
    ['${A:?why}', { A: '' }, '', ['A']],
    ['${A?why}', { A: '' }, '', []],
    ['${A?why}', {}, '', ['A']],
    ['$$HOME', {}, '$HOME', []],
  ])('%s with %j gives %j and missing %j', (template, env, value, missing) => {
    expect(interpolate(template, env)).toEqual({ value, missing });
  });
});

describe(`${LOCAL_FILE} (local development)`, () => {
  it('asks for no variable at all, so `docker compose up` and `docker compose up redis` work out of the box', () => {
    const text = fs.readFileSync(path.join(ROOT, LOCAL_FILE), 'utf-8');
    const withoutComments = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(withoutComments).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*:?\?/);
  });

  it.each(WORKER_SERVICES)('%s starts in a non-production mode that needs no signing secret or cloud setting', (service) => {
    const { env, missing } = resolveServiceEnvironment([LOCAL_FILE], service, {});

    expect(missing).toEqual([]);
    expect(env.NODE_ENV).toBe('development');
    expect(env.STORAGE_DRIVER).toBe('local');
    expect(resolveStorageConfig(env)).toEqual({ driver: 'local' });
    expect(() => assertSigningSecretConfigured(env)).not.toThrow();
  });

  it.each(WORKER_SERVICES)('%s invents no credential, tenancy or signing secret', (service) => {
    const { env } = resolveServiceEnvironment([LOCAL_FILE], service, {});

    const cloudValues = Object.entries(env).filter(([name, value]) => /^(OCI|S3|AWS)_/.test(name) && value !== '');
    expect(cloudValues).toEqual([]);
    for (const value of Object.values(env)) {
      expect(KNOWN_PUBLIC_SIGNING_SECRETS.has(value)).toBe(false);
    }
    expect(env.STORAGE_SIGNING_SECRET ?? '').toBe('');
  });

  it('forwards a signing secret from the shell when the developer sets one', () => {
    const secret = randomSecret();
    const { env } = resolveServiceEnvironment([LOCAL_FILE], 'worker', { STORAGE_SIGNING_SECRET: secret });
    expect(env.STORAGE_SIGNING_SECRET).toBe(secret);
  });
});

describe(`${PRODUCTION_FILE} (production stack)`, () => {
  const files = [PRODUCTION_FILE];
  const APPLICATION_SERVICES = ['web', ...WORKER_SERVICES] as const;
  /**
   * The settings of the `environment` blocks that are required without a default, whatever the storage driver. The Redis password
   * (inside the nested default of REDIS_URL) and the scratch directory (a bind mount) are not in an `environment` block, so
   * tests/compose-hardening.test.ts checks them against `docker compose config`.
   */
  const REQUIRED = ['APP_URL', 'JOB_SECRET_KEK', 'STORAGE_SIGNING_SECRET'];
  const baseShell = (secret: string): Environment => ({
    STORAGE_SIGNING_SECRET: secret,
    JOB_SECRET_KEK: randomSecret(),
    REDIS_PASSWORD: 'p'.repeat(24),
    APP_URL: 'https://convert.example.test',
    EASYCONVERT_SCRATCH_DIR: '/scratch',
    JWT_SECRET: randomSecret(),
    KEY_HASH_PEPPER: randomSecret(),
    WEBHOOK_SECRET_KEK: randomSecret(),
  });

  it.each(APPLICATION_SERVICES)('%s refuses to start without the signing secret, the sealing key and the public origin', (service) => {
    const { missing } = resolveServiceEnvironment(files, service, {});
    const expected = service === 'web' ? [...REQUIRED, 'JWT_SECRET', 'KEY_HASH_PEPPER', 'WEBHOOK_SECRET_KEK'] : REQUIRED;
    expect([...new Set(missing)].sort()).toEqual([...expected].sort());
  });

  it.each(APPLICATION_SERVICES)('%s runs in production and resolves the local driver without any cloud setting', (service) => {
    const secret = randomSecret();
    const { env, missing } = resolveServiceEnvironment(files, service, baseShell(secret));

    expect(missing).toEqual([]);
    expect(env.NODE_ENV).toBe('production');
    expect(() => assertSigningSecretConfigured(env)).not.toThrow();
    expect(resolveStorageConfig(env)).toEqual({ driver: 'local' });
  });

  it('resolves the OCI driver when a later scale-out sets it with its variables', () => {
    const { env, missing } = resolveServiceEnvironment(files, 'worker', {
      ...baseShell(randomSecret()),
      STORAGE_DRIVER: 'oci',
      OCI_NAMESPACE: 'examplens',
      OCI_REGION: 'ap-seoul-1',
      OCI_BUCKET: 'example-bucket',
      OCI_ACCESS_KEY_ID: 'example-access-key-id',
      OCI_SECRET_ACCESS_KEY: 'example-secret-access-key',
    });

    expect(missing).toEqual([]);
    const config = resolveStorageConfig(env);
    expect(isRemoteStorageConfig(config)).toBe(true);
    expect(config).toMatchObject({
      driver: 'oci',
      endpoint: 'https://examplens.compat.objectstorage.ap-seoul-1.oraclecloud.com',
      region: 'ap-seoul-1',
      bucket: 'example-bucket',
      accessKeyId: 'example-access-key-id',
      namespace: 'examplens',
    });
  });

  it('resolves the S3 driver from the S3_* variables it forwards', () => {
    const { env, missing } = resolveServiceEnvironment(files, 'worker', {
      ...baseShell(randomSecret()),
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'https://s3.example.test',
      S3_REGION: 'eu-west-1',
      S3_BUCKET: 'example-bucket',
      S3_ACCESS_KEY_ID: 'example-access-key-id',
      S3_SECRET_ACCESS_KEY: 'example-secret-access-key',
    });

    expect(missing).toEqual([]);
    expect(resolveStorageConfig(env)).toMatchObject({
      driver: 's3',
      endpoint: 'https://s3.example.test',
      region: 'eu-west-1',
      bucket: 'example-bucket',
    });
  });

  it('stops startup with a typed error naming the missing OCI variable instead of inventing one', () => {
    const shell: Environment = {
      ...baseShell(randomSecret()),
      STORAGE_DRIVER: 'oci',
      OCI_REGION: 'ap-seoul-1',
      OCI_BUCKET: 'example-bucket',
      OCI_ACCESS_KEY_ID: 'example-access-key-id',
      OCI_SECRET_ACCESS_KEY: 'example-secret-access-key',
    };
    const { env } = resolveServiceEnvironment(files, 'worker', shell);

    let thrown: unknown;
    try {
      resolveStorageConfig(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageConfigError);
    expect((thrown as StorageConfigError).missing).toEqual(['OCI_NAMESPACE']);
  });

  it('keeps the public development secret out of production', () => {
    const [publicSecret] = [...KNOWN_PUBLIC_SIGNING_SECRETS];
    const { env } = resolveServiceEnvironment(files, 'worker', baseShell(publicSecret));
    expect(() => assertSigningSecretConfigured(env)).toThrow(StorageConfigError);
  });
});
