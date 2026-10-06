import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

/**
 * The compose workers run with NODE_ENV=production, where the worker refuses to start without
 * JOB_SECRET_KEK. Compose must therefore require the value (no public default that would make every
 * deployment seal secrets under the same known key) and hand it to every worker service.
 */
const ROOT = path.resolve(__dirname, '..');
const WORKER_SERVICES = ['worker', 'worker-gpu'];
const REQUIRED_VALUE = /^JOB_SECRET_KEK=\$\{JOB_SECRET_KEK:\?[^}]+\}$/;

describe('docker compose worker services', () => {
  const compose = parse(fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8')) as {
    services: Record<string, { environment?: string[] }>;
  };

  for (const service of WORKER_SERVICES) {
    it(`${service} requires JOB_SECRET_KEK with no default`, () => {
      const entries = compose.services[service].environment ?? [];
      const kek = entries.filter((entry) => entry.startsWith('JOB_SECRET_KEK='));
      expect(kek).toHaveLength(1);
      expect(kek[0]).toMatch(REQUIRED_VALUE);
    });
  }

  it('does not give JOB_SECRET_KEK a default anywhere', () => {
    expect(fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8')).not.toMatch(/JOB_SECRET_KEK:-/);
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
