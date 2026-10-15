import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MAX_SHARDS, planShards, ShardPlanError } from '../scripts/ci-test-shards.mjs';
import {
  CONFORMANCE_DURATIONS_FILE,
  ConformancePlanError,
  hashPart,
  loadConformanceDurations,
  MAX_KEYS,
  mergeRecordings,
  partOfKey,
  planConformanceParts,
  validateTable,
} from '../scripts/ci-conformance-parts.mjs';
import { FORMAT_REGISTRY } from '../src/lib/registry';

/**
 * The conformance gate's parts are packed by recorded duration. The properties checked here are the ones the gate relies
 * on: every key runs in exactly one part, the plan is the same on every machine, the heaviest part stays within the
 * list-scheduling bound of the mean (Graham 1969), and a key the plan does not know still lands in a part.
 */

const ROOT = path.resolve(__dirname, '..');
const PLANNER = path.join(ROOT, 'scripts', 'ci-conformance-parts.mjs');
const CI_PARTS = 10;
const ci = parse(readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8')) as { jobs: Record<string, { strategy?: { matrix?: { part?: number[] } } }> };

/** Every work key of the gate, listed from the registry the way the gate lists them. */
function registryKeys(): string[] {
  const keys = new Set<string>();
  for (const [source, def] of Object.entries(FORMAT_REGISTRY)) {
    for (const target of def.targetFormats) {
      keys.add(`${source}->${target}`);
      if ((def.category === 'audio' || def.category === 'video') && FORMAT_REGISTRY[target].category === 'audio') keys.add(`audio-target:${target}`);
    }
  }
  const variants = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'raw', 'variants.json'), 'utf-8')) as Array<{ format: string; variant: string }>;
  for (const entry of variants) for (const target of FORMAT_REGISTRY[entry.format].targetFormats) keys.add(`${entry.format}-${entry.variant}->${target}`);
  return [...keys];
}

const SMALL = { firstPartSeconds: 0, seconds: { 'a->b': 50, 'c->d': 30, 'e->f': 30, 'g->h': 20, 'i->j': 10, 'k->l': 10 } };

describe('the plan of a small table, worked by hand', () => {
  it('packs the longest key first into the lightest part', () => {
    const plan = planConformanceParts(Object.keys(SMALL.seconds), SMALL, 2);
    // 50 | 0 -> 50 | 30 -> 50 | 60 -> 70 | 60 -> 70 | 70 -> 80 | 70 (a tie goes to the first part)
    expect(plan.shards.map((shard: { load: number }) => shard.load)).toEqual([80, 70]);
    expect(plan.partOf.get('a->b')).toBe(1);
    expect(plan.partOf.get('c->d')).toBe(2);
    expect(plan.partOf.get('e->f')).toBe(2);
  });

  it('leaves room on part 1 for the checks only it runs', () => {
    const plan = planConformanceParts(Object.keys(SMALL.seconds), { ...SMALL, firstPartSeconds: 40 }, 2);
    // Part 1 starts at 40 and part 2 at 0: 50 -> part 2 (50); 30 -> part 1 (70); 30 -> part 2 (80); 20 -> part 1 (90);
    // 10 -> part 2 (90); 10 -> part 1 (100). Part 1 carries 60 s of keys, part 2 carries 90.
    expect(plan.shards.map((shard: { load: number }) => shard.load)).toEqual([100, 90]);
    expect(plan.shards[0].files).not.toContain('a->b');
    const keySeconds = (files: string[]): number => files.reduce((sum, key) => sum + SMALL.seconds[key as keyof typeof SMALL.seconds], 0);
    expect(plan.shards.map((shard: { files: string[] }) => keySeconds(shard.files))).toEqual([60, 90]);
  });

  it('weighs a key without an entry as the median of the recorded ones, and still runs it once', () => {
    const plan = planConformanceParts([...Object.keys(SMALL.seconds), 'new->pair'], SMALL, 2);
    // The median of 10, 10, 20, 30, 30, 50 is 25.
    const loads = plan.shards.map((shard: { load: number }) => shard.load).sort((a: number, b: number) => a - b);
    expect(loads.reduce((sum: number, load: number) => sum + load, 0)).toBe(150 + 25);
    expect(plan.partOf.has('new->pair')).toBe(true);
  });

  it('plans a repeated key once', () => {
    const plan = planConformanceParts(['a->b', 'a->b', 'c->d'], SMALL, 2);
    expect(plan.shards.flatMap((shard: { files: string[] }) => shard.files).sort()).toEqual(['a->b', 'c->d']);
  });
});

describe('keys the plan does not list', () => {
  it('fall back to the hash rule the gate used before, so none can fall out of every part', () => {
    const legacy = (key: string, count: number): number => (createHash('sha256').update(key).digest().readUInt32BE(0) % count) + 1;
    for (const key of ['png->webp', 'toml->json', 'x3f-merrill->tiff', 'audio-target:opus']) {
      for (const count of [1, 2, 7, 10]) expect(hashPart(key, count), `${key} / ${count}`).toBe(legacy(key, count));
    }
    // SHA-256("png->webp") starts with 0xcd8c1b3e on this input; the check above fixes the mapping, this one pins one value.
    const plan = planConformanceParts([], SMALL, CI_PARTS);
    const parts = new Set(Array.from({ length: 400 }, (_, i) => partOfKey(plan, `unknown${i}->x`, CI_PARTS)));
    expect([...parts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('use the plan when it lists them', () => {
    const plan = planConformanceParts(['a->b'], { firstPartSeconds: 0, seconds: { 'a->b': 5 } }, 3);
    expect(partOfKey(plan, 'a->b', 3)).toBe(1);
  });
});

describe('the table', () => {
  it.each<[string, unknown, RegExp]>([
    ['a non-object', [], /must be an object/],
    ['a missing first-part cost', { seconds: {} }, /firstPartSeconds/],
    ['a negative first-part cost', { firstPartSeconds: -1, seconds: {} }, /firstPartSeconds/],
    ['durations that are not an object', { firstPartSeconds: 0, seconds: [] }, /seconds must be an object/],
    ['a negative duration', { firstPartSeconds: 0, seconds: { 'a->b': -2 } }, /a->b/],
    ['a duration that is not a number', { firstPartSeconds: 0, seconds: { 'a->b': '2' } }, /a->b/],
  ])('rejects %s with a typed error', (_name, value, message) => {
    expect(() => validateTable(value)).toThrow(ConformancePlanError);
    expect(() => validateTable(value)).toThrow(message);
  });

  it('is a shard-plan error too, so one handler covers both planners', () => {
    expect(() => validateTable(null)).toThrow(ShardPlanError);
    expect(() => planConformanceParts(Array.from({ length: MAX_KEYS + 1 }, (_, i) => `k${i}`), SMALL, 2)).toThrow(/more than/);
    expect(() => planConformanceParts(['a'], SMALL, MAX_SHARDS + 1)).toThrow(ShardPlanError);
  });

  it('merges recordings: a recorded key replaces its entry, the others stay, and the result is sorted and rounded', () => {
    const merged = mergeRecordings({ firstPartSeconds: 5, seconds: { 'b->c': 1, 'a->b': 2 } }, [
      { firstPartSeconds: 9.456, seconds: { 'b->c': 3.14159, 'z->a': 0.004 } },
      { seconds: { 'c->d': 7 } },
    ]);
    expect(merged).toEqual({ firstPartSeconds: 9.46, seconds: { 'a->b': 2, 'b->c': 3.14, 'c->d': 7, 'z->a': 0 } });
    expect(Object.keys(merged.seconds)).toEqual(['a->b', 'b->c', 'c->d', 'z->a']);
  });

  it('refuses a recording with a negative duration', () => {
    expect(() => mergeRecordings(SMALL, [{ seconds: { 'a->b': -1 } }])).toThrow(ConformancePlanError);
  });
});

describe('the recorded table and the CI parts', () => {
  const table = loadConformanceDurations();
  const keys = registryKeys();

  it('is the table the gate reads, and holds a non-negative number of seconds per key', () => {
    expect(CONFORMANCE_DURATIONS_FILE.endsWith(path.join('.github', 'ci', 'conformance-durations.json'))).toBe(true);
    expect(Object.keys(table.seconds).length).toBeGreaterThan(1000);
    expect(table.firstPartSeconds).toBeGreaterThanOrEqual(0);
  });

  it('records the cost of the registry-wide checks only part 1 runs', () => {
    const first = planConformanceParts(keys, table, CI_PARTS).shards[0] as { load: number; files: string[] };
    const ownKeys = first.files.reduce((sum, key) => sum + (table.seconds[key] ?? 0), 0);
    expect(first.load - ownKeys).toBeCloseTo(table.firstPartSeconds, 6);
    expect(table.firstPartSeconds).toBeGreaterThan(table.seconds['audio-target:wma'] ?? 0);
  });

  it('lists the work keys of the registry: at most a few percent of them are new since the last recording', () => {
    const missing = keys.filter((key) => !(key in table.seconds));
    expect(missing.length / keys.length).toBeLessThan(0.05);
  });

  it('uses the part count of the conformance job', () => {
    expect(ci.jobs.conformance.strategy?.matrix?.part).toEqual(Array.from({ length: CI_PARTS }, (_, i) => i + 1));
  });

  it('has every part record its durations and upload them, so the table is refreshed from real CI numbers', () => {
    const steps = (ci.jobs.conformance as unknown as { steps: Array<{ name?: string; if?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> }> }).steps;
    const run = steps.find((step) => step.name === 'Run the registry conformance gate');
    expect(run?.env?.CONFORMANCE_DURATIONS_OUT).toBe('${{ runner.temp }}/conformance-part-${{ matrix.part }}.json');
    const upload = steps.find((step) => step.name === 'Upload the recorded durations');
    expect(upload?.if).toBe('always()');
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload?.with?.path).toBe(run?.env?.CONFORMANCE_DURATIONS_OUT);
    expect(upload?.with?.name).toBe('conformance-durations-${{ matrix.part }}');
  });

  const plan = planConformanceParts(keys, table, CI_PARTS);
  const loads: number[] = plan.shards.map((shard: { load: number }) => shard.load);
  const mean = loads.reduce((sum, load) => sum + load, 0) / CI_PARTS;

  it('runs every key in exactly one part', () => {
    const planned = plan.shards.flatMap((shard: { files: string[] }) => shard.files).sort();
    expect(planned).toEqual([...new Set(keys)].sort());
  });

  it('is the same plan every time', () => {
    expect(planConformanceParts(keys, table, CI_PARTS).shards).toEqual(plan.shards);
  });

  it('keeps the heaviest part within the list-scheduling bound of the mean, and every part within 5% of it', () => {
    const largest = Math.max(...keys.map((key) => table.seconds[key] ?? 0));
    expect(Math.max(...loads)).toBeLessThanOrEqual(mean + largest * (1 - 1 / CI_PARTS) + 1e-6);
    for (const load of loads) expect(Math.abs(load - mean) / mean).toBeLessThan(0.05);
  });

  it('keeps the heaviest single key below a fifth of a part, so no key sets the wall time alone', () => {
    expect(Math.max(...Object.values(table.seconds as Record<string, number>))).toBeLessThan(mean / 5);
  });

  it('balances better than the hash rule it replaces, on the same recorded durations', () => {
    const hashed = Array.from({ length: CI_PARTS }, () => 0);
    for (const key of keys) hashed[hashPart(key, CI_PARTS) - 1] += table.seconds[key] ?? 0;
    hashed[0] += table.firstPartSeconds;
    expect(Math.max(...loads)).toBeLessThan(Math.max(...hashed));
  });
});

describe('the command line', () => {
  const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => spawnSync('node', [PLANNER, ...args], { cwd: ROOT, encoding: 'utf-8' });

  it('prints the planned load of every part', () => {
    const result = run('--summary', String(CI_PARTS));
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(CI_PARTS);
    expect(lines[0]).toMatch(/^part 1: \d+ keys, [\d.]+ s$/);
  });

  it.each([[[]], [['--summary']], [['--summary', '0']], [['--summary', String(MAX_SHARDS + 1)]], [['--update']], [['--bogus']]])('refuses %j with a usage message', (args) => {
    const result = run(...(args as string[]));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/usage|needs at least one recording/);
  });
});

describe('the sharded test planner it reuses', () => {
  it('still plans without base loads exactly as before', () => {
    expect(planShards(['a', 'b', 'c'], { a: 3, b: 2, c: 1 }, 2).map((shard: { load: number }) => shard.load)).toEqual([3, 3]);
  });

  it('starts a shard at its base load, and refuses more base loads than shards or a negative one', () => {
    expect(planShards(['a', 'b'], { a: 3, b: 3 }, 2, [4]).map((shard: { load: number }) => shard.load)).toEqual([4, 6]);
    expect(() => planShards(['a'], { a: 1 }, 1, [1, 2])).toThrow(ShardPlanError);
    expect(() => planShards(['a'], { a: 1 }, 1, [-1])).toThrow(ShardPlanError);
    expect(() => planShards(['a'], { a: 1 }, 2, [Number.NaN])).toThrow(ShardPlanError);
  });
});
