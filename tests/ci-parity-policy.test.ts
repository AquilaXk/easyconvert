import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyParityVerdict,
  belowReferenceByFamily,
  commentMarker,
  decide,
  GAP_LABEL,
  gapIssueTitle,
  linkedIssueNumbers,
  MAX_LINKED_ISSUES,
  ParityPolicyError,
  parseRunFile,
  readRunFile,
  renderExemptionComment,
  SECURITY_LABEL,
  upsertGapIssues,
  verifyIssues,
} from '../scripts/ci-parity-policy.mjs';

/**
 * The label policy of the parity jobs, on hand-written verdict files and a recording stand-in for the GitHub client:
 * the exemption excuses the parity verdict of a `security` pull request that links an issue, and nothing else.
 */

type Row = { id: string; family: string; case: string; metric: string; outcome: string; basis: string; detail: string; worsening: null; allowance: null; gap: { id: string; issue: number | null; note: string } | null };

const failing = (id: string, issue: number | null = null): Row => {
  const [family, caseName, metric] = id.split('/');
  return { id, family, case: caseName, metric, outcome: 'fail', basis: 'speed-below-reference', detail: `${metric} is below the reference`, worsening: null, allowance: null, gap: issue === null ? null : { id, issue, note: 'known' } };
};
const passing = (id: string): Row => ({ ...failing(id), outcome: 'pass', basis: 'speed-pass', detail: 'ok' });

function runFile(rows: Row[], over: Record<string, unknown> = {}): Record<string, unknown> {
  const below = rows.some((row) => row.outcome === 'fail');
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    families: ['compression'],
    quick: false,
    scope: 'speed',
    strictMode: true,
    injectedRegression: null,
    exitCode: below ? 3 : 0,
    baseline: { compared: 4, regressions: [] },
    parity: { schemaVersion: 1, verdict: below ? 'fail' : 'pass', summary: {}, rows },
    ...over,
  };
}

const XZ = 'compression/mixed.xz->tar/throughput';
const SEVEN = 'compression/mixed.7z->tar/throughput';
const WEBP = 'image/photo-a.jpg->webp/bd_rate_psnr';

describe('linked issues', () => {
  it('reads closing and reference keywords, once each, in order', () => {
    expect(linkedIssueNumbers('Closes #12 and fixes #7. Refs #12. Related to #99, part of #3, see #4, Resolves: #5')).toEqual([12, 7, 99, 3, 4, 5]);
  });

  it('ignores bare numbers, other repositories and text without a keyword', () => {
    expect(linkedIssueNumbers('Mentions #12 and PR #13 only; see GH-14; closes the gap')).toEqual([]);
    expect(linkedIssueNumbers(null)).toEqual([]);
    expect(linkedIssueNumbers('fixes #0')).toEqual([]);
  });

  it('stops at the limit, however long the text', () => {
    const text = Array.from({ length: MAX_LINKED_ISSUES + 30 }, (_, i) => `Refs #${i + 1}`).join('\n');
    expect(linkedIssueNumbers(text)).toHaveLength(MAX_LINKED_ISSUES);
  });
});

describe('the verdict file', () => {
  it('accepts what a parity run writes', () => {
    expect(parseRunFile(runFile([failing(XZ, 487), passing(SEVEN)])).exitCode).toBe(3);
  });

  it.each<[string, (file: Record<string, unknown>) => void, RegExp]>([
    ['another schema version', (f) => { f.schemaVersion = 2; }, /schemaVersion/],
    ['an exit code outside 0 to 3', (f) => { f.exitCode = 7; }, /exitCode/],
    ['a missing strict flag', (f) => { delete f.strictMode; }, /strictMode/],
    ['regressions that are not strings', (f) => { (f.baseline as { regressions: unknown[] }).regressions = [1]; }, /regressions/],
    ['a verdict other than pass or fail', (f) => { (f.parity as { verdict: string }).verdict = 'maybe'; }, /verdict/],
    ['a verdict that disagrees with its rows', (f) => { (f.parity as { verdict: string }).verdict = 'pass'; }, /disagrees/],
    ['a row of an unknown outcome', (f) => { ((f.parity as { rows: Row[] }).rows[0] as { outcome: string }).outcome = 'meh'; }, /unknown outcome/],
    ['a row without an id', (f) => { delete ((f.parity as { rows: Row[] }).rows[0] as Partial<Row>).id; }, /id, a family and a detail/],
    ['a malformed gap', (f) => { ((f.parity as { rows: Row[] }).rows[0] as { gap: unknown }).gap = { issue: 'x' }; }, /malformed gap/],
  ])('rejects %s', (_name, damage, message) => {
    const file = runFile([failing(XZ)]);
    damage(file);
    expect(() => parseRunFile(file)).toThrow(ParityPolicyError);
    expect(() => parseRunFile(file)).toThrow(message);
  });

  it('refuses a file over the size limit and one that is not JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-policy-'));
    try {
      const big = path.join(dir, 'big.json');
      fs.writeFileSync(big, ' '.repeat(8 * 1024 * 1024 + 1));
      expect(() => readRunFile(big, fs)).toThrow(/byte limit/);
      const bad = path.join(dir, 'bad.json');
      fs.writeFileSync(bad, 'nope');
      expect(() => readRunFile(bad, fs)).toThrow(SyntaxError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the decision', () => {
  const options = (over: Partial<{ labels: string[]; verifiedIssues: number[]; requireStrict: boolean }> = {}) => ({ labels: [], verifiedIssues: [], requireStrict: true, ...over });
  const below = parseRunFile(runFile([failing(XZ, 487), failing(WEBP), passing(SEVEN)]));

  it('passes a verdict with nothing below the reference', () => {
    expect(decide(parseRunFile(runFile([passing(SEVEN)])), options()).outcome).toBe('pass');
  });

  it('fails a pull request with rows below the reference and no exemption', () => {
    const decision = decide(below, options());
    expect(decision.outcome).toBe('fail');
    expect(decision.exempt).toBe(false);
    expect(decision.reasons[0]).toContain('2 rows are below the reference tool');
    expect(decision.reasons[0]).toContain('the "security" label and a linked issue');
  });

  it('exempts a pull request labelled security that links an issue', () => {
    const decision = decide(below, options({ labels: ['bug', SECURITY_LABEL], verifiedIssues: [585] }));
    expect(decision.outcome).toBe('exempt');
    expect(decision.reasons[0]).toContain('#585');
    expect(decision.reasons[0]).toContain('tests and every other check still apply');
  });

  it('does not exempt the label without an issue, nor an issue without the label', () => {
    expect(decide(below, options({ labels: [SECURITY_LABEL] }))).toMatchObject({ outcome: 'fail', exempt: false });
    expect(decide(below, options({ labels: [SECURITY_LABEL] })).reasons[0]).toContain('a linked issue');
    expect(decide(below, options({ labels: ['bug', 'automerge'], verifiedIssues: [585] }))).toMatchObject({ outcome: 'fail', exempt: false });
  });

  it('never exempts a regression against our own baseline, with or without the label and the issue', () => {
    const regressed = parseRunFile(runFile([failing(XZ)], { exitCode: 1, baseline: { compared: 4, regressions: ['image/a.jpg->webp/ssim: our value 0.9 is worse than baseline 0.96'] } }));
    const decision = decide(regressed, options({ labels: [SECURITY_LABEL], verifiedIssues: [585] }));
    expect(decision.outcome).toBe('fail');
    expect(decision.reasons[0]).toContain('no label excuses a regression');
    expect(decision.reasons.join('\n')).toContain('REGRESSION image/a.jpg->webp/ssim');
    // Also when the parity verdict itself is clean.
    const cleanButRegressed = parseRunFile(runFile([passing(SEVEN)], { exitCode: 1, baseline: { compared: 4, regressions: ['x'] } }));
    expect(decide(cleanButRegressed, options({ labels: [SECURITY_LABEL], verifiedIssues: [1] })).outcome).toBe('fail');
  });

  it('fails a run made without strict mode, since a missing tool could have skipped rows', () => {
    const lenient = parseRunFile(runFile([passing(SEVEN)], { strictMode: false }));
    expect(decide(lenient, options()).outcome).toBe('fail');
    expect(decide(lenient, options({ requireStrict: false })).outcome).toBe('pass');
  });

  it('fails a run whose exit code says the benchmark itself failed', () => {
    const crashed = parseRunFile(runFile([passing(SEVEN)], { exitCode: 2 }));
    expect(decide(crashed, options()).outcome).toBe('fail');
  });

  it('groups the rows below the reference by family', () => {
    expect([...belowReferenceByFamily(below)].map(([family, rows]) => [family, rows.map((row: Row) => row.id)])).toEqual([
      ['compression', [XZ]],
      ['image', [WEBP]],
    ]);
  });
});

/** A recording stand-in for the Octokit client the workflow step receives. */
function fakeGithub(options: { issues?: Record<number, { pull_request?: unknown }>; comments?: Array<{ id: number; body: string }>; openIssues?: Array<{ number: number; title: string; pull_request?: unknown }> } = {}) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const record = (method: string) => (args: Record<string, unknown>) => {
    calls.push({ method, args });
  };
  const comments = options.comments ?? [];
  const open = options.openIssues ?? [];
  let nextIssue = 700;
  const github = {
    calls,
    paginate: async (fn: (args: Record<string, unknown>) => unknown, args: Record<string, unknown>) => (await fn(args)) as unknown[],
    rest: {
      issues: {
        get: async (args: { issue_number: number }) => {
          calls.push({ method: 'issues.get', args });
          const found = options.issues?.[args.issue_number];
          if (!found) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: found };
        },
        listComments: async () => comments,
        createComment: record('issues.createComment'),
        updateComment: record('issues.updateComment'),
        listForRepo: async () => open,
        createLabel: record('issues.createLabel'),
        create: async (args: Record<string, unknown>) => {
          calls.push({ method: 'issues.create', args });
          return { data: { number: nextIssue++ } };
        },
        update: record('issues.update'),
      },
    },
  };
  return github;
}

describe('applying the verdict in the workflow step', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-apply-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(rows: Row[], over: Record<string, unknown> = {}) {
    const file = path.join(dir, 'parity-verdict.json');
    fs.writeFileSync(file, JSON.stringify(runFile(rows, over)));
    const messages: Array<[string, string]> = [];
    const core = {
      info: (m: string) => messages.push(['info', m]),
      warning: (m: string) => messages.push(['warning', m]),
      setFailed: (m: string) => messages.push(['failed', m]),
    };
    return { file, core, messages };
  }
  const contextFor = (labels: string[], body = '', number = 640) => ({
    repo: { owner: 'AquilaXk', repo: 'easyconvert' },
    serverUrl: 'https://github.com',
    runId: 4242,
    payload: { pull_request: { number, title: 'Fix a thing', body, labels: labels.map((name) => ({ name })) } },
  });
  const applyWith = (github: ReturnType<typeof fakeGithub>, s: ReturnType<typeof setup>, labels: string[], body: string, scope = 'speed') =>
    applyParityVerdict({ github, context: contextFor(labels, body), core: s.core, fs, runFilePath: s.file, scope });

  it('passes silently when nothing is below the reference', async () => {
    const s = setup([passing(SEVEN)]);
    const github = fakeGithub();
    expect(await applyWith(github, s, [], '')).toBe('pass');
    expect(github.calls).toEqual([]);
    expect(s.messages.filter(([kind]) => kind === 'failed')).toEqual([]);
  });

  it('fails the step, without touching GitHub, when rows are below the reference and the pull request is not exempt', async () => {
    const s = setup([failing(XZ, 487)]);
    const github = fakeGithub({ issues: { 585: {} } });
    expect(await applyWith(github, s, ['bug'], 'Closes #585')).toBe('fail');
    expect(s.messages.find(([kind]) => kind === 'failed')?.[1]).toContain('1 row is below the reference tool');
    expect(github.calls.filter((call) => call.method !== 'issues.get')).toEqual([]);
  });

  it('fails the step when the verdict file is missing or unreadable', async () => {
    const s = setup([passing(SEVEN)]);
    fs.rmSync(s.file);
    expect(await applyWith(fakeGithub(), s, [], '')).toBe('fail');
    expect(s.messages[0][1]).toContain('no usable parity verdict');
  });

  it('waives the verdict for a security pull request that links a real issue: one comment, one gap issue per family', async () => {
    const s = setup([failing(XZ, 487), failing(SEVEN), failing(WEBP), passing('image/a/ssim')]);
    const github = fakeGithub({ issues: { 585: {}, 640: { pull_request: {} } } });
    expect(await applyWith(github, s, ['security'], 'Closes #585. See #640.')).toBe('exempt');

    const creates = github.calls.filter((call) => call.method === 'issues.create');
    expect(creates.map((call) => call.args.title)).toEqual([gapIssueTitle('compression'), gapIssueTitle('image')]);
    expect(creates.every((call) => (call.args.labels as string[]).join() === GAP_LABEL)).toBe(true);
    expect(String(creates[0].args.body)).toContain(XZ);
    expect(String(creates[0].args.body)).toContain(SEVEN);
    expect(String(creates[0].args.body)).not.toContain(WEBP);
    expect(github.calls.filter((call) => call.method === 'issues.createLabel')).toHaveLength(1);

    const comments = github.calls.filter((call) => call.method === 'issues.createComment');
    expect(comments).toHaveLength(1);
    const body = String(comments[0].args.body);
    expect(body.startsWith(commentMarker('speed'))).toBe(true);
    expect(body).toContain('linked #585');
    expect(body).not.toContain('#640');
    expect(body).toContain(`| ${XZ} |`);
    expect(body).toContain('#487');
    expect(body).toContain('- compression: #700');
    expect(body).toContain('- image: #701');
    expect(body).toContain('tests, the guard, lint, build, the container and conformance still have to pass');
    expect(s.messages.some(([kind, m]) => kind === 'warning' && m.includes('3 rows are below the reference'))).toBe(true);
    expect(s.messages.some(([kind]) => kind === 'failed')).toBe(false);
  });

  it('does not exempt when the only linked reference is a pull request or a missing issue', async () => {
    const s = setup([failing(XZ)]);
    const github = fakeGithub({ issues: { 640: { pull_request: {} } } });
    expect(await applyWith(github, s, ['security'], 'Closes #640 and refs #9999')).toBe('fail');
    expect(github.calls.filter((call) => call.method.startsWith('issues.create') || call.method === 'issues.update')).toEqual([]);
  });

  it('never exempts a regression against the baseline, label and issue notwithstanding', async () => {
    const s = setup([failing(XZ)], { exitCode: 1, baseline: { compared: 1, regressions: ['image/a/ssim: worse'] } });
    const github = fakeGithub({ issues: { 585: {} } });
    expect(await applyWith(github, s, ['security'], 'Closes #585')).toBe('fail');
    expect(github.calls.filter((call) => call.method !== 'issues.get')).toEqual([]);
    expect(s.messages.find(([kind]) => kind === 'failed')?.[1]).toContain('no label excuses a regression');
  });

  it('updates the comment and the family issues of an earlier run instead of adding new ones', async () => {
    const s = setup([failing(XZ)]);
    const github = fakeGithub({
      issues: { 585: {} },
      comments: [{ id: 11, body: 'unrelated' }, { id: 12, body: `${commentMarker('speed')}\nold` }],
      openIssues: [{ number: 55, title: gapIssueTitle('compression') }, { number: 56, title: gapIssueTitle('compression'), pull_request: {} }],
    });
    expect(await applyWith(github, s, ['security'], 'Fixes #585')).toBe('exempt');
    expect(github.calls.filter((call) => call.method === 'issues.create' || call.method === 'issues.createComment')).toEqual([]);
    expect(github.calls.find((call) => call.method === 'issues.updateComment')?.args).toMatchObject({ comment_id: 12 });
    expect(github.calls.find((call) => call.method === 'issues.update')?.args).toMatchObject({ issue_number: 55 });
  });

  it('keeps the quality and the speed comment apart', () => {
    expect(commentMarker('quality')).not.toBe(commentMarker('speed'));
  });
});

describe('the pieces', () => {
  it('verifies linked numbers as issues of the repository, skipping pull requests and missing ones', async () => {
    const github = fakeGithub({ issues: { 1: {}, 2: { pull_request: {} } } });
    expect(await verifyIssues(github, { owner: 'o', repo: 'r', numbers: [1, 2, 3] })).toEqual([1]);
  });

  it('rethrows an error that is not a missing issue', async () => {
    const github = fakeGithub();
    github.rest.issues.get = async () => {
      throw Object.assign(new Error('rate limited'), { status: 403 });
    };
    await expect(verifyIssues(github, { owner: 'o', repo: 'r', numbers: [1] })).rejects.toThrow('rate limited');
  });

  it('tolerates a label that already exists but not any other failure to create it', async () => {
    const run = parseRunFile(runFile([failing(XZ)]));
    const exists = fakeGithub();
    exists.rest.issues.createLabel = async () => {
      throw Object.assign(new Error('already_exists'), { status: 422 });
    };
    const created = await upsertGapIssues(exists, { owner: 'o', repo: 'r', run, pullRequest: 1, runUrl: 'u' });
    expect([...created]).toEqual([['compression', '#700']]);
    const broken = fakeGithub();
    broken.rest.issues.createLabel = async () => {
      throw Object.assign(new Error('server error'), { status: 500 });
    };
    await expect(upsertGapIssues(broken, { owner: 'o', repo: 'r', run, pullRequest: 1, runUrl: 'u' })).rejects.toThrow('server error');
  });

  it('opens nothing for a verdict without rows below the reference', async () => {
    const github = fakeGithub();
    const created = await upsertGapIssues(github, { owner: 'o', repo: 'r', run: parseRunFile(runFile([passing(SEVEN)])), pullRequest: 1, runUrl: 'u' });
    expect(created.size).toBe(0);
    expect(github.calls).toEqual([]);
  });

  it('caps the rows listed in a comment and says how many were left out', () => {
    const rows = Array.from({ length: 250 }, (_, i) => failing(`compression/case-${i}/throughput`));
    const body = renderExemptionComment(parseRunFile(runFile(rows)), { scope: 'speed', issues: [1], familyIssues: new Map([['compression', '#9']]) });
    expect(body).toContain('250 rows are below the reference tool');
    expect(body).toContain('| ... | 50 more rows | |');
    expect(body.split('\n').filter((line) => line.startsWith('| compression/case-')).length).toBe(200);
  });
});
