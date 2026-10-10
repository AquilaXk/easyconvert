import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { skipUnless } from './helpers/strict-skip';

/**
 * Wiring of the reference-parity jobs, read from the YAML, and the two shell steps that decide what they do: the step
 * that maps changed paths to benchmark families (run against real git repositories) and the `verify` gate (run
 * against result sets). The rules are written out here: parity-quality runs when a conversion family changed;
 * parity-speed runs when the automerge label is on or nothing needs measuring; a skipped parity-speed with a conversion
 * family changed is not yet satisfied; nothing about speed is ever cached.
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
const speed = ci.jobs['parity-speed'];

describe('the trigger', () => {
  it('re-runs the workflow when a label is added or removed, and on the events it already ran on', () => {
    const types = (ci.on.pull_request as { types: string[] }).types;
    expect(types).toEqual(expect.arrayContaining(['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']));
    expect(types).toHaveLength(5);
  });

  it('cancels a superseded run, so a label added mid-run restarts the checks on the same head', () => {
    expect((ci as unknown as { concurrency: { 'cancel-in-progress': string } }).concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });
});

describe('parity-quality', () => {
  it('waits for the change filter and runs only when a conversion family changed', () => {
    expect(quality.needs).toBe('changes');
    expect(quality.if).toBe("needs.changes.outputs.bench_changed == 'true'");
  });

  it('measures the quality rows of the changed families on the quick subset, in strict oracle mode', () => {
    expect(quality.env?.ORACLE_STRICT_MODE).toBe('1');
    expect(quality.env?.BENCH_FAMILIES).toBe('${{ needs.changes.outputs.bench_families }}');
    expect(runOf(quality, 'bench')).toContain('npm run bench:quality -- --parity --quality-only --quick --family "$BENCH_FAMILIES"');
    expect(runOf(quality, 'bench')).not.toContain('--speed-only');
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
    expect(uses.some((u) => u.startsWith('actions/cache/restore@'))).toBe(true);
    expect(uses.some((u) => /^actions\/cache(\/save)?@/.test(u))).toBe(false);
    const restore = quality.steps.find((step) => step.uses?.startsWith('actions/cache/restore@'));
    const key = String(restore?.with?.key);
    expect(restore?.with?.path).toBe('.bench-cache');
    expect(key).toContain('steps.tools.outputs.fingerprint');
    expect(key).toContain("hashFiles('bench/corpus/manifest.json')");
    expect(String(restore?.with?.['restore-keys'])).toContain('steps.tools.outputs.fingerprint');
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

describe('parity-speed', () => {
  it('runs on a pull request when the automerge label is on, or when nothing needs measuring', () => {
    expect(speed.needs).toBe('changes');
    const condition = String(speed.if).replace(/\s+/g, ' ').trim();
    expect(condition).toBe("github.event_name == 'pull_request' && (needs.changes.outputs.bench_changed != 'true' || contains(github.event.pull_request.labels.*.name, 'automerge'))");
  });

  it('says what it is waiting for when there is nothing to measure, and does no other work then', () => {
    const say = stepNamed(speed, 'Say that there is nothing to measure');
    expect(say.if).toBe("env.BENCH_CHANGED != 'true'");
    expect(say.run).toContain('speed parity runs when the automerge label is added');
    for (const step of speed.steps.filter((s) => s !== say && s.name !== 'Require bench rows for every changed conversion family')) {
      expect(String(step.if), step.name).toMatch(/env\.BENCH_CHANGED == 'true'/);
    }
  });

  it('measures the pull request against its base in the same pairs: the base is checked out beside it, with this checkout\'s dependencies', () => {
    const checkout = speed.steps.find((s) => s.name === 'Check out the base of the pull request');
    expect(checkout?.uses).toMatch(/^actions\/checkout@/);
    expect(checkout?.with).toMatchObject({ ref: '${{ github.event.pull_request.base.sha }}', path: 'ab-base' });
    expect(speed.steps.find((s) => s.name === 'Link its dependencies')?.run).toBe('ln -s "$PWD/node_modules" ab-base/node_modules');
    expect(speed.steps.find((s) => s.id === 'bench')?.env?.BENCH_BASE_ROOT).toBe('ab-base');
    expect(speed['timeout-minutes']).toBe(60);
    for (const name of ['Check out the base of the pull request', 'Link its dependencies']) {
      expect(String(speed.steps.find((s) => s.name === name)?.if)).toMatch(/env\.BENCH_CHANGED == 'true'/);
    }
  });

  it("checks the gap entries the pull request adds or changes against its own speed run, with the base's gap file", () => {
    const take = speed.steps.find((s) => s.id === 'base-gaps');
    expect(take?.run).toContain('git show "$PR_BASE_SHA:bench/parity-gaps.json"');
    expect(take?.env?.PR_BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}');
    expect(speed.steps.find((s) => s.id === 'bench')?.env?.BASE_GAPS).toBe('${{ steps.base-gaps.outputs.path }}');
    expect(speed.steps.indexOf(take as Step)).toBeLessThan(speed.steps.findIndex((s) => s.id === 'bench'));
  });

  it('measures every case of the changed families, speed only, and never reads or writes a cache', () => {
    const bench = runOf(speed, 'bench');
    expect(bench).toContain('npm run bench:quality -- --parity --speed-only --family "$BENCH_FAMILIES" --base-gaps "$BASE_GAPS"');
    expect(bench).not.toContain('--quick');
    expect(bench).not.toContain('--quality-only');
    expect(JSON.stringify(speed)).not.toMatch(/actions\/cache|\.bench-cache|bench-ref-/);
    expect(speed.env?.ORACLE_STRICT_MODE).toBe('1');
  });

  it('fails a change to a family without bench rows too', () => {
    const step = stepNamed(speed, 'Require bench rows for every changed conversion family');
    expect(step.if).toBe("env.BENCH_UNMAPPED != ''");
    expect(step.run).toContain('::error::add reference-compared bench rows for $family');
  });

  it('applies the same label policy with the speed scope', () => {
    const policy = speed.steps.find((step) => step.uses?.startsWith('actions/github-script@'));
    expect(String(policy?.with?.script)).toContain("scope: 'speed'");
    expect(speed.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'write' });
  });

  it('has room for the heaviest family to reach its cap on pairs', () => {
    expect(speed['timeout-minutes']).toBeGreaterThanOrEqual(30);
    expect(speed['timeout-minutes']).toBeLessThanOrEqual(60);
  });
});

describe('what the parity jobs add to the actions in use', () => {
  it('pins every action by a full commit SHA with its version in a comment', () => {
    const text = read('.github', 'workflows', 'ci.yml');
    const added = ['parity-quality', 'parity-speed'].flatMap((name) => ci.jobs[name].steps.map((step) => step.uses).filter((u): u is string => typeof u === 'string' && !u.startsWith('./')));
    expect(added.length).toBeGreaterThan(5);
    for (const uses of added) {
      expect(uses, uses).toMatch(/^[\w./-]+@[0-9a-f]{40}$/);
      expect(text).toMatch(new RegExp(`uses: ${uses.replace(/[/.]/g, '\\$&')} # v\\d+(\\.\\d+)*`));
    }
  });
});

describe('verify', () => {
  it('waits for both parity jobs and runs whatever their result', () => {
    expect([...(ci.jobs.verify.needs as string[])]).toEqual(expect.arrayContaining(['parity-quality', 'parity-speed']));
    expect(ci.jobs.verify.if).toBe('always()');
  });

  it('reads the label and the verdict of the change filter from the run itself', () => {
    const env = stepNamed(ci.jobs.verify, 'Require every job to pass, or to be skipped for a documentation-only change').env;
    expect(env?.HAS_AUTOMERGE_LABEL).toBe("${{ contains(github.event.pull_request.labels.*.name, 'automerge') }}");
    expect(env?.BENCH_CHANGED).toBe('${{ needs.changes.outputs.bench_changed }}');
    expect(env?.PARITY_SPEED_RESULT).toBe('${{ needs.parity-speed.result }}');
    expect(env?.PARITY_QUALITY_RESULT).toBe('${{ needs.parity-quality.result }}');
  });
});

describe('the verify gate with the parity jobs', () => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
  const script = runOf(ci.jobs.verify, 'Require every job to pass, or to be skipped for a documentation-only change');

  interface Situation {
    event?: string;
    code?: string;
    benchChanged: string;
    label: boolean;
    quality: string;
    speed: string;
    changes?: string;
  }
  function gate(situation: Situation): { status: number; output: string } {
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        EVENT_NAME: situation.event ?? 'pull_request',
        CODE_CHANGED: situation.code ?? 'true',
        BENCH_CHANGED: situation.benchChanged,
        HAS_AUTOMERGE_LABEL: String(situation.label),
        CHANGES_RESULT: situation.changes ?? 'success',
        CHECKS_RESULT: situation.code === 'false' ? 'skipped' : 'success',
        TESTS_RESULT: situation.code === 'false' ? 'skipped' : 'success',
        CONFORMANCE_RESULT: situation.code === 'false' ? 'skipped' : 'success',
        INTEGRATION_RESULT: situation.code === 'false' ? 'skipped' : 'success',
        CONTAINER_RESULT: 'success',
        PARITY_QUALITY_RESULT: situation.quality,
        PARITY_SPEED_RESULT: situation.speed,
      },
    });
    return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
  }
  const only = it.skipIf(skipUnless('bash', bash.status === 0));

  only('passes a change that touches no conversion family: quality skipped, speed says there is nothing to measure', () => {
    expect(gate({ benchChanged: 'false', label: false, quality: 'skipped', speed: 'success' }).status).toBe(0);
    expect(gate({ benchChanged: 'false', label: true, quality: 'skipped', speed: 'success' }).status).toBe(0);
    expect(gate({ code: 'false', benchChanged: 'false', label: false, quality: 'skipped', speed: 'success' }).status).toBe(0);
  });

  only('is not satisfied by a conversion change without the automerge label: speed parity has not run', () => {
    const result = gate({ benchChanged: 'true', label: false, quality: 'success', speed: 'skipped' });
    expect(result.status).toBe(1);
    expect(result.output).toContain('::error::speed parity has not run: add the automerge label');
  });

  only('is not satisfied by a skipped speed job that claims success without the label either', () => {
    expect(gate({ benchChanged: 'true', label: false, quality: 'success', speed: 'success' }).status).toBe(1);
  });

  only('passes a conversion change with the label once both parity jobs succeeded', () => {
    expect(gate({ benchChanged: 'true', label: true, quality: 'success', speed: 'success' }).status).toBe(0);
  });

  only('fails when a parity job failed, was cancelled, or was skipped where it had to run', () => {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(gate({ benchChanged: 'true', label: true, quality: 'success', speed: result }).status, `speed ${result}`).toBe(1);
      expect(gate({ benchChanged: 'true', label: true, quality: result, speed: 'success' }).status, `quality ${result}`).toBe(1);
    }
    expect(gate({ benchChanged: 'false', label: false, quality: 'skipped', speed: 'failure' }).status).toBe(1);
    expect(gate({ benchChanged: 'false', label: false, quality: 'skipped', speed: 'skipped' }).status).toBe(1);
  });

  only('fails when parity quality ran although no conversion family changed', () => {
    expect(gate({ benchChanged: 'false', label: false, quality: 'success', speed: 'success' }).status).toBe(1);
  });

  only('expects no parity job on a push to main, and fails if one ran', () => {
    expect(gate({ event: 'push', benchChanged: 'false', label: false, quality: 'skipped', speed: 'skipped' }).status).toBe(0);
    expect(gate({ event: 'push', benchChanged: 'false', label: false, quality: 'skipped', speed: 'success' }).status).toBe(1);
  });

  only('fails when the change filter itself failed, whatever the parity jobs did', () => {
    expect(gate({ changes: 'failure', benchChanged: '', label: true, quality: 'skipped', speed: 'skipped' }).status).toBe(1);
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

  /** A pull request that adds `files` to a base commit that already holds the mapper; returns the step's outputs. */
  function outputs(files: string[], options: { event?: string; baseSha?: string | null } = {}): { status: number; outputs: Record<string, string> } {
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
    const base = options.baseSha === undefined ? baseSha : (options.baseSha ?? '');
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
    expect(outputs(['src/lib/conversions/image.ts', 'src/lib/conversions/media-encoder.ts']).outputs).toEqual({ families: 'image,video', unmapped: '', changed: 'true' });
    expect(outputs(['src/app/page.tsx', 'docs/guide.md', 'tests/a.test.ts']).outputs).toEqual({ families: '', unmapped: '', changed: 'false' });
  });

  only('reports a changed family with no bench rows, so the parity jobs can fail it', () => {
    expect(outputs(['src/lib/conversions/cad-nurbs.ts']).outputs).toEqual({ families: '', unmapped: 'cad', changed: 'true' });
    expect(outputs(['src/lib/conversions/cad-nurbs.ts', 'src/lib/conversions/font.ts', 'src/lib/conversions/ocr.ts']).outputs).toEqual({ families: 'ocr', unmapped: 'cad,font', changed: 'true' });
  });

  only('measures every family when the dispatcher changes', () => {
    expect(outputs(['src/lib/conversions/dispatch.ts']).outputs.families).toBe('image,video,audio,ocr,document,compression,pdf-ops');
  });

  only('fails the job on a conversion file that no rule classifies', () => {
    expect(outputs(['src/lib/conversions/brand-new-engine.ts']).status).not.toBe(0);
  });

  only('fails open without a comparable base commit, and has nothing to say for a push', () => {
    expect(outputs(['README.md'], { baseSha: null }).outputs).toEqual({ families: 'image,video,audio,ocr,document,compression,pdf-ops', unmapped: '', changed: 'true' });
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
    expect(automergeText).toContain('`verify` fails ("add the automerge label")');
  });

  it('is armed by the same label that starts speed parity', () => {
    const labelsIn = (condition: string): string[] => [...new Set([...condition.matchAll(/'(automerge|security)'/g)].map((match) => match[1]))];
    expect(labelsIn(String(automerge.jobs.enable.if))).toEqual(['automerge']);
    expect(labelsIn(String(speed.if))).toEqual(['automerge']);
  });
});

describe('the nightly run', () => {
  const quality = nightly.jobs['bench-parity-quality'];
  const speedJob = nightly.jobs['bench-parity-speed'];

  it('runs the full parity benchmark in strict mode: every family, every case', () => {
    const q = stepNamed(quality, 'Run the quality parity benchmark');
    const s = stepNamed(speedJob, 'Run the speed parity benchmark');
    expect(q.run).toBe('npm run bench:quality -- --parity --quality-only');
    expect(s.run).toBe('npm run bench:quality -- --parity --speed-only');
    for (const step of [q, s]) {
      expect(step.env?.ORACLE_STRICT_MODE).toBe('1');
      expect(step.run).not.toContain('--quick');
      expect(step.run).not.toContain('--family');
    }
  });

  it('can measure the speed rows against a commit in the same pairs, for the noise of the comparison and for a check of the base', () => {
    const inputs = (nightly.on as { workflow_dispatch?: { inputs?: Record<string, { default?: string }> } }).workflow_dispatch?.inputs;
    expect(inputs?.ab_base_ref?.default).toBe('');
    const checkout = stepNamed(speedJob, 'Check out the commit to compare with');
    expect(checkout.if).toBe("inputs.ab_base_ref != ''");
    expect(checkout.with).toMatchObject({ ref: '${{ inputs.ab_base_ref }}', path: 'ab-base' });
    expect(stepNamed(speedJob, 'Link its dependencies').run).toBe('ln -s "$PWD/node_modules" ab-base/node_modules');
    expect(stepNamed(speedJob, 'Run the speed parity benchmark').env?.BENCH_BASE_ROOT).toBe("${{ inputs.ab_base_ref != '' && 'ab-base' || '' }}");
  });

  it('is the writer of the reference cache, saved even when the benchmark fails', () => {
    const restore = quality.steps.find((step) => step.uses?.startsWith('actions/cache/restore@'));
    const save = quality.steps.find((step) => step.uses?.startsWith('actions/cache/save@'));
    expect(restore?.with?.path).toBe('.bench-cache');
    expect(save?.with?.path).toBe('.bench-cache');
    expect(save?.if).toBe('always()');
    expect(String(save?.with?.key)).toContain('github.run_id');
    expect(String(save?.with?.key)).toContain("hashFiles('bench/corpus/manifest.json')");
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
    expect(String(report.steps[0].with?.script)).toContain("const label = 'nightly-regression'");
  });
});
