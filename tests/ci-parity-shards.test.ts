import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { missingShards, requiredShards } from '../scripts/ci-parity-shards.mjs';

/**
 * A speed shard backs the gap entries of its own family only, so the families of the gap entries a change adds or edits
 * must each have a shard. They are read from the base commit's family map and gap file, never from the change's.
 */

const ROOT = path.resolve(__dirname, '..');
const BASE_MAP = JSON.parse(readFileSync(path.join(ROOT, 'bench', 'family-map.json'), 'utf8')) as unknown;
const gap = (id: string, ratio: number): Record<string, unknown> => ({ id, issue: 695, ratio, note: 'n' });
const gaps = (...entries: Record<string, unknown>[]): { gaps: Record<string, unknown>[] } => ({ gaps: entries });

describe('the families that must have a shard', () => {
  const split = 'pdf-ops/split.pdf->pdf/throughput';
  const avif = 'image/photo-a.jpg->avif/throughput';

  it('are those of the entries that are new or changed, in harness order', () => {
    expect(requiredShards(BASE_MAP, gaps(gap(avif, 0.5)), gaps(gap(avif, 0.5), gap(split, 0.9)))).toEqual(['pdf-ops']);
    expect(requiredShards(BASE_MAP, gaps(gap(avif, 0.5)), gaps(gap(avif, 0.4), gap(split, 0.9)))).toEqual(['image', 'pdf-ops']);
  });

  it('are none when no entry changed, and include a removed entry', () => {
    expect(requiredShards(BASE_MAP, gaps(gap(avif, 0.5)), gaps(gap(avif, 0.5)))).toEqual([]);
    expect(requiredShards(BASE_MAP, gaps(gap(avif, 0.5), gap(split, 0.9)), gaps(gap(avif, 0.5)))).toEqual(['pdf-ops']);
  });

  it('are every family for an entry of a family the base map does not know, and when a gap file cannot be read', () => {
    const every = ['image', 'video', 'audio', 'ocr', 'document', 'compression', 'pdf-ops'];
    expect(requiredShards(BASE_MAP, gaps(), gaps(gap('sound/a/throughput', 0.5)))).toEqual(every);
    expect(requiredShards(BASE_MAP, { gaps: 1 }, gaps())).toEqual(every);
  });

  it('are not narrowed by a map of the change: only the base map is read', () => {
    const narrowed = { ...(BASE_MAP as Record<string, unknown>), rules: [{ families: ['image'], match: '^bench/parity-gaps\\.json$', rows: 'gaps' }] };
    expect(requiredShards(narrowed, gaps(), gaps(gap(split, 0.9)))).toEqual(['pdf-ops']);
  });

  it('name the missing ones against the shards of the run', () => {
    expect(missingShards(['image', 'pdf-ops'], ['image'])).toEqual(['pdf-ops']);
    expect(missingShards(['pdf-ops'], ['image', 'pdf-ops'])).toEqual([]);
    expect(missingShards(['pdf-ops'], [])).toEqual(['pdf-ops']);
  });
});

describe('the command the changes job runs', () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]): string => {
    const run = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args], { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };

  /** A base commit holding the script, the family map and `base` gaps; the working tree then holds `head` gaps. */
  function pullRequest(base: Record<string, unknown>[], head: Record<string, unknown>[]): string {
    const repo = mkdtempSync(path.join(tmpdir(), 'ci-shards-'));
    temps.push(repo);
    mkdirSync(path.join(repo, 'scripts'));
    mkdirSync(path.join(repo, 'bench'));
    for (const file of ['ci-parity-families.mjs', 'ci-parity-shards.mjs']) cpSync(path.join(ROOT, 'scripts', file), path.join(repo, 'scripts', file));
    cpSync(path.join(ROOT, 'bench', 'family-map.json'), path.join(repo, 'bench', 'family-map.json'));
    writeFileSync(path.join(repo, 'bench', 'parity-gaps.json'), JSON.stringify({ schemaVersion: 1, gaps: base }));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const sha = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(path.join(repo, 'bench', 'parity-gaps.json'), JSON.stringify({ schemaVersion: 1, gaps: head }));
    // The change maps every gap entry to the image shard only; the command must not read that.
    writeFileSync(path.join(repo, 'bench', 'family-map.json'), JSON.stringify({ ...(BASE_MAP as Record<string, unknown>), rules: [{ families: ['image'], match: '^bench/parity-gaps\\.json$', rows: 'gaps' }] }));
    return `${repo}\n${sha}`;
  }
  const run = (setup: string, shards: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } => {
    const [repo, sha] = setup.split('\n');
    return spawnSync('node', ['scripts/ci-parity-shards.mjs', shards], { cwd: repo, encoding: 'utf-8', env: { ...process.env, PR_BASE_SHA: sha, ...env } });
  };
  const split = gap('pdf-ops/split.pdf->pdf/throughput', 0.9);

  it('fails with an error annotation when a changed entry has no shard, although the change maps its gap file to another family', () => {
    const result = run(pullRequest([], [split]), 'image');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::bench/parity-gaps.json changes entries of pdf-ops, but no speed shard measures pdf-ops');
  });

  it('passes when every changed entry has its shard, and when no entry changed', () => {
    expect(run(pullRequest([], [split]), 'image,pdf-ops').status).toBe(0);
    expect(run(pullRequest([split], [split]), '').status).toBe(0);
  });

  it('has nothing to compare without a base commit, where every family is measured', () => {
    const [repo] = pullRequest([], [split]).split('\n');
    const result = spawnSync('node', ['scripts/ci-parity-shards.mjs', ''], { cwd: repo, encoding: 'utf-8', env: { ...process.env, PR_BASE_SHA: '' } });
    expect(result.status).toBe(0);
  });

  it('fails on a base commit it cannot read', () => {
    expect(run(pullRequest([], [split]), 'image,pdf-ops', { PR_BASE_SHA: '0'.repeat(40) }).status).toBe(1);
  });
});

describe('the changes job', () => {
  const ci = parse(readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')) as { jobs: Record<string, { steps: { id?: string; name?: string; if?: string; env?: Record<string, string>; run?: string }[] }> };

  it('runs the check after the families are mapped, on the families that step printed', () => {
    const steps = ci.jobs.changes.steps;
    const mapped = steps.findIndex((step) => step.id === 'families');
    const check = steps.findIndex((step) => step.id === 'shards');
    expect(check).toBeGreaterThan(mapped);
    expect(steps[check].env).toMatchObject({ PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}', FAMILIES: '${{ steps.families.outputs.families }}' });
    expect(steps[check].run).toContain('node scripts/ci-parity-shards.mjs "$FAMILIES"');
    expect(steps[check].if).toContain("github.event_name == 'pull_request'");
  });
});
