import { describe, expect, it } from 'vitest';
import type { CorpusFile } from '../bench/realworld/manifest';
import type { JobRecord, KnownFailure, KnownRefusal } from '../bench/realworld/report';
import { differential, evaluateRegression } from '../bench/realworld/regression/differential';
import { mergeRegression, type RegressionResults } from '../bench/realworld/regression/merge';
import { renderRegressionMarkdown } from '../bench/realworld/regression/summary';
import { REPORT_SCHEMA } from '../bench/realworld/report';
import type { Verdict } from '../bench/realworld/verdict';

/**
 * The differential judge of the regression corpus: the head against the result set of an earlier run of the same files and
 * pairs. Both result sets are written out by hand; the expected regressions are read off them, not computed by the code under test.
 */

const job = (file: string, target: string, verdict: Verdict, detail?: string, source = 'doc'): JobRecord => ({ file, source, target, verdict, ms: 10, ...(detail === undefined ? {} : { detail }) });

describe('differential', () => {
  const previous = [
    job('a.doc', 'pdf', 'ok'),
    job('b.doc', 'pdf', 'ok'),
    job('c.doc', 'pdf', 'ok'),
    job('d.doc', 'pdf', 'refused', 'ConversionFailedError: encrypted'),
    job('e.doc', 'pdf', 'crash', 'TypeError: x'),
    job('f.doc', 'pdf', 'ok'),
    job('gone.doc', 'pdf', 'ok'),
  ];
  const current = [
    job('a.doc', 'pdf', 'ok'),
    job('b.doc', 'pdf', 'crash', 'RangeError: out of bounds'),
    job('c.doc', 'pdf', 'refused', 'ConversionFailedError: unreadable'),
    job('d.doc', 'pdf', 'crash', 'TypeError: y'),
    job('e.doc', 'pdf', 'ok'),
    job('f.doc', 'txt', 'hang', 'job past its deadline'),
    job('new.doc', 'pdf', 'crash', 'Error: z'),
  ];

  it('flags a job that converted before and does not now, whatever way it fails', () => {
    const result = differential(previous, current);
    expect(result.regressions.map((r) => `${r.file}:${r.before}>${r.now}`)).toEqual(['b.doc:ok>crash', 'c.doc:ok>refused']);
  });

  it('does not flag a job that failed or was refused before, which is a failure of its own and not a change', () => {
    expect(differential(previous, current).regressions.map((r) => r.file)).toEqual(['b.doc', 'c.doc']);
  });

  it('counts the jobs it could compare, the ones with no counterpart, and the ones that were repaired', () => {
    const result = differential(previous, current);
    // Comparable: a, b, c, d, e (same file and target). Without a counterpart: f.doc to pdf (before) and f.doc to txt (now), gone.doc (before), new.doc (now).
    expect(result.compared).toBe(5);
    expect(result.notComparable).toBe(4);
    expect(result.repaired).toBe(1);
  });

  it('keeps the detail and the pair of the current result', () => {
    const [first] = differential(previous, current).regressions;
    expect(first).toEqual({ file: 'b.doc', source: 'doc', target: 'pdf', before: 'ok', now: 'crash', detail: 'RangeError: out of bounds' });
  });
});

describe('regression gate', () => {
  const jobs = [job('a.doc', 'pdf', 'ok'), job('b.doc', 'pdf', 'refused', 'ConversionFailedError: unreadable'), job('c.doc', 'pdf', 'crash', 'RangeError: bad')];
  const previous = [job('a.doc', 'pdf', 'ok'), job('b.doc', 'pdf', 'ok'), job('c.doc', 'pdf', 'ok')];

  it('fails on a crash and on a job that converted before and is refused now', () => {
    const gate = evaluateRegression(jobs, previous, []);
    expect(gate.pass).toBe(false);
    expect(gate.fatal.map((j) => j.file)).toEqual(['c.doc']);
    expect(gate.regressions.map((r) => r.file)).toEqual(['b.doc', 'c.doc']);
  });

  it('passes when every regression is a known failure with a tracking issue', () => {
    const known: KnownFailure[] = [
      { pair: 'doc->pdf', verdict: 'crash', detail: 'RangeError', file: 'c.doc', issue: 783 },
      { pair: 'doc->pdf', verdict: 'refused', detail: 'unreadable', file: 'b.doc', issue: 735 },
    ];
    const gate = evaluateRegression(jobs, previous, known);
    expect(gate.pass).toBe(true);
    expect(gate.knownRegressions.map((k) => `${k.regression.file}#${k.issue}`)).toEqual(['b.doc#735', 'c.doc#783']);
  });

  it('judges the verdicts alone when there is no earlier result set', () => {
    const gate = evaluateRegression(jobs, null, []);
    expect(gate.differential).toBeNull();
    expect(gate.regressions).toEqual([]);
    expect(gate.fatal.map((j) => j.file)).toEqual(['c.doc']);
    expect(gate.pass).toBe(false);
    expect(evaluateRegression([job('a.doc', 'pdf', 'refused', 'ConversionFailedError: encrypted')], null, []).pass).toBe(true);
  });
});

describe('regression gate with known refusals', () => {
  const unreadable = 'ConversionFailedError: LibreOffice could not read the .doc file: it is damaged or not a valid DOC document.';
  const known: KnownRefusal[] = [{ file: 'c.doc', source: 'doc', detail: '^ConversionFailedError: LibreOffice could not read the \\.doc file: it is damaged or not a valid DOC document\\.$', reason: 'Cut off.', issue: 783 }];
  const previous = [job('c.doc', 'pdf', 'ok'), job('d.doc', 'pdf', 'ok')];

  it('explains a file that converted before and is refused now with the message its known refusal names', () => {
    const gate = evaluateRegression([job('c.doc', 'pdf', 'refused', unreadable), job('d.doc', 'pdf', 'ok')], previous, [], [], known);
    expect(gate.pass).toBe(true);
    expect(gate.regressions).toEqual([]);
    expect(gate.explainedRefusals.map((entry) => `${entry.regression.file}:${entry.reason}`)).toEqual(['c.doc:Cut off.']);
    expect(gate.knownRefusals.map((entry) => entry.job.file)).toEqual(['c.doc']);
  });

  it('still fails on a refusal with another message, another file or another source', () => {
    const otherMessage = evaluateRegression([job('c.doc', 'pdf', 'refused', 'ConversionFailedError: encrypted'), job('d.doc', 'pdf', 'ok')], previous, [], [], known);
    expect(otherMessage.pass).toBe(false);
    expect(otherMessage.regressions.map((r) => r.file)).toEqual(['c.doc']);
    const otherFile = evaluateRegression([job('c.doc', 'pdf', 'ok'), job('d.doc', 'pdf', 'refused', unreadable)], previous, [], [], known);
    expect(otherFile.pass).toBe(false);
    expect(otherFile.regressions.map((r) => r.file)).toEqual(['d.doc']);
    const otherSource = evaluateRegression([job('c.doc', 'pdf', 'refused', unreadable, 'dot'), job('d.doc', 'pdf', 'ok')], previous, [], [], known);
    expect(otherSource.pass).toBe(false);
  });

  it('explains refusals only: a crash of the same file with the same message stays a failure', () => {
    const gate = evaluateRegression([job('c.doc', 'pdf', 'crash', unreadable), job('d.doc', 'pdf', 'ok')], previous, [], [], known);
    expect(gate.pass).toBe(false);
    expect(gate.explainedRefusals).toEqual([]);
    expect(gate.regressions.map((r) => r.file)).toEqual(['c.doc']);
  });

  it('lists the explained refusal in the report and counts it among the files that converted before', () => {
    const jobs = [job('c.doc', 'pdf', 'refused', unreadable), job('d.doc', 'pdf', 'ok')];
    const lines = renderRegressionMarkdown(jobs, evaluateRegression(jobs, previous, [], [], known), { files: new Map(), previousCommit: '1234567890abcdef', shardSeconds: [] }).split('\n');
    expect(lines).toContainEqual('Compared with the run of 1234567: 2 jobs compared, 1 converted before and do not now, 0 repaired, 0 without a counterpart.');
    expect(lines).toContainEqual('## Converted before, refused now, and explained');
    expect(lines).toContainEqual('| c.doc | doc->pdf | Cut off. |');
    expect(lines).not.toContainEqual('## Converted before, not now');
  });
});

describe('merged run against the committed known refusals', () => {
  const cut = 'gd-608556.xls';
  const earlier: RegressionResults = { schema: REPORT_SCHEMA, commit: 'a'.repeat(40), mode: 'full', date: '2026-11-01', gate: {} as RegressionResults['gate'], unavailable: [], jobs: [job(cut, 'pdf', 'ok', undefined, 'xls')] };
  const nightly = (detail: string) => [{ schema: REPORT_SCHEMA, shard: 0, shards: 1, commit: 'b'.repeat(40), mode: 'nightly' as const, date: '2026-11-21', unavailable: [], elapsedMs: 1000, jobs: [job(cut, 'pdf', 'refused', detail, 'xls')] }];

  it('passes the cut workbook that the suite refuses and fails a refusal of it that nothing explains', () => {
    const explained = mergeRegression(nightly('ConversionFailedError: LibreOffice could not read the .xls file: it is damaged or not a valid XLS document.'), earlier, new Map());
    expect(explained.pass).toBe(true);
    expect(explained.results.gate.explainedRefusals.map((entry) => entry.regression.file)).toEqual([cut]);
    expect(mergeRegression(nightly('ConversionFailedError: The XLS file is encrypted.'), earlier, new Map()).pass).toBe(false);
  });
});

describe('regression summary', () => {
  const files = new Map<string, CorpusFile>(
    [
      ['b.doc', 'Microsoft Word 9.0'],
      ['c.doc', 'Microsoft Word 10.0'],
      ['d.doc', 'WordPerfect 8'],
    ].map(([id, producer]) => [
      id,
      { id, source: 'govdocs1', format: 'doc', size: 1000, sha256: 'c'.repeat(64), producer, origin: { kind: 'zip', archive: 'https://example.invalid/0.zip', entry: id, offset: 0, compressedSize: 1, method: 0 } } as CorpusFile,
    ])
  );
  const jobs = [job('a.doc', 'pdf', 'ok'), job('b.doc', 'pdf', 'refused', 'ConversionFailedError: unreadable'), job('c.doc', 'pdf', 'crash', 'RangeError: bad | pipe'), job('d.doc', 'txt', 'hang', 'job past its deadline')];
  const previous = [job('a.doc', 'pdf', 'ok'), job('b.doc', 'pdf', 'ok'), job('c.doc', 'pdf', 'ok'), job('d.doc', 'txt', 'ok')];
  const text = renderRegressionMarkdown(jobs, evaluateRegression(jobs, previous, []), { files, previousCommit: '1234567890abcdef', shardSeconds: [610, 1500] });

  const lines = text.split('\n');

  it('names the run, the earlier commit it was compared with, and the verdict counts', () => {
    expect(lines[0]).toBe('# Regression corpus run');
    expect(lines).toContainEqual('Gate: **fail**. Jobs: 4. ok 1, refused 1, bad-output 0, crash 1, hang 1.');
    expect(lines).toContainEqual('Compared with the run of 1234567: 4 jobs compared, 3 converted before and do not now, 0 repaired, 0 without a counterpart.');
  });

  it('lists each regression with the verdict before and now, and escapes a pipe in the detail', () => {
    expect(lines).toContainEqual('| b.doc | doc->pdf | ok -> refused | ConversionFailedError: unreadable |');
    expect(lines).toContainEqual('| c.doc | doc->pdf | ok -> crash | RangeError: bad \\| pipe |');
    expect(lines).toContainEqual('| d.doc | doc->txt | ok -> hang | job past its deadline |');
  });

  it('groups the failures by format and producer class', () => {
    expect(lines).toContainEqual('| doc | microsoft-word | 2 | 1 | 0 | 1 | 0 |');
    expect(lines).toContainEqual('| doc | wordperfect | 1 | 0 | 0 | 0 | 1 |');
    expect(lines.filter((line) => line.startsWith('| doc | unknown |'))).toEqual([]);
  });

  it('shows how long the shards took', () => {
    expect(lines).toContainEqual('| 1 | 10 min 10 s |');
    expect(lines).toContainEqual('| 2 | 25 min 0 s |');
  });

  it('says so when there was nothing to compare with', () => {
    const none = renderRegressionMarkdown(jobs, evaluateRegression(jobs, null, []), { files, previousCommit: null, shardSeconds: [] });
    expect(none.split('\n')).toContainEqual('No earlier result set: this run judges crashes, hangs, bad outputs and refusals only.');
  });
});
