import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CorpusFile } from '../bench/realworld/manifest';
import { mergeRegression, readFailedBefore, readPreviousResults, readRegressionShard, type RegressionResults, type RegressionShardReport, withRecordedFailures, writeFailedBefore } from '../bench/realworld/regression/merge';
import { evaluateRegression } from '../bench/realworld/regression/differential';
import type { JobRecord } from '../bench/realworld/report';
import { REPORT_SCHEMA } from '../bench/realworld/report';

/** Merging shard reports of the regression corpus run, written out by hand. */

const job = (file: string, verdict: JobRecord['verdict'], detail?: string): JobRecord => ({ file, source: 'doc', target: 'pdf', verdict, ms: 5, ...(detail === undefined ? {} : { detail }) });
const shard = (n: number, jobs: JobRecord[], extra: Partial<RegressionShardReport> = {}): RegressionShardReport => ({
  schema: REPORT_SCHEMA,
  shard: n,
  shards: 2,
  commit: 'abcdef1234567',
  jobs,
  mode: 'full',
  date: '2026-10-18',
  unavailable: [],
  elapsedMs: 90_000,
  ...extra,
});
const files = new Map<string, CorpusFile>();

describe('merging a regression run', () => {
  const previous: RegressionResults = {
    schema: REPORT_SCHEMA,
    commit: '0123456789abcdef',
    mode: 'full',
    date: '2026-10-11',
    gate: evaluateRegression([], null, []),
    unavailable: [],
    jobs: [job('a.doc', 'ok'), job('b.doc', 'ok')],
  };

  it('gates on the jobs of every shard and on the differential against the earlier full run', () => {
    const merged = mergeRegression([shard(0, [job('a.doc', 'ok')]), shard(1, [job('b.doc', 'refused', 'ConversionFailedError: unreadable')])], previous, files, []);
    expect(merged.pass).toBe(false);
    expect(merged.results.gate.regressions.map((r) => r.file)).toEqual(['b.doc']);
    expect(merged.results.commit).toBe('abcdef1234567');
    expect(merged.results.mode).toBe('full');
    expect(merged.markdown).toContain('Compared with the run of 0123456');
    expect(merged.markdown).toContain('| 1 | 1 min 30 s |');
  });

  it('passes a clean run without an earlier result set', () => {
    const merged = mergeRegression([shard(0, [job('a.doc', 'ok')]), shard(1, [job('b.doc', 'ok')])], null, files, []);
    expect(merged.pass).toBe(true);
    expect(merged.markdown).toContain('No earlier result set');
  });

  it('fails when a corpus file could not be fetched, and lists it', () => {
    const merged = mergeRegression([shard(0, [job('a.doc', 'ok')]), shard(1, [], { unavailable: [{ file: 'c.doc', reason: 'c.doc: SHA-256 aaaa, manifest says bbbb' }] })], null, files, []);
    expect(merged.pass).toBe(false);
    expect(merged.results.unavailable).toEqual([{ file: 'c.doc', reason: 'c.doc: SHA-256 aaaa, manifest says bbbb' }]);
    expect(merged.markdown).toContain('| c.doc | c.doc: SHA-256 aaaa, manifest says bbbb |');
  });

  it('refuses shards of different runs and a missing shard', () => {
    expect(() => mergeRegression([shard(0, []), shard(1, [], { commit: 'other' })], null, files, [])).toThrow(/different runs/);
    expect(() => mergeRegression([shard(0, [])], null, files, [])).toThrow(/1 of 2/);
  });
});

describe('earlier result set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-merge-'));
  const write = (body: unknown): string => {
    const file = path.join(dir, `${Math.random()}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  };

  it('is absent when the file is not there, and refused when it is not the result of a full run', () => {
    expect(readPreviousResults(path.join(dir, 'missing.json'))).toBeNull();
    expect(() => readPreviousResults(write({ schema: REPORT_SCHEMA, mode: 'nightly', jobs: [] }))).toThrow(/full regression run/);
    expect(() => readPreviousResults(write({ schema: 99, mode: 'full', jobs: [] }))).toThrow(/full regression run/);
    expect(readPreviousResults(write({ schema: REPORT_SCHEMA, mode: 'full', commit: 'c', jobs: [] }))?.commit).toBe('c');
  });
});

describe('shard report file', () => {
  it('is read with the fields of the regression run and refused without them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-shard-'));
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify(shard(0, [job('a.doc', 'ok')])));
    expect(readRegressionShard(good).elapsedMs).toBe(90_000);
    const plain = path.join(dir, 'plain.json');
    fs.writeFileSync(plain, JSON.stringify({ schema: REPORT_SCHEMA, shard: 0, shards: 1, commit: 'c', jobs: [] }));
    expect(() => readRegressionShard(plain)).toThrow(/regression corpus shard report/);
  });
});

describe('the list of files that failed before', () => {
  const gate = evaluateRegression(
    [job('crash.doc', 'crash', 'TypeError: x'), job('known.doc', 'crash', 'RangeError: y'), job('worse.doc', 'refused', 'ConversionFailedError: z'), job('fine.doc', 'ok')],
    [job('worse.doc', 'ok'), job('fine.doc', 'ok')],
    [{ pair: 'doc->pdf', verdict: 'crash', detail: 'RangeError', file: 'known.doc', issue: 783 }]
  );

  it('adds the files of every kind of failure once, sorted, and keeps the ones already listed', () => {
    expect(withRecordedFailures(['old.doc', 'crash.doc'], gate)).toEqual(['crash.doc', 'known.doc', 'old.doc', 'worse.doc']);
  });

  it('is read and written as a sorted JSON list of ids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-failed-'));
    const file = path.join(dir, 'failed.json');
    writeFailedBefore(['b.doc', 'a.doc'].sort(), file);
    expect(readFailedBefore(file)).toEqual(['a.doc', 'b.doc']);
    fs.writeFileSync(file, '{"a":1}');
    expect(() => readFailedBefore(file)).toThrow(/list of corpus file ids/);
  });
});
