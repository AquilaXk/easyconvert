import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { ESTIMATED_MS_PER_JOB, JOB_WORKERS, SHARD_CONVERSION_BUDGET_MINUTES, SHARDS } from '../bench/realworld/regression/schedule';
import { skipUnless } from './helpers/strict-skip';

/**
 * The regression corpus workflow is read as YAML. The schedule, the shard counts, the permissions, the artifact names and the rule
 * that no Actions cache holds the corpus are written out here from the decision of 2026-10-17 (issue #780), not taken from the
 * file under test. The step that plans a run is executed with bash against each trigger.
 */

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  uses?: string;
  needs?: string[];
  if?: string;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> };
  outputs?: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  on: { schedule: Array<{ cron: string }>; workflow_dispatch: { inputs: Record<string, { options?: string[]; default?: string }> } };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const ROOT = path.resolve(__dirname, '..');
const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'regression-corpus.yml'), 'utf-8');
const workflow = parse(text) as Workflow;
const MAX_JOB_TIMEOUT_MINUTES = 60;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MILLISECONDS_PER_MINUTE = 60_000;

const stepsOf = (job: Job): Step[] => job.steps ?? [];
const allSteps = Object.values(workflow.jobs).flatMap(stepsOf);

describe('triggers', () => {
  it('runs the whole corpus on Sunday and a seventh of it on the other six days, at an off-peak minute', () => {
    const crons = workflow.on.schedule.map((entry) => entry.cron);
    expect(crons).toEqual(['17 3 * * 1-6', '17 3 * * 0']);
    expect(workflow.env?.FULL_CRON).toBe('17 3 * * 0');
    for (const cron of crons) {
      const [minute, hour] = cron.split(' ');
      expect(['0', '30']).not.toContain(minute);
      expect(Number(hour)).toBeLessThan(6);
    }
  });

  it('can be started by hand in either mode, with a limit for a trial run', () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.mode.options).toEqual(['nightly', 'full']);
    expect(inputs.limit.default).toBe('');
  });

  it('never queues two runs on top of each other and reads the repository only', () => {
    expect(workflow.concurrency).toEqual({ group: 'regression-corpus', 'cancel-in-progress': false });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const [scope, level] of Object.entries(job.permissions ?? {})) {
        if (name !== 'report') expect(level, `${name}: ${scope}`).not.toBe('write');
      }
    }
  });

  it('reports a failed run through the workflow the nightly run uses, with the same condition and permissions', () => {
    const report = workflow.jobs.report;
    expect(report.uses).toBe('./.github/workflows/report-failure.yml');
    expect([...(report.needs ?? [])].sort()).toEqual(['gate', 'plan', 'shard']);
    expect(report.if).toBe("always() && contains(needs.*.result, 'failure')");
    expect(report.permissions).toEqual({ actions: 'read', contents: 'read', issues: 'write' });
    const nightly = parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'nightly.yml'), 'utf-8')) as Workflow;
    expect(nightly.jobs.report.uses).toBe(report.uses);
    expect(nightly.jobs.report.if).toBe(report.if);
    expect(nightly.jobs.report.permissions).toEqual(report.permissions);
  });
});

describe('shards', () => {
  it('keeps the shard counts of the workflow equal to the ones the sizing uses', () => {
    expect(Number(workflow.env?.FULL_SHARDS)).toBe(SHARDS.full);
    expect(Number(workflow.env?.NIGHTLY_SHARDS)).toBe(SHARDS.nightly);
  });

  it('runs every shard under the job limit, without stopping the others when one fails', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (job.uses !== undefined) continue;
      expect(job['timeout-minutes'], name).toBeGreaterThan(0);
      expect(job['timeout-minutes'], name).toBeLessThanOrEqual(MAX_JOB_TIMEOUT_MINUTES);
    }
    expect(workflow.jobs.shard.strategy?.['fail-fast']).toBe(false);
    expect(workflow.jobs.shard.strategy?.matrix?.shard).toBe('${{ fromJSON(needs.plan.outputs.shards) }}');
  });

  it('estimates a full shard of 20,000 jobs well under the budget that leaves room for set-up, fetching and slow tails', () => {
    const jobsPerShard = Math.ceil(20_000 / SHARDS.full);
    const minutes = (jobsPerShard * ESTIMATED_MS_PER_JOB) / JOB_WORKERS / MILLISECONDS_PER_MINUTE;
    expect(minutes).toBeLessThan(SHARD_CONVERSION_BUDGET_MINUTES);
    expect(SHARD_CONVERSION_BUDGET_MINUTES).toBeLessThanOrEqual(MAX_JOB_TIMEOUT_MINUTES - 20);
  });

  it('passes each shard its mode, date, number and the count, and the limit only when one is given', () => {
    const run = workflow.jobs.shard.steps.find((step) => step.name === 'Run the corpus shard');
    expect(run?.env).toMatchObject({ MODE: '${{ needs.plan.outputs.mode }}', RUN_DATE: '${{ needs.plan.outputs.date }}', SHARD: '${{ matrix.shard }}', SHARDS: '${{ needs.plan.outputs.count }}' });
    expect(run?.run).toContain('npm run bench:regression -- run "${args[@]}"');
    expect(run?.run).toContain('--shard "$SHARD/$SHARDS"');
    expect(run?.run).toContain('if [ -n "$LIMIT" ]; then args+=(--limit "$LIMIT"); fi');
    expect(run?.run).toContain('--cache "$RUNNER_TEMP/regression-corpus"');
  });
});

describe('storage', () => {
  it('uses no Actions cache: the corpus is read by byte range and each file is deleted once it is judged', () => {
    expect(allSteps.filter((step) => String(step.uses).startsWith('actions/cache'))).toEqual([]);
    expect(text).not.toMatch(/actions\/cache|restore-keys|~\/\.cache/);
    const run = workflow.jobs.shard.steps.find((step) => step.name === 'Run the corpus shard');
    expect(run?.run).not.toMatch(/--keep|--no-delete/);
  });

  it('uploads each shard report under its own name and fails if a shard wrote none', () => {
    const upload = workflow.jobs.shard.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('always()');
    expect(upload?.with).toMatchObject({ name: 'regression-shard-${{ matrix.shard }}', path: 'regression-shard-${{ matrix.shard }}.json', 'if-no-files-found': 'error' });
  });

  it('keeps only the result set of a full run as the baseline, for longer than a week', () => {
    const keep = workflow.jobs.gate.steps.find((step) => step.name === 'Keep the result set of a full run as the baseline');
    expect(keep?.if).toContain("needs.plan.outputs.mode == 'full'");
    expect(keep?.with).toMatchObject({ name: 'regression-baseline', path: 'regression-results/corpus.json' });
    expect(Number(keep?.with?.['retention-days'])).toBeGreaterThanOrEqual(30);
    const find = workflow.jobs.gate.steps.find((step) => step.id === 'previous');
    expect(find?.run).toContain('name=regression-baseline');
    expect(find?.run).toContain('head_branch == \\"$BASELINE_BRANCH\\"');
    expect(workflow.env?.BASELINE_BRANCH).toBe('main');
    expect(find?.run).toContain('--name regression-baseline');
  });
});

describe('gate', () => {
  const gate = workflow.jobs.gate;

  it('runs after every shard, whatever their result, and may read the actions of the repository to find the baseline', () => {
    expect(gate.needs).toEqual(['plan', 'shard']);
    expect(gate.if).toBe('always() && needs.plan.result == \'success\'');
    expect(gate.permissions).toEqual({ actions: 'read', contents: 'read' });
  });

  it('merges the shards, compares with the baseline only when one was found, and writes the summary even when the gate fails', () => {
    const merge = gate.steps.find((step) => step.name === 'Merge and gate');
    expect(merge?.run).toContain('npm run bench:regression -- merge "${args[@]}" regression-shards/*.json');
    expect(merge?.run).toContain('if [ "$PREVIOUS_FOUND" = true ]; then args+=(--previous regression-previous/corpus.json); fi');
    const summary = gate.steps.find((step) => step.name === 'Show the corpus report in the run summary');
    expect(summary?.if).toBe('always()');
    expect(summary?.run).toContain('$GITHUB_STEP_SUMMARY');
  });

  it('says so when there is no earlier full run, instead of comparing with nothing', () => {
    const find = gate.steps.find((step) => step.id === 'previous');
    expect(find?.run).toMatch(/the differential judge is skipped for this run/);
  });
});

describe('third-party actions', () => {
  it('are pinned by a full commit SHA with their version in a comment', () => {
    const pinned = text.split('\n').map((line) => line.trim().replace(/^- /, '')).filter((line) => line.startsWith('uses:') && !line.startsWith('uses: ./'));
    expect(pinned.length).toBeGreaterThan(5);
    for (const line of pinned) {
      expect(line).toMatch(/^uses:\s*\S+@[0-9a-f]{40}\s+#\s*v\d+(\.\d+)*\s*$/);
      expect(line.split('@')[1].slice(0, 40)).toMatch(FULL_SHA);
    }
  });
});

describe('plan step', () => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
  const plan = workflow.jobs.plan.steps.find((step) => step.id === 'plan');

  function planFor(event: string, schedule: string, inputMode: string): Record<string, string> {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regression-plan-')), 'output');
    fs.writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', plan?.run ?? 'false'], {
      encoding: 'utf-8',
      env: { ...process.env, FULL_SHARDS: workflow.env?.FULL_SHARDS ?? '', NIGHTLY_SHARDS: workflow.env?.NIGHTLY_SHARDS ?? '', FULL_CRON: workflow.env?.FULL_CRON ?? '', EVENT_NAME: event, SCHEDULE: schedule, INPUT_MODE: inputMode, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(fs.readFileSync(output, 'utf-8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  }

  it.skipIf(skipUnless('bash', bash.status === 0))('plans a full run of sixteen shards for the Sunday schedule', () => {
    const out = planFor('schedule', '17 3 * * 0', '');
    expect(out.mode).toBe('full');
    expect(out.count).toBe('16');
    expect(out.shards).toBe('[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]');
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('plans a night of four shards for the other days', () => {
    const out = planFor('schedule', '17 3 * * 1-6', '');
    expect(out.mode).toBe('nightly');
    expect(out.shards).toBe('[1,2,3,4]');
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('takes the mode of a manual run from its input', () => {
    expect(planFor('workflow_dispatch', '', 'full').count).toBe('16');
    expect(planFor('workflow_dispatch', '', 'nightly').count).toBe('4');
  });
});
