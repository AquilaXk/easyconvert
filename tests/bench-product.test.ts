import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../bench/config';
import { BenchArgumentError } from '../bench/errors';
import { REPO_ROOT } from '../bench/config';
import { importProduct, productRoot } from '../bench/product';
import { noiseSamples, replay } from '../bench/replay-speed-reports';
import type { BenchReport } from '../bench/report';
import { throughputRow } from '../bench/rows';
import { parseArgs } from '../bench/run';

/** The two versions of the product a speed run measures, and the replay of a recorded report. */

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-product-'));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('the product of a process', () => {
  it('is this repository unless BENCH_PRODUCT_ROOT names another checkout', () => {
    expect(productRoot({})).toBe(REPO_ROOT);
    expect(productRoot({ BENCH_PRODUCT_ROOT: '' })).toBe(REPO_ROOT);
    expect(productRoot({ BENCH_PRODUCT_ROOT: 'ab-base' })).toBe(path.resolve('ab-base'));
  });

  it('loads a module of src/ of the checkout it is started with, and of no other', async () => {
    const base = fs.mkdtempSync(path.join(work, 'base-'));
    fs.mkdirSync(path.join(base, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(base, 'src', 'lib', 'version.ts'), "export const version = 'base';\n");
    const before = process.env.BENCH_PRODUCT_ROOT;
    process.env.BENCH_PRODUCT_ROOT = base;
    try {
      expect((await importProduct<{ version: string }>('lib/version')).version).toBe('base');
      process.env.BENCH_PRODUCT_ROOT = path.join(work, 'elsewhere');
      await expect(importProduct('lib/version')).rejects.toThrow();
    } finally {
      if (before === undefined) delete process.env.BENCH_PRODUCT_ROOT;
      else process.env.BENCH_PRODUCT_ROOT = before;
    }
  });
});

describe('the command line', () => {
  it('takes the base checkout from --base-root or from BENCH_BASE_ROOT, only for a speed-only parity run', () => {
    expect(parseArgs(['--parity', '--speed-only', '--base-root', 'ab-base']).baseRoot).toBe(path.resolve('ab-base'));
    expect(() => parseArgs(['--base-root', 'ab-base'])).toThrow(BenchArgumentError);
    expect(() => parseArgs(['--parity', '--base-root', 'ab-base'])).toThrow(/--speed-only/);
    const before = process.env.BENCH_BASE_ROOT;
    process.env.BENCH_BASE_ROOT = 'from-env';
    try {
      expect(parseArgs(['--parity', '--speed-only']).baseRoot).toBe(path.resolve('from-env'));
      expect(parseArgs(['--parity', '--speed-only', '--base-root', 'flag']).baseRoot).toBe(path.resolve('flag'));
      expect(parseArgs(['--parity', '--quality-only']).baseRoot).toBeNull();
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
      ab: { pairs, headVsBaseMedian: headSlower ? 0.8 : 1, headVsBaseUpper: headSlower ? 0.8 : 1, headVsReferenceUpper: 1, noise: 0, baseVsReferenceMedian: headSlower ? 1.25 : 1, extraPairs: 0, confirmed: { slower: headSlower, lost: false } },
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

describe('the noise summary of reports of a commit compared with itself', () => {
  const rowFor = (id: string, noise: number, median: number) => {
    const [family, caseName] = id.split('/');
    const base = throughputRow(family as 'compression', caseName, 1e6, { ...timing(false) }, 'tool');
    return { ...base, id: `${family}/${caseName}/throughput`, abNoise: noise, abMedian: median };
  };
  const timing = (headSlower: boolean) => ({
    runs: 1,
    repeats: { ours: 1, reference: 1 },
    oursMs: [100],
    referenceMs: [100],
    baseMs: [headSlower ? 80 : 100],
    oursMedianMs: 100,
    referenceMedianMs: 100,
    oursCv: 0,
    referenceCv: 0,
    decision: { verdict: 'pass' as const, pairs: 1, median: 1, lower: null, upper: null, confidence: null, passLine: 0.97 },
    unstableAtCap: false,
    ab: { pairs: 24, headVsBaseMedian: 1, headVsBaseUpper: 1, headVsReferenceUpper: 1, noise: 0, baseVsReferenceMedian: 1, extraPairs: 0, confirmed: {} },
  });

  it('takes the median noise and the mean log bias of each row, and marks the rows of the slow families heavy', () => {
    const report = (noise: number, median: number): BenchReport => ({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: '2026-01-01T00:00:00.000Z',
      strictMode: true,
      families: ['compression'],
      host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
      tools: {},
      settings: { runs: 1, injectedRegression: null },
      rows: [rowFor('compression/a', noise, median), rowFor('video/b', noise * 2, median)],
    });
    const rows = noiseSamples([report(0.02, 0.98), report(0.04, 0.98), report(0.03, 0.98)]);
    expect(rows).toEqual([
      { id: 'compression/a/throughput', weight: 'light', noise: 0.03, bias: Number(Math.log(0.98).toFixed(4)), reports: 3 },
      { id: 'video/b/throughput', weight: 'heavy', noise: 0.06, bias: Number(Math.log(0.98).toFixed(4)), reports: 3 },
    ]);
  });
});
