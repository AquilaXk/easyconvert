import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { skipUnless } from './helpers/strict-skip';
import {
  ACK_LABEL,
  COMMENT_MARKER,
  PARITY_LINE,
  acknowledgementComment,
  judgeAcknowledgement,
  mayAcknowledge,
} from '../scripts/ci-parity-ack.mjs';

/**
 * The acknowledgement rule of `verify`: a failed `parity speed` passes only when a maintainer put the `parity-ack`
 * label on and every failing row of that run's verdict is noise the harness could not decide. The verdicts below follow
 * the shape of a recorded run (`parity-verdict.json`, run 38032005052: video/clip.mp4->vp9 at 0.99492 [0.95221, 1.0255]).
 */

const ROOT = path.resolve(__dirname, '..');
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

interface Row {
  id: string;
  family: string;
  case: string;
  metric: string;
  outcome: string;
  basis: string;
  detail: string;
  worsening: number | null;
  allowance: number | null;
  gap: null;
  speed?: { median: number; low: number; high: number; pairs: number | null };
}

function undecided(id: string, median = 0.99492, overrides: Partial<Row> = {}): Row {
  const family = id.split('/')[0];
  return {
    id,
    family,
    case: id.split('/')[1],
    metric: 'throughput',
    outcome: 'fail',
    basis: 'speed-unstable-at-cap',
    detail: `speed ratio ${median} [0.95221, 1.0255] over 12 pairs; the interval still straddled 0.97 at the cap on pairs, which counts as a failure`,
    worsening: null,
    allowance: null,
    gap: null,
    speed: { median, low: 0.95221, high: 1.0255, pairs: 12 },
    ...overrides,
  };
}

const passing: Row = { ...undecided('image/photo-a.jpg->webp/throughput', 1.0041), outcome: 'pass', basis: 'speed-pass' };

function verdict(rows: Row[], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-10T06:49:35.390Z',
    families: ['image', 'video'],
    quick: false,
    scope: 'speed',
    strictMode: true,
    injectedRegression: null,
    exitCode: 3,
    baseline: { compared: 40, regressions: [] },
    parity: { schemaVersion: 1, verdict: 'fail', summary: {}, rows: [passing, ...rows] },
    ...overrides,
  };
}

const vp9 = () => undecided('video/clip.mp4->vp9/throughput');

describe('who may acknowledge', () => {
  it('counts the label of an admin or a maintainer only', () => {
    expect(mayAcknowledge('admin')).toBe(true);
    expect(mayAcknowledge('maintain')).toBe(true);
    for (const role of ['write', 'triage', 'read', 'none', '', undefined, null]) expect(mayAcknowledge(role as string)).toBe(false);
  });

  it('refuses an otherwise acknowledgeable run when the label actor has a lesser role', () => {
    const result = judgeAcknowledgement(verdict([vp9()]), { specific: [], role: 'write' });
    expect(result.acknowledged).toBe(false);
    expect(result.reasons).toEqual(['the label was not added by someone with the admin or maintain role (role: write)']);
  });

  it('refuses when the actor could not be determined', () => {
    const result = judgeAcknowledgement(verdict([vp9()]), { specific: [] });
    expect(result.acknowledged).toBe(false);
    expect(result.reasons[0]).toContain('role: unknown');
  });
});

describe('what may be acknowledged', () => {
  it('passes the recorded undecided video row for an admin when the change maps no file to video', () => {
    const result = judgeAcknowledgement(verdict([vp9()]), { specific: ['image'], role: 'admin' });
    expect(result).toEqual({
      acknowledged: true,
      rows: [{ id: 'video/clip.mp4->vp9/throughput', family: 'video', median: 0.99492, low: 0.95221, high: 1.0255, pairs: 12 }],
      reasons: [],
    });
  });

  it('passes several undecided rows, a median exactly on the parity line included', () => {
    const rows = [vp9(), undecided('audio/music.wav->opus/throughput', PARITY_LINE)];
    const result = judgeAcknowledgement(verdict(rows), { specific: [], role: 'maintain' });
    expect(result.acknowledged).toBe(true);
    expect(result.rows.map((row) => row.id)).toEqual(['video/clip.mp4->vp9/throughput', 'audio/music.wav->opus/throughput']);
  });

  it('refuses a credible slowdown, even with the label from an admin', () => {
    const slow = undecided('video/clip.mp4->h264/throughput', 0.8, {
      basis: 'speed-below-reference',
      detail: 'speed ratio 0.8 [0.78, 0.82] over 12 pairs; the upper bound is below 0.97, so ours is slower than the reference',
    });
    const result = judgeAcknowledgement(verdict([slow]), { specific: [], role: 'admin' });
    expect(result.acknowledged).toBe(false);
    expect(result.reasons).toEqual(['video/clip.mp4->h264/throughput: a credible slowdown (basis speed-below-reference, metric throughput) cannot be acknowledged']);
  });

  it('refuses a tracked row that got slower than its history', () => {
    const slower = undecided('video/clip.mp4->hevc/throughput', 0.9, { basis: 'tracked-slower-than-gap' });
    expect(judgeAcknowledgement(verdict([slower]), { specific: [], role: 'admin' }).acknowledged).toBe(false);
  });

  it('refuses a quality row, which is not a speed row', () => {
    const quality = undecided('image/photo-a.jpg->webp/ssim', 0.99, { metric: 'ssim', basis: 'below-reference' });
    const result = judgeAcknowledgement(verdict([quality]), { specific: [], role: 'admin' });
    expect(result.acknowledged).toBe(false);
    expect(result.reasons[0]).toContain('not an undecided speed row');
  });

  it('refuses a quality row even when it carries the undecided basis', () => {
    const odd = undecided('image/photo-a.jpg->webp/ssim', 0.99, { metric: 'ssim' });
    expect(judgeAcknowledgement(verdict([odd]), { specific: [], role: 'admin' }).acknowledged).toBe(false);
  });

  it('refuses the whole run when one failing row cannot be acknowledged', () => {
    const slow = undecided('audio/music.wav->opus/throughput', 0.9, { basis: 'speed-below-reference' });
    const result = judgeAcknowledgement(verdict([vp9(), slow]), { specific: [], role: 'admin' });
    expect(result.acknowledged).toBe(false);
    expect(result.rows).toEqual([]);
  });

  it('refuses a median below the parity line', () => {
    const result = judgeAcknowledgement(verdict([undecided('video/clip.mp4->vp9/throughput', 0.9699)]), { specific: [], role: 'admin' });
    expect(result.acknowledged).toBe(false);
    expect(result.reasons).toEqual(['video/clip.mp4->vp9/throughput: the median ratio 0.9699 is below 0.97']);
  });

  it('refuses a row of a family the change maps files to specifically', () => {
    const result = judgeAcknowledgement(verdict([vp9()]), { specific: ['video'], role: 'admin' });
    expect(result.acknowledged).toBe(false);
    expect(result.reasons[0]).toContain('maps files specifically to the video family');
  });

  it('refuses a row without a measured ratio and interval', () => {
    const bare = vp9();
    delete bare.speed;
    expect(judgeAcknowledgement(verdict([bare]), { specific: [], role: 'admin' }).reasons).toEqual([
      'video/clip.mp4->vp9/throughput: the verdict carries no measured ratio and interval',
    ]);
    const nan = vp9();
    nan.speed = { median: Number.NaN, low: 0.9, high: 1, pairs: 3 };
    expect(judgeAcknowledgement(verdict([nan]), { specific: [], role: 'admin' }).acknowledged).toBe(false);
  });

  it('refuses a run that failed for another reason: no failing row, a baseline regression, or a run that is not strict speed', () => {
    expect(judgeAcknowledgement(verdict([]), { specific: [], role: 'admin' }).acknowledged).toBe(false);
    const regressed = verdict([vp9()], { baseline: { compared: 40, regressions: [{ id: 'x' }] } });
    expect(judgeAcknowledgement(regressed, { specific: [], role: 'admin' }).acknowledged).toBe(false);
    expect(judgeAcknowledgement(verdict([vp9()], { injectedRegression: { id: 'x' } }), { specific: [], role: 'admin' }).acknowledged).toBe(false);
    expect(judgeAcknowledgement(verdict([vp9()], { strictMode: false }), { specific: [], role: 'admin' }).acknowledged).toBe(false);
    expect(judgeAcknowledgement(verdict([vp9()], { quick: true }), { specific: [], role: 'admin' }).acknowledged).toBe(false);
    expect(judgeAcknowledgement(verdict([vp9()], { scope: 'quality' }), { specific: [], role: 'admin' }).acknowledged).toBe(false);
  });

  it('refuses a missing or unreadable verdict', () => {
    for (const missing of [null, undefined, {}, { parity: {} }, 'text']) {
      expect(judgeAcknowledgement(missing, { specific: [], role: 'admin' }).acknowledged).toBe(false);
    }
  });
});

describe('the record on the pull request', () => {
  it('names each acknowledged row with its ratio, interval and pairs, and the rule', () => {
    const rows = judgeAcknowledgement(verdict([vp9()]), { specific: [], role: 'admin' }).rows;
    const text = acknowledgementComment(rows, { actor: 'aquila', role: 'admin', runUrl: 'https://github.com/o/r/actions/runs/1' });
    expect(text.startsWith(`${COMMENT_MARKER}\n`)).toBe(true);
    expect(text).toContain('| `video/clip.mp4->vp9/throughput` | 0.99492 | [0.95221, 1.0255] | 12 |');
    expect(text).toContain(`\`${ACK_LABEL}\` label was added by @aquila (admin)`);
    expect(text).toContain('speed-unstable-at-cap');
    expect(text).toContain('at least 0.97');
    expect(text).toContain('https://github.com/o/r/actions/runs/1');
  });
});

describe('the command line', () => {
  function run(rows: Row[], role: string, specific: string, overrides: Record<string, unknown> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'parity-ack-'));
    temps.push(dir);
    const file = path.join(dir, 'parity-verdict.json');
    writeFileSync(file, JSON.stringify(verdict(rows, overrides)));
    const comment = path.join(dir, 'comment.md');
    const result = spawnSync('node', [path.join(ROOT, 'scripts', 'ci-parity-ack.mjs'), '--verdict', file, '--specific', specific, '--role', role, '--actor', 'aquila', '--comment-file', comment], { encoding: 'utf-8' });
    let written: string | null = null;
    try {
      written = readFileSync(comment, 'utf-8');
    } catch {
      written = null;
    }
    return { status: result.status, stdout: result.stdout, comment: written };
  }

  it('prints acknowledged=true and writes the comment for an acknowledgeable run', () => {
    const result = run([vp9()], 'admin', 'image');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('acknowledged=true');
    expect(result.comment).toContain('video/clip.mp4->vp9/throughput');
  });

  it('prints acknowledged=false with the reasons and writes no comment otherwise', () => {
    const result = run([vp9()], 'write', '');
    expect(result.stdout).toContain('acknowledged=false');
    expect(result.stdout).toContain('reason=the label was not added by someone with the admin or maintain role (role: write)');
    expect(result.comment).toBeNull();
  });

  it('prints acknowledged=false for an unreadable verdict', () => {
    const result = spawnSync('node', [path.join(ROOT, 'scripts', 'ci-parity-ack.mjs'), '--verdict', path.join(ROOT, 'no-such-verdict.json'), '--role', 'admin'], { encoding: 'utf-8' });
    expect(result.stdout.trim().split(String.fromCharCode(10))).toEqual([
      'acknowledged=false',
      'reason=there is no readable parity verdict for this run',
    ]);
  });
});

describe('the verify job', () => {
  interface Step { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> }
  const ci = parse(readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8')) as { jobs: Record<string, { steps: Step[]; permissions?: Record<string, string> }> };
  const verify = ci.jobs.verify;
  const gateName = 'Require every job to pass, or to be skipped for a documentation-only change';
  const gate = verify.steps.find((step) => step.name === gateName)!;
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });

  function verifyStatus(speed: string, acknowledged: string): number {
    const result = spawnSync('bash', ['-c', gate.run!], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        EVENT_NAME: 'pull_request',
        CODE_CHANGED: 'true',
        BENCH_CHANGED: 'true',
        HAS_AUTOMERGE_LABEL: 'true',
        CHANGES_RESULT: 'success',
        CHECKS_RESULT: 'success',
        TESTS_RESULT: 'success',
        CONFORMANCE_RESULT: 'success',
        INTEGRATION_RESULT: 'success',
        CONTAINER_RESULT: 'success',
        PARITY_QUALITY_RESULT: 'success',
        PARITY_SPEED_RESULT: speed,
        SPEED_ACKNOWLEDGED: acknowledged,
      },
    });
    return result.status ?? -1;
  }
  const only = it.skipIf(skipUnless('bash', bash.status === 0));

  only('passes a failed speed job only when the acknowledgement step passed it', () => {
    expect(verifyStatus('failure', 'true')).toBe(0);
    expect(verifyStatus('failure', 'false')).toBe(1);
    expect(verifyStatus('failure', '')).toBe(1);
  });

  only('never turns a cancelled or skipped speed job into a pass', () => {
    expect(verifyStatus('cancelled', 'true')).toBe(1);
    expect(verifyStatus('skipped', 'true')).toBe(1);
    expect(verifyStatus('success', 'true')).toBe(0);
  });

  it('decides only for a failed speed job that carries the label, from the run of the label event', () => {
    const decide = verify.steps.find((step) => step.id === 'ack')!;
    expect(decide.if).toBe("needs.parity-speed.result == 'failure' && contains(github.event.pull_request.labels.*.name, 'parity-ack')");
    expect(decide.run).toContain('collaborators/$actor/permission');
    expect(decide.run).toContain('.event == "labeled" and .label.name == "parity-ack"');
    expect(decide.env?.SPECIFIC_FAMILIES).toBe('${{ needs.changes.outputs.bench_specific_families }}');
  });

  it('may comment on the pull request and read the repository', () => {
    expect(verify.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'write' });
  });
});
