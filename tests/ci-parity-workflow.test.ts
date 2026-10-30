import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { FAMILIES } from '../bench/report';
import { skipUnless } from './helpers/strict-skip';

/**
 * Wiring of the reference-parity jobs, read from the YAML, and the two shell steps that decide what they do: the step
 * that maps changed paths to benchmark families (run against real git repositories) and the `verify` gate (run
 * against result sets). The rules are written out here: parity-quality runs on a pull request when a conversion family
 * changed; speed parity is no pull request check and runs nightly on main; nothing about speed is ever cached.
 */

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  uses?: string;
  needs?: string | string[];
  if?: string;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const ROOT = path.resolve(__dirname, '..');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf-8');
const ci = parse(read('.github', 'workflows', 'ci.yml')) as Workflow;
const nightly = parse(read('.github', 'workflows', 'nightly.yml')) as Workflow;
const automergeText = read('.github', 'workflows', 'automerge.yml');
const automerge = parse(automergeText) as Workflow;

const stepNamed = (job: Job, name: string): Step => {
  const found = job.steps.find((step) => step.name === name || step.id === name);
  if (!found) throw new Error(`no step ${name}`);
  return found;
};
const runOf = (job: Job, name: string): string => {
  const run = stepNamed(job, name).run;
  if (!run) throw new Error(`step ${name} has no run`);
  return run;
};

const quality = ci.jobs['parity-quality'];

describe('the trigger', () => {
  it('runs once per head commit: no label event starts the pull request workflow', () => {
    const types = (ci.on.pull_request as { types: string[] }).types;
    expect(types).toEqual(['opened', 'synchronize', 'reopened']);
  });

  it('measures speed in no pull request workflow', () => {
    const timing = Object.entries(ci.jobs).flatMap(([name, job]) => (job.steps ?? []).filter((step) => (step.run ?? '').includes('--speed-only')).map((step) => `${name}: ${step.name}`));
    expect(timing).toEqual([]);
    expect(Object.keys(ci.jobs).filter((name) => name.includes('speed'))).toEqual([]);
  });
});

describe('parity-quality', () => {
  it('waits for the change filter and the libvips build, and runs only when a conversion family changed', () => {
    expect(quality.needs).toEqual(['changes', 'sharp-libvips']);
    expect(quality.if).toBe("needs.changes.outputs.bench_changed == 'true'");
  });

  it('measures the quality rows of the changed families on the quick subset, in strict oracle mode', () => {
    expect(quality.env?.ORACLE_STRICT_MODE).toBe('1');
    expect(quality.env?.BENCH_FAMILIES).toBe('${{ needs.changes.outputs.bench_families }}');
    expect(runOf(quality, 'bench')).toContain('npm run bench:quality -- --parity --quality-only --quick --family "$BENCH_FAMILIES"');
    expect(runOf(quality, 'bench')).not.toContain('--speed-only');
  });

  it('measures with the heap bound the service runs with, so a photograph is encoded on the threads the worker leases', () => {
    expect(quality.env?.MALLOC_ARENA_MAX).toBe('2');
  });

  it('backs the quality entries a change adds or edits with the gap file and the baseline of the first parent of the tested merge', () => {
    const base = stepNamed(quality, 'base');
    expect(base.run).toContain("git cat-file -p HEAD | sed -n 's/^parent //p'");
    expect(base.run).toContain('git show "$parent:bench/parity-gaps.json" > ab-base-files/parity-gaps.json');
    expect(base.run).toContain('git show "$parent:bench/baseline.json" > ab-base-files/baseline.json');
    expect(base.env?.EVENT_BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}');
    expect(runOf(quality, 'bench')).toContain('--base-gaps ab-base-files/parity-gaps.json --base-baseline ab-base-files/baseline.json');
    // Read before the measurement, from git alone: no checkout of the base and no dependency of it.
    expect(quality.steps.findIndex((s) => s.id === 'base')).toBeLessThan(quality.steps.findIndex((s) => s.id === 'bench'));
  });

  it('fails a change to a family without bench rows with the instruction to add them', () => {
    const step = stepNamed(quality, 'Require bench rows for every changed conversion family');
    expect(step.if).toBe("env.BENCH_UNMAPPED != ''");
    expect(step.run).toContain('::error::add reference-compared bench rows for $family');
    expect(step.run).toContain('exit 1');
    expect(quality.env?.BENCH_UNMAPPED).toBe('${{ needs.changes.outputs.bench_unmapped }}');
    // It comes first after the checkout, before any install.
    expect(quality.steps.findIndex((s) => s.name === step.name)).toBeLessThan(quality.steps.findIndex((s) => s.name === 'Install dependencies'));
  });

  it('reads the reference cache without writing it: a pull request cannot save into the cache main uses', () => {
    const uses = quality.steps.map((step) => step.uses ?? '');
    expect(uses).toContain('./.github/actions/bench-ref-cache');
    expect(uses.some((u) => /^actions\/cache(\/save)?@/.test(u))).toBe(false);
    const restore = quality.steps.find((step) => step.uses === './.github/actions/bench-ref-cache');
    expect(restore?.with?.fingerprint).toBe('${{ steps.tools.outputs.fingerprint }}');
    const action = parse(read('.github', 'actions', 'bench-ref-cache', 'action.yml')) as { runs: { steps: Step[] } };
    expect(action.runs.steps.length).toBeGreaterThan(0);
    for (const step of action.runs.steps) {
      expect(step.uses).toMatch(/^actions\/cache\/restore@[0-9a-f]{40}$/);
      expect(step.with?.path).toBe('.bench-cache');
      expect(String(step.with?.key)).toContain('inputs.fingerprint');
      expect(String(step.with?.key)).toContain("hashFiles('bench/corpus/manifest.json', 'bench/corpus/remote-manifest.json')");
      expect(String(step.with?.['restore-keys'])).toContain('inputs.fingerprint');
    }
  });

  it('records the benchmark exit code and lets the policy step decide, so one step owns the verdict', () => {
    const bench = runOf(quality, 'bench');
    expect(bench).toContain('set +e');
    expect(bench).toContain('exit 0');
    const policy = quality.steps.find((step) => step.uses?.startsWith('actions/github-script@'));
    expect(policy?.if).toBeUndefined();
    expect(String(policy?.with?.script)).toContain("scope: 'quality'");
    expect(String(policy?.with?.script)).toContain('applyParityVerdict');
    expect(String(policy?.with?.script)).toContain('bench-results/parity-verdict.json');
  });

  it('may comment and open issues, and may read the repository', () => {
    expect(quality.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'write' });
    expect(ci.permissions).toEqual({ contents: 'read' });
  });
});

describe('what the parity jobs add to the actions in use', () => {
  it('pins every action by a full commit SHA with its version in a comment', () => {
    const text = read('.github', 'workflows', 'ci.yml');
    const added = ['parity-quality'].flatMap((name) => ci.jobs[name].steps.map((step) => step.uses).filter((u): u is string => typeof u === 'string' && !u.startsWith('./')));
    expect(added.length).toBeGreaterThan(3);
    for (const uses of added) {
      expect(uses, uses).toMatch(/^[\w./-]+@[0-9a-f]{40}$/);
      expect(text).toMatch(new RegExp(`uses: ${uses.replace(/[/.]/g, '\\$&')} # v\\d+(\\.\\d+)*`));
    }
  });
});

/** The families whose public samples the cache action restores: the four of phase 1 and the eight of phase 2 of #733. */
const SAMPLE_FAMILIES = ['image', 'video', 'audio', 'compression', 'document', 'pdf-ops', 'ebook', 'font', 'cad', 'raw', 'vector', 'data'];

describe('the public benchmark samples in the workflows', () => {
  const action = parse(read('.github', 'actions', 'bench-corpora', 'action.yml')) as { runs: { steps: Step[] } };
  const nightlyQuality = nightly.jobs['bench-parity-quality'];
  const nightlySpeed = nightly.jobs['bench-parity-speed'];

  it('restores one directory per family, from the newest cache of the manifest digest, and only for the families a job names', () => {
    expect(action.runs.steps.map((step) => step.with?.path)).toEqual(SAMPLE_FAMILIES.map((family) => `.bench-corpora/${family}`));
    for (const step of action.runs.steps) {
      expect(String(step.with?.key)).toContain("hashFiles('bench/corpus/remote-manifest.json')");
      expect(String(step.with?.['restore-keys'])).toContain("hashFiles('bench/corpus/remote-manifest.json')");
      expect(step.uses).toMatch(/^actions\/cache\/restore@[0-9a-f]{40}$/);
    }
    expect(action.runs.steps.map((step) => step.if)).toEqual(SAMPLE_FAMILIES.map((family) => `contains(format(',{0},', inputs.families), ',${family},')`));
  });

  it('is saved by the nightly parity jobs even when they fail, under a key of its own for each run, attempt and job', () => {
    const save = parse(read('.github', 'actions', 'bench-corpora-save', 'action.yml')) as { runs: { steps: Step[] } };
    expect(save.runs.steps.map((step) => step.with?.path)).toEqual(SAMPLE_FAMILIES.map((family) => `.bench-corpora/${family}`));
    const restorePrefix = (family: string): string => String(action.runs.steps.find((step) => step.with?.path === `.bench-corpora/${family}`)?.with?.['restore-keys']).trim();
    for (const [index, step] of save.runs.steps.entries()) {
      expect(step.uses).toMatch(/^actions\/cache\/save@[0-9a-f]{40}$/);
      // The restore reads by prefix, so the extra tokens of the save key must come after the family and the manifest digest.
      expect(String(step.with?.key).startsWith(restorePrefix(SAMPLE_FAMILIES[index]))).toBe(true);
      expect(String(step.with?.key)).toMatch(/-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ github\.job \}\}$/);
      expect(String(step.if)).toMatch(/^always\(\) && contains\(/);
    }
    for (const [job, families] of [
      [nightly.jobs['bench-parity-quality'], '${{ matrix.families }}'],
      [nightly.jobs['bench-parity-speed'], SAMPLE_FAMILIES.join(',')],
    ] as const) {
      const saved = job.steps.find((step) => step.uses === './.github/actions/bench-corpora-save');
      expect(saved?.if).toBe('always()');
      expect(saved?.with?.families).toBe(families);
      expect(job.steps.indexOf(saved as Step)).toBeGreaterThan(job.steps.findIndex((step) => step.uses === './.github/actions/bench-corpora'));
    }
  });

  it('is restored before the quick quality run, for the families of the change', () => {
    const restore = quality.steps.find((step) => step.uses === './.github/actions/bench-corpora');
    expect(restore?.with?.families).toBe('${{ env.BENCH_FAMILIES }}');
    expect(quality.steps.indexOf(restore as Step)).toBeLessThan(quality.steps.indexOf(stepNamed(quality, 'bench')));
  });

  it('is left out of the speed comparison with another commit, which times the generated corpus only', () => {
    const ab = nightly.jobs['bench-ab-speed'];
    expect(stepNamed(ab, 'Measure the speed rows against that commit').env?.BENCH_CORPUS_TIER).toBe('pr');
  });

  it('is restored by the nightly parity jobs, which stay in the full tier, while the plain baseline run keeps to the generated corpus', () => {
    for (const [job, families] of [
      [nightlyQuality, '${{ matrix.families }}'],
      [nightlySpeed, SAMPLE_FAMILIES.join(',')],
    ] as const) {
      const restore = job.steps.find((step) => step.uses === './.github/actions/bench-corpora');
      expect(restore?.with?.families).toBe(families);
      expect(job.env?.BENCH_CORPUS_TIER).toBeUndefined();
    }
    const plain = nightly.jobs.bench;
    expect(plain.steps.some((step) => step.uses === './.github/actions/bench-corpora')).toBe(false);
    expect(stepNamed(plain, 'Run the quality benchmark').env?.BENCH_CORPUS_TIER).toBe('pr');
    expect(plain['timeout-minutes']).toBe(45);
  });
});

describe('verify', () => {
  it('waits for the quality job and runs whatever its result, and reads no label', () => {
    expect([...(ci.jobs.verify.needs as string[])]).toContain('parity-quality');
    expect(ci.jobs.verify.if).toBe('always()');
    const env = stepNamed(ci.jobs.verify, 'Require every job to pass, or to be skipped for a documentation-only change').env;
    expect(env?.BENCH_CHANGED).toBe('${{ needs.changes.outputs.bench_changed }}');
    expect(env?.PARITY_QUALITY_RESULT).toBe('${{ needs.parity-quality.result }}');
    expect(JSON.stringify(ci.jobs.verify)).not.toContain('labels');
  });
});

describe('the verify gate with the quality job', () => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
  const script = runOf(ci.jobs.verify, 'Require every job to pass, or to be skipped for a documentation-only change');

  interface Situation {
    event?: string;
    code?: string;
    benchChanged: string;
    quality: string;
    changes?: string;
  }
  function gate(situation: Situation): number {
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        EVENT_NAME: situation.event ?? 'pull_request',
        CODE_CHANGED: situation.code ?? 'true',
        BENCH_CHANGED: situation.benchChanged,
        CHANGES_RESULT: situation.changes ?? 'success',
        SHARP_LIBVIPS_RESULT: 'success',
        CHECKS_RESULT: situation.code === 'false' ? 'skipped' : 'success',
        TESTS_RESULT: situation.code === 'false' ? 'skipped' : 'success',
        CONFORMANCE_RESULT: situation.code === 'false' ? 'skipped' : 'success',
        INTEGRATION_RESULT: situation.code === 'false' ? 'skipped' : 'success',
        CONTAINER_RESULT: 'success',
        PARITY_QUALITY_RESULT: situation.quality,
      },
    });
    return result.status ?? -1;
  }
  const only = it.skipIf(skipUnless('bash', bash.status === 0));

  only('passes a change that touches no conversion family, with quality skipped', () => {
    expect(gate({ benchChanged: 'false', quality: 'skipped' })).toBe(0);
    expect(gate({ code: 'false', benchChanged: 'false', quality: 'skipped' })).toBe(0);
  });

  only('passes a conversion change once quality parity succeeded', () => {
    expect(gate({ benchChanged: 'true', quality: 'success' })).toBe(0);
  });

  only('fails a conversion change whose quality job failed, was cancelled, or was skipped', () => {
    for (const result of ['failure', 'cancelled', 'skipped']) expect(gate({ benchChanged: 'true', quality: result }), result).toBe(1);
  });

  only('fails when parity quality ran although no conversion family changed', () => {
    expect(gate({ benchChanged: 'false', quality: 'success' })).toBe(1);
  });

  only('expects no parity job on a push to main, and fails if one ran', () => {
    expect(gate({ event: 'push', benchChanged: 'false', quality: 'skipped' })).toBe(0);
    expect(gate({ event: 'push', benchChanged: 'false', quality: 'success' })).toBe(1);
  });

  only('fails when the change filter itself failed', () => {
    expect(gate({ changes: 'failure', benchChanged: '', quality: 'skipped' })).toBe(1);
  });
});

describe('the step that maps changed paths to families', () => {
  const git = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
  const node = spawnSync('node', ['--version'], { encoding: 'utf-8' });
  const available = git.status === 0 && bash.status === 0 && node.status === 0;
  const script = runOf(ci.jobs.changes, 'families');
  const stepEnv = stepNamed(ci.jobs.changes, 'families').env ?? {};
  const temps: string[] = [];
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  function sh(command: string, args: string[], cwd: string, env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(command, args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...env } });
    return { status: result.status ?? -1, stdout: result.stdout.trim(), stderr: result.stderr };
  }

  /**
   * A pull request that adds `files` to a base commit that already holds the mapper; returns the step's outputs. With
   * `laterMain`, main gets a commit of those files after the pull request was cut, and the event names that commit as the
   * base: the merge under test was still made with the older one.
   */
  function outputs(files: string[], options: { event?: string; baseSha?: string | null; laterMain?: string[] } = {}): { status: number; outputs: Record<string, string> } {
    const origin = mkdtempSync(path.join(tmpdir(), 'ci-families-origin-'));
    const checkout = mkdtempSync(path.join(tmpdir(), 'ci-families-checkout-'));
    temps.push(origin, checkout);
    const identity = ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid'];
    sh('git', ['init', '-q', '-b', 'main'], origin);
    sh('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], origin);
    mkdirSync(path.join(origin, 'scripts'), { recursive: true });
    mkdirSync(path.join(origin, 'bench'), { recursive: true });
    cpSync(path.join(ROOT, 'scripts', 'ci-parity-families.mjs'), path.join(origin, 'scripts', 'ci-parity-families.mjs'));
    cpSync(path.join(ROOT, 'bench', 'family-map.json'), path.join(origin, 'bench', 'family-map.json'));
    writeFileSync(path.join(origin, 'README.md'), 'base\n');
    sh('git', ['add', '.'], origin);
    sh('git', [...identity, 'commit', '-q', '-m', 'base'], origin);
    const baseSha = sh('git', ['rev-parse', 'HEAD'], origin).stdout;
    sh('git', ['clone', '-q', origin, checkout], origin);
    for (const file of files) {
      mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
      writeFileSync(path.join(checkout, file), `${file}\n`);
    }
    if (files.length > 0) {
      sh('git', ['add', '.'], checkout);
      sh('git', [...identity, 'commit', '-q', '-m', 'change'], checkout);
    }
    const output = path.join(checkout, 'github-output.txt');
    writeFileSync(output, '');
    let eventBase = baseSha;
    if (options.laterMain) {
      for (const file of options.laterMain) {
        mkdirSync(path.dirname(path.join(origin, file)), { recursive: true });
        writeFileSync(path.join(origin, file), `${file}\n`);
      }
      sh('git', ['add', '.'], origin);
      sh('git', [...identity, 'commit', '-q', '-m', 'later main'], origin);
      eventBase = sh('git', ['rev-parse', 'HEAD'], origin).stdout;
    }
    const base = options.baseSha === undefined ? eventBase : (options.baseSha ?? '');
    const result = sh('bash', ['-eo', 'pipefail', '-c', script], checkout, { ...stepEnv, EVENT_NAME: options.event ?? 'pull_request', PR_BASE_SHA: base, GITHUB_OUTPUT: output });
    const parsed = Object.fromEntries(
      readFileSync(output, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
    return { status: result.status, outputs: parsed };
  }
  const only = it.skipIf(skipUnless('git, bash and node', available));

  only('measures the family of a changed conversion file, and nothing for a change outside the conversion code', () => {
    expect(outputs(['src/lib/conversions/zstd-encoder.ts']).outputs).toEqual({ families: 'compression', unmapped: '', changed: 'true' });
    expect(outputs(['src/lib/conversions/image.ts', 'src/lib/conversions/media-encoder.ts']).outputs).toEqual({ families: 'image,video,raw', unmapped: '', changed: 'true' });
    expect(outputs(['src/app/page.tsx', 'docs/guide.md', 'tests/a.test.ts']).outputs).toEqual({ families: '', unmapped: '', changed: 'false' });
  });

  only('reports a changed family with no bench rows, so the parity jobs can fail it', () => {
    expect(outputs(['src/lib/conversions/openexr-decode.ts']).outputs).toEqual({ families: '', unmapped: 'hdr-image', changed: 'true' });
    expect(outputs(['src/lib/conversions/openexr-decode.ts', 'src/lib/conversions/ocr.ts']).outputs).toEqual({ families: 'ocr', unmapped: 'hdr-image', changed: 'true' });
  });

  only('measures every family when the dispatcher changes', () => {
    expect(outputs(['src/lib/conversions/dispatch.ts']).outputs.families).toBe('image,video,audio,ocr,document,compression,pdf-ops,data,ebook,font,cad,raw,vector');
  });

  only('fails the job on a conversion file that no rule classifies', () => {
    expect(outputs(['src/lib/conversions/brand-new-engine.ts']).status).not.toBe(0);
  });

  only('compares with the first parent of the tested merge, not with a later main the event names', () => {
    expect(outputs(['src/lib/conversions/zstd-encoder.ts'], { laterMain: ['src/lib/conversions/dispatch.ts'] }).outputs).toEqual({ families: 'compression', unmapped: '', changed: 'true' });
  });

  only('fails open without a comparable base commit, and has nothing to say for a push', () => {
    expect(outputs([], { baseSha: null }).outputs).toEqual({ families: 'image,video,audio,ocr,document,compression,pdf-ops,data,ebook,font,cad,raw,vector', unmapped: '', changed: 'true' });
    expect(outputs(['src/lib/conversions/zstd.ts'], { event: 'push' }).outputs).toEqual({ families: '', unmapped: '', changed: 'false' });
  });

  it('is exposed as outputs of the changes job', () => {
    expect(ci.jobs.changes.outputs).toMatchObject({
      bench_families: '${{ steps.families.outputs.families }}',
      bench_unmapped: '${{ steps.families.outputs.unmapped }}',
      bench_changed: '${{ steps.families.outputs.changed }}',
    });
  });
});

describe('the automerge workflow', () => {
  it('leaves the gate to verify: it never merges directly, only arms squash auto-merge', () => {
    const merges = Object.values(automerge.jobs)
      .flatMap((job) => job.steps.map((step) => step.run ?? ''))
      .flatMap((run) => run.match(/gh pr merge.*/g) ?? []);
    expect(merges).toHaveLength(2);
    expect(merges.every((command) => /--auto|--disable-auto/.test(command))).toBe(true);
    expect(automergeText).toContain('Speed parity is not a merge requirement');
  });

  it('is armed by the automerge label, which starts no check run of its own', () => {
    const labelsIn = (condition: string): string[] => [...new Set([...condition.matchAll(/'(automerge|security)'/g)].map((match) => match[1]))];
    expect(labelsIn(String(automerge.jobs.enable.if))).toEqual(['automerge']);
    expect((ci.on.pull_request as { types: string[] }).types).not.toContain('labeled');
  });
});

describe('the PDF text worker bundle in the nightly speed jobs', () => {
  it('is built before the speed rows are timed, for the commit under test and for the commit to compare with', () => {
    const jobs: Array<[string, string]> = [
      ['bench-parity-speed', 'Run the speed parity benchmark'],
      ['bench-ab-speed', 'Measure the speed rows against that commit'],
    ];
    for (const [name, measure] of jobs) {
      const job = nightly.jobs[name];
      const build = job.steps.findIndex((step) => step.run === 'npm run build:pdf-text-worker');
      expect(build, name).toBeGreaterThan(job.steps.findIndex((step) => step.run === 'npm ci --ignore-scripts'));
      expect(build, name).toBeLessThan(job.steps.findIndex((step) => step.name === measure));
    }
    const compare = nightly.jobs['bench-ab-speed'];
    const base = compare.steps.findIndex((step) => (step.run ?? '').includes('(cd ab-base && npm run build:pdf-text-worker)'));
    expect(base).toBeGreaterThan(compare.steps.findIndex((step) => step.name === 'Check out the commit to compare with'));
    expect(base).toBeLessThan(compare.steps.findIndex((step) => step.name === 'Measure the speed rows against that commit'));
  });
});

describe('the nightly run', () => {
  const quality = nightly.jobs['bench-parity-quality'];
  const speedJob = nightly.jobs['bench-parity-speed'];

  it('runs the full parity benchmark in strict mode: every family, every case', () => {
    const q = stepNamed(quality, 'Run the quality parity benchmark');
    const s = stepNamed(speedJob, 'Run the speed parity benchmark');
    // The quality half is sharded by family group (below); the shards together measure every family.
    expect(q.run).toBe('npm run bench:quality -- --parity --quality-only --family "$BENCH_FAMILIES"');
    expect(q.env?.BENCH_FAMILIES).toBe('${{ matrix.families }}');
    expect(s.run).toBe('npm run bench:quality -- --parity --speed-only');
    for (const step of [q, s]) {
      expect(step.env?.ORACLE_STRICT_MODE).toBe('1');
      expect(step.run).not.toContain('--quick');
    }
    expect(s.run).not.toContain('--family');
  });

  it('measures quality with the heap bound the service runs with, as the speed jobs do', () => {
    expect(stepNamed(quality, 'Run the quality parity benchmark').env?.MALLOC_ARENA_MAX).toBe('2');
  });

  describe('the quality half, sharded by family group', () => {
    const matrix = (quality as unknown as { strategy: { 'fail-fast': boolean; matrix: { include: Array<{ group: string; families: string }> } } }).strategy;
    const groups = matrix.matrix.include;

    it('keeps the job name the report job and the artifacts are keyed by, with one shard per group', () => {
      expect(matrix['fail-fast']).toBe(false);
      expect((quality as unknown as { name: string }).name).toBe('bench-parity-quality (${{ matrix.group }})');
      expect(new Set(groups.map((entry) => entry.group)).size).toBe(groups.length);
      expect(quality['timeout-minutes']).toBeLessThanOrEqual(60);
    });

    it('measures every benchmark family in exactly one shard', () => {
      const measured = groups.flatMap((entry) => entry.families.split(','));
      expect([...measured].sort()).toEqual([...FAMILIES].sort());
    });

    it('puts no more than one of the heavy families in a shard', () => {
      for (const entry of groups) {
        const heavy = entry.families.split(',').filter((family) => ['image', 'video', 'raw', 'document', 'compression'].includes(family));
        expect(heavy.length, entry.group).toBeLessThanOrEqual(1);
      }
    });

    it('uploads the report of each shard under a name of its own, since an artifact name can be used once per run', () => {
      const upload = quality.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
      expect(upload?.with?.name).toBe('bench-quality-results-${{ matrix.group }}');
      expect(upload?.if).toBe('always()');
    });

    it('saves the reference measurements of a shard under the key of its group, and the pull request job restores every group', () => {
      const save = quality.steps.find((step) => step.uses?.startsWith('actions/cache/save@'));
      expect(String(save?.with?.key)).toContain('-${{ matrix.group }}-');
      const action = parse(read('.github', 'actions', 'bench-ref-cache', 'action.yml')) as { runs: { steps: Step[] } };
      const [newest, ...perGroup] = action.runs.steps;
      expect(String(newest.with?.['restore-keys'])).toMatch(/inputs\.fingerprint \}\}-\s*$/);
      const restored = perGroup.map((step) => /inputs\.fingerprint \}\}-([a-z-]+)-\$\{\{ hashFiles/.exec(String(step.with?.key))?.[1]);
      expect(restored).toEqual(groups.map((entry) => entry.group));
      for (const entry of groups) {
        const step = perGroup[groups.indexOf(entry)];
        expect(String(step.with?.['restore-keys'])).toContain(`inputs.fingerprint }}-${entry.group}-`);
      }
    });
  });

  it('can measure the speed rows against another commit in the same pairs, by hand, one shard per family', () => {
    const inputs = (nightly.on as { workflow_dispatch?: { inputs?: Record<string, { default?: string }> } }).workflow_dispatch?.inputs;
    expect(Object.keys(inputs ?? {})).toEqual(['ab_base_ref', 'ab_repeats']);
    expect(inputs?.ab_base_ref?.default).toBe('');
    expect(speedJob.if).toBe("inputs.ab_base_ref == ''");
    const ab = nightly.jobs['bench-ab-speed'];
    expect(ab.if).toBe("inputs.ab_base_ref != ''");
    expect((ab as unknown as { strategy: { matrix: { family: string[] } } }).strategy.matrix.family).toEqual(['image', 'video', 'audio', 'ocr', 'document', 'compression', 'pdf-ops', 'data', 'ebook', 'font', 'cad', 'raw', 'vector']);
    expect(stepNamed(ab, 'Check out the commit to compare with').run).toContain('bash scripts/ab-base-dependencies.sh false');
    const measure = stepNamed(ab, 'Measure the speed rows against that commit');
    expect(measure.env).toMatchObject({ ORACLE_STRICT_MODE: '1', BENCH_BASE_ROOT: 'ab-base', FAMILY: '${{ matrix.family }}' });
    expect(measure.run).toContain('--parity --speed-only --family "$FAMILY"');
  });

  it('is the writer of the reference cache, saved even when the benchmark fails', () => {
    const restore = quality.steps.find((step) => step.uses?.startsWith('actions/cache/restore@'));
    const save = quality.steps.find((step) => step.uses?.startsWith('actions/cache/save@'));
    expect(String(restore?.with?.key)).toContain('${{ matrix.group }}');
    expect(restore?.with?.path).toBe('.bench-cache');
    expect(save?.with?.path).toBe('.bench-cache');
    expect(save?.if).toBe('always()');
    expect(String(save?.with?.key)).toContain('github.run_id');
    expect(String(save?.with?.key)).toContain("hashFiles('bench/corpus/manifest.json', 'bench/corpus/remote-manifest.json')");
    expect(JSON.stringify(speedJob)).not.toMatch(/actions\/cache|\.bench-cache/);
  });

  it('keeps timing on a runner of its own, away from the quality measurements', () => {
    expect(speedJob.steps.some((step) => /--quality-only/.test(step.run ?? ''))).toBe(false);
    expect(quality.steps.some((step) => /--speed-only/.test(step.run ?? ''))).toBe(false);
  });

  it('keeps the measured speed ratios as an artifact and lists what a refresh from them would change', () => {
    const upload = speedJob.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toBe('bench-speed-results');
    expect(upload?.with?.path).toBe('bench-results/');
    expect(upload?.if).toBe('always()');
    const dryRun = stepNamed(speedJob, 'Show what refreshing the recorded speed ratios would change');
    expect(dryRun.if).toBe('always()');
    expect((dryRun as { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true);
    expect(dryRun.run).toContain('bench/refresh-speed.ts bench-results');
    expect(dryRun.run).not.toContain('--write');
    expect(speedJob.steps.indexOf(dryRun)).toBeLessThan(speedJob.steps.indexOf(upload as Step));
  });

  it('reports a failing night through the existing nightly-regression issue', () => {
    const report = nightly.jobs.report;
    expect([...(report.needs as string[])]).toEqual(expect.arrayContaining(['bench', 'bench-parity-quality', 'bench-parity-speed']));
    expect(report.if).toBe("always() && contains(needs.*.result, 'failure')");
    expect(report.uses).toBe('./.github/workflows/report-failure.yml');
    const reusable = parse(read('.github', 'workflows', 'report-failure.yml')) as { jobs: { report: { steps: Step[] } } };
    expect(String(reusable.jobs.report.steps[0].with?.script)).toContain("const label = 'nightly-regression'");
  });
});
