import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MissingToolError } from '../bench/errors';
import { buildBaseline } from '../bench/gate';
import { SCHEMA_VERSION } from '../bench/config';
import { type BenchReport, type BenchRow, validateReport } from '../bench/report';
import { planTools, type Resolver } from '../bench/tools';

const ROOT = path.join(__dirname, '..');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RUNNER = path.join(ROOT, 'bench', 'run.ts');
const CHILD_TIMEOUT_MS = 120_000;

const onlyFfmpeg: Resolver = (tool) => (tool === 'ffmpeg' ? '/usr/bin/ffmpeg' : null);

describe('missing reference tools: skip versus strict failure', () => {
  it('skips the row with an explicit reason that names the missing tool', () => {
    const plan = planTools(['ffmpeg', 'cwebp', 'dwebp'], 'photo.jpg->webp', onlyFfmpeg, false);
    expect(plan).toEqual({ ok: false, missing: ['cwebp', 'dwebp'], optional: false, reason: 'tools not installed: cwebp, dwebp' });
  });

  it('runs the row when every tool resolves', () => {
    const plan = planTools(['ffmpeg'], 'clip.mp4->h264', onlyFfmpeg, false);
    expect(plan).toEqual({ ok: true, paths: { ffmpeg: '/usr/bin/ffmpeg' } });
  });

  it('throws a typed error under strict mode, naming the tools and the row', () => {
    const attempt = (): unknown => planTools(['ffmpeg', 'cwebp'], 'photo.jpg->webp', onlyFfmpeg, true);
    expect(attempt).toThrow(MissingToolError);
    expect(attempt).toThrow('ORACLE_STRICT_MODE=1 requires cwebp for photo.jpg->webp');
  });

  it('keeps an optional metric tool a skip even under strict mode', () => {
    const plan = planTools(['ssimulacra2'], 'image ssimulacra2 score', onlyFfmpeg, true, { optional: true });
    expect(plan).toEqual({ ok: false, missing: ['ssimulacra2'], optional: true, reason: 'optional tool not installed: ssimulacra2' });
  });
});

describe('runner against a toolchain with no reference tools', () => {
  let work: string;
  let emptyToolDir: string;

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tools-test-'));
    emptyToolDir = path.join(work, 'no-tools');
    fs.mkdirSync(emptyToolDir);
  });
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  function runRunner(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
    const run = spawnSync(process.execPath, [TSX_CLI, RUNNER, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  function childEnv(strict: boolean): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, BENCH_TOOL_DIRS: emptyToolDir };
    if (strict) env.ORACLE_STRICT_MODE = '1';
    else delete env.ORACLE_STRICT_MODE;
    return env;
  }

  it('skips every row explicitly, lists them, and still writes a valid report', () => {
    const out = path.join(work, 'skip-out');
    const run = runRunner(['--family', 'image,compression', '--no-gate', '--out', out], childEnv(false));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('skipped image/photo-a.jpg->webp/ssim: tools not installed: ffmpeg, cwebp, dwebp');
    expect(run.stdout).toContain('skipped compression/mixed.tar->zst/compression_ratio: tools not installed: zstd, xz, 7z, tar');
    const jsonFiles = fs.readdirSync(out).filter((name) => name.endsWith('.json'));
    expect(jsonFiles).toHaveLength(1);
    const report = validateReport(JSON.parse(fs.readFileSync(path.join(out, jsonFiles[0]), 'utf8')) as unknown);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows.every((row) => row.status === 'skipped')).toBe(true);
    const kinds = new Set(report.rows.map((row) => row.skipKind));
    expect(kinds).toEqual(new Set(['missing-tool', 'optional-tool']));
    const markdown = fs.readFileSync(path.join(out, jsonFiles[0].replace('.json', '.md')), 'utf8');
    expect(markdown).toContain('## Skipped rows');
    expect(markdown).toContain('tools not installed: ffmpeg, cwebp, dwebp');
  }, CHILD_TIMEOUT_MS);

  it('fails the run under ORACLE_STRICT_MODE=1 and names the missing tool', () => {
    const out = path.join(work, 'strict-out');
    const run = runRunner(['--family', 'image', '--no-gate', '--out', out], childEnv(true));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('MissingToolError');
    expect(run.stderr).toContain('ORACLE_STRICT_MODE=1 requires ffmpeg, cwebp, dwebp for photo-a.jpg->webp');
    expect(fs.existsSync(out)).toBe(false);
  }, CHILD_TIMEOUT_MS);

  it('rejects unknown arguments and an unknown family with exit code 2', () => {
    const env = childEnv(false);
    expect(runRunner(['--family', 'sound'], env)).toMatchObject({ status: 2 });
    expect(runRunner(['--bogus'], env).stderr).toContain('unknown argument --bogus');
    expect(runRunner(['--runs', '0'], env).stderr).toContain('--runs must be an integer from 1 to 25');
  }, CHILD_TIMEOUT_MS);

  it('exits non-zero and names the regressed metric when a report is worse than the baseline', () => {
    const row = (ours: number): BenchRow => ({
      id: 'image/photo.jpg->webp/ssim',
      family: 'image',
      case: 'photo.jpg->webp',
      metric: 'ssim',
      unit: 'ratio',
      direction: 'higher',
      kind: 'quality',
      status: 'measured',
      ours,
      reference: 0.96,
      delta: ours - 0.96,
      ratio: null,
      referenceTool: 'cwebp',
      tolerance: { abs: 0.003, rel: 0 },
    });
    const report = (ours: number): BenchReport => ({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: '2026-01-01T00:00:00.000Z',
      strictMode: false,
      families: ['image'],
      host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 1 },
      tools: {},
      settings: { runs: 1, injectedRegression: null },
      rows: [row(ours)],
    });
    const baselineFile = path.join(work, 'baseline.json');
    fs.writeFileSync(baselineFile, JSON.stringify(buildBaseline(report(0.95), null)));
    const equalFile = path.join(work, 'equal.json');
    const worseFile = path.join(work, 'worse.json');
    fs.writeFileSync(equalFile, JSON.stringify(report(0.95)));
    fs.writeFileSync(worseFile, JSON.stringify(report(0.9)));
    const env = childEnv(false);

    const equal = runRunner(['--compare-report', equalFile, '--baseline', baselineFile], env);
    expect(equal.status).toBe(0);
    expect(equal.stdout).toContain('0 regressed');

    const worse = runRunner(['--compare-report', worseFile, '--baseline', baselineFile], env);
    expect(worse.status).toBe(1);
    expect(worse.stdout).toContain('REGRESSION image/photo.jpg->webp/ssim: our value 0.9 is worse than baseline 0.95');
    expect(worse.stdout).toContain('REGRESSION image/photo.jpg->webp/ssim: our delta to the reference tool');
  }, CHILD_TIMEOUT_MS);
});
