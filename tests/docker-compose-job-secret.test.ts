import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

/**
 * The production overlay runs the workers with NODE_ENV=production, where the worker refuses to
 * start without JOB_SECRET_KEK. It must therefore require the value (no public default that would
 * make every deployment seal secrets under the same known key) and hand it to every worker service.
 * Local development forwards the key from the shell when set and never invents one.
 */
const ROOT = path.resolve(__dirname, '..');
const LOCAL_FILE = 'docker-compose.yml';
const PRODUCTION_FILE = 'docker-compose.prod.yml';
const WORKER_SERVICES = ['worker', 'worker-light', 'worker-cpu', 'worker-memory', 'worker-gpu'];
const REQUIRED_VALUE = /^JOB_SECRET_KEK=\$\{JOB_SECRET_KEK:\?[^}]+\}$/;
/** A bare name passes the shell's value through and sets nothing when the shell has none. */
const FORWARDED_VALUE = /^JOB_SECRET_KEK$/;
/** Any default form (`:-`, `-`) for JOB_SECRET_KEK itself; JOB_SECRET_KEK_PREVIOUS does not match. */
const KEK_DEFAULT = /\$\{JOB_SECRET_KEK:?-/;

function workerKekEntries(file: string, service: string): string[] {
  const compose = parse(fs.readFileSync(path.join(ROOT, file), 'utf8'), { merge: true }) as {
    services: Record<string, { environment?: string[] | Record<string, string | number | null> }>;
  };
  const environment = compose.services[service].environment ?? [];
  const entries = Array.isArray(environment)
    ? environment
    : Object.entries(environment).map(([name, value]) => (value === null ? name : `${name}=${String(value)}`));
  return entries.filter((entry) => entry === 'JOB_SECRET_KEK' || entry.startsWith('JOB_SECRET_KEK='));
}

describe('docker compose worker services', () => {
  for (const service of WORKER_SERVICES) {
    it(`${service} requires JOB_SECRET_KEK with no default in production`, () => {
      const kek = workerKekEntries(PRODUCTION_FILE, service);
      expect(kek).toHaveLength(1);
      expect(kek[0]).toMatch(REQUIRED_VALUE);
    });

    it(`${service} forwards JOB_SECRET_KEK from the shell in local development`, () => {
      const kek = workerKekEntries(LOCAL_FILE, service);
      expect(kek).toHaveLength(1);
      expect(kek[0]).toMatch(FORWARDED_VALUE);
    });
  }

  it('does not give JOB_SECRET_KEK a default anywhere', () => {
    for (const file of [LOCAL_FILE, PRODUCTION_FILE]) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).not.toMatch(KEK_DEFAULT);
    }
  });
});

describe('deployment documentation', () => {
  for (const file of ['README.md', 'README.ko.md']) {
    it(`${file} documents JOB_SECRET_KEK and its rotation`, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(text).toMatch(/`JOB_SECRET_KEK`/);
      expect(text).toMatch(/`JOB_SECRET_KEK_PREVIOUS`/);
      expect(text).toMatch(/32/);
    });
  }
});
