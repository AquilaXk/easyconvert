import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../bench/config';
import { BenchArgumentError } from '../bench/errors';
import { configureBaseRoot, hasBase, importProduct, inVariant } from '../bench/product';
import { replay } from '../bench/replay-speed-reports';
import type { BenchReport } from '../bench/report';
import { throughputRow } from '../bench/rows';
import { parseArgs } from '../bench/run';

/** The two versions of the product a speed run measures, and the replay of a recorded report. */

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-product-'));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));
afterEach(() => configureBaseRoot(null));

function fakeBase(version: string): string {
  const root = fs.mkdtempSync(path.join(work, 'base-'));
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'lib', 'version.ts'), `export const version = '${version}';\n`);
  return root;
}

describe('the product of a speed run', () => {
  it('has no base until one is configured, and refuses to load it before', async () => {
    expect(hasBase()).toBe(false);
    await expect(inVariant('base', () => importProduct('lib/version'))).rejects.toThrow(/no base checkout/);
  });

  it('loads the head and the base side by side, from their own files, and restores the head afterwards', async () => {
    configureBaseRoot(fakeBase('base'));
    expect(hasBase()).toBe(true);
    const head = await importProduct<{ version?: string }>('lib/registry').catch(() => null);
    expect(head).not.toBeNull();
    expect(await inVariant('base', async () => (await importProduct<{ version: string }>('lib/version')).version)).toBe('base');
    // After the base run the head is the version in use: its registry loads, the base's lib/version does not exist there.
    await expect(importProduct('lib/version')).rejects.toThrow();
  });

  it('restores the head also when the action on the base fails', async () => {
    configureBaseRoot(fakeBase('base'));
    await expect(inVariant('base', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(importProduct('lib/version')).rejects.toThrow();
  });
});

describe('the command line', () => {
  it('takes the base checkout from --base-root or from BENCH_BASE_ROOT, only for a parity run', () => {
    expect(parseArgs(['--parity', '--base-root', 'ab-base']).baseRoot).toBe(path.resolve('ab-base'));
    expect(() => parseArgs(['--base-root', 'ab-base'])).toThrow(BenchArgumentError);
    const before = process.env.BENCH_BASE_ROOT;
    process.env.BENCH_BASE_ROOT = 'from-env';
    try {
      expect(parseArgs(['--parity']).baseRoot).toBe(path.resolve('from-env'));
      expect(parseArgs(['--parity', '--base-root', 'flag']).baseRoot).toBe(path.resolve('flag'));
      expect(parseArgs([]).baseRoot).toBeNull();
    } finally {
      if (before === undefined) delete process.env.BENCH_BASE_ROOT;
      else process.env.BENCH_BASE_ROOT = before;
    }
  });
});

describe('the replay of a recorded report', () => {
  const timing = (headSlower: boolean) => {
    const pairs = 24;
    return {
      runs: pairs,
      repeats: { ours: 1, reference: 1 },
      oursMs: Array(pairs).fill(100),
      referenceMs: Array(pairs).fill(100),
      baseMs: Array(pairs).fill(headSlower ? 80 : 100),
      oursMedianMs: 100,
      referenceMedianMs: 100,
      oursCv: 0,
      referenceCv: 0,
      decision: { verdict: 'pass' as const, pairs, median: 1, lower: 1, upper: 1, confidence: 0.99, passLine: 0.97 },
      unstableAtCap: false,
      ab: { pairs, headVsBaseMedian: headSlower ? 0.8 : 1, headVsBaseUpper: headSlower ? 0.8 : 1, headVsReferenceUpper: 1, noise: 0, baseVsReferenceMedian: headSlower ? 1.25 : 1 },
    };
  };
  const reportWith = (headSlower: boolean): BenchReport => ({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    strictMode: true,
    families: ['compression'],
    host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
    tools: {},
    settings: { runs: 1, injectedRegression: null },
    rows: [throughputRow('compression', 'case', 1e6, timing(headSlower), 'tool')],
  });
  const gaps = path.join(work, 'gaps.json');
  fs.writeFileSync(gaps, JSON.stringify({ schemaVersion: 1, gaps: [] }));

  it('counts the rows compared with a base and lists the rows that fail', () => {
    const ok = path.join(work, 'ok-parity-speed.json');
    fs.writeFileSync(ok, JSON.stringify(reportWith(false)));
    expect(replay(ok, gaps)).toMatchObject({ rows: 1, abRows: 1, failures: [] });
    const slower = path.join(work, 'slower-parity-speed.json');
    fs.writeFileSync(slower, JSON.stringify(reportWith(true)));
    const summary = replay(slower, gaps);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toContain('speed-slower-than-base');
  });
});
