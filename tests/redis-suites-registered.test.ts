import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A suite that skips without REDIS_URL runs only where REDIS_URL is set. The shards run without it, so the Redis-mode
 * CI step (`npm run test:redis`) is the only place such a suite runs; one missing from that script never runs at all.
 */

const TESTS_DIR = __dirname;
const REDIS_GATE = /skipIf\(\s*!\s*(?:process\.env\.)?REDIS_URL\s*\)/;

describe('Redis-mode suites', () => {
  it('every file that skips without REDIS_URL is run by the test:redis script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(TESTS_DIR, '..', 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    const script = packageJson.scripts['test:redis'];
    const gated = fs
      .readdirSync(TESTS_DIR)
      .filter((name) => name.endsWith('.test.ts') && name !== path.basename(__filename))
      .filter((name) => REDIS_GATE.test(fs.readFileSync(path.join(TESTS_DIR, name), 'utf-8')))
      .sort();
    expect(gated.length).toBeGreaterThan(0);
    const unregistered = gated.filter((name) => !script.includes(`tests/${name}`));
    expect(unregistered).toEqual([]);
  });
});
