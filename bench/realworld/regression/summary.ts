/** The Markdown report of a regression corpus run: the shared run summary, the differential, the failures by producer and the shard times. */
import type { CorpusFile } from '../manifest';
import { cell, type JobRecord, renderMarkdown } from '../report';
import { producerClass } from './producer';
import type { RegressionGate } from './differential';

const DETAIL_ROWS = 200;
const SECONDS_PER_MINUTE = 60;

export interface SummaryContext {
  files: ReadonlyMap<string, CorpusFile>;
  /** Commit of the earlier run the head was compared with, or null when there was none. */
  previousCommit: string | null;
  /** Wall time of each shard, in seconds, in shard order. */
  shardSeconds: readonly number[];
}

function regressionRows(gate: RegressionGate): string[] {
  if (gate.regressions.length === 0) return [];
  const rows = gate.regressions.slice(0, DETAIL_ROWS).map((r) => `| ${r.file} | ${r.source}->${r.target} | ${r.before} -> ${r.now} | ${cell(r.detail ?? '')} |`);
  const more = gate.regressions.length > DETAIL_ROWS ? ['', `${gate.regressions.length - DETAIL_ROWS} more in the JSON report.`] : [];
  return ['', '## Converted before, not now', '', '| File | Pair | Verdict | Detail |', '|---|---|---|---|', ...rows, ...more];
}

function unavailableRows(gate: RegressionGate): string[] {
  if (gate.unavailable.length === 0) return [];
  const rows = gate.unavailable.map((entry) => `| ${entry.file} | ${cell(entry.reason)} |`);
  return ['', '## Corpus files that could not be fetched', '', 'The bytes differ from the manifest or the host did not answer: re-pin or remove the file.', '', '| File | Reason |', '|---|---|', ...rows];
}

function comparisonLines(gate: RegressionGate, previousCommit: string | null): string[] {
  if (gate.differential === null || previousCommit === null) return ['', 'No earlier result set: this run judges crashes, hangs, bad outputs and refusals only.'];
  const { compared, notComparable, repaired } = gate.differential;
  return ['', `Compared with the run of ${previousCommit.slice(0, 7)}: ${compared} jobs compared, ${gate.regressions.length + gate.knownRegressions.length} converted before and do not now, ${repaired} repaired, ${notComparable} without a counterpart.`];
}

function producerRows(jobs: readonly JobRecord[], files: ReadonlyMap<string, CorpusFile>): string[] {
  const groups = new Map<string, { jobs: number; refused: number; 'bad-output': number; crash: number; hang: number }>();
  for (const job of jobs) {
    const file = files.get(job.file);
    const key = `${job.source}\u0000${producerClass(file?.producer ?? null)}`;
    const row = groups.get(key) ?? { jobs: 0, refused: 0, 'bad-output': 0, crash: 0, hang: 0 };
    row.jobs++;
    if (job.verdict !== 'ok') row[job.verdict]++;
    groups.set(key, row);
  }
  const failing = [...groups.entries()].filter(([, row]) => row.refused + row['bad-output'] + row.crash + row.hang > 0).sort(([a], [b]) => a.localeCompare(b));
  if (failing.length === 0) return [];
  const rows = failing.map(([key, row]) => {
    const [format, cls] = key.split('\u0000');
    return `| ${format} | ${cls} | ${row.jobs} | ${row.refused} | ${row['bad-output']} | ${row.crash} | ${row.hang} |`;
  });
  return ['', '## Non-ok jobs by format and producer class', '', '| Format | Producer class | Jobs | Refused | Bad output | Crash | Hang |', '|---|---|---|---|---|---|---|', ...rows];
}

const duration = (seconds: number): string => `${Math.floor(seconds / SECONDS_PER_MINUTE)} min ${Math.round(seconds % SECONDS_PER_MINUTE)} s`;

function shardRows(seconds: readonly number[]): string[] {
  if (seconds.length === 0) return [];
  return ['', '## Shard wall time', '', '| Shard | Time |', '|---|---|', ...seconds.map((value, index) => `| ${index + 1} | ${duration(value)} |`)];
}

export function renderRegressionMarkdown(jobs: readonly JobRecord[], gate: RegressionGate, context: SummaryContext): string {
  const body = renderMarkdown(jobs, gate, 'Regression corpus run').trimEnd().split('\n');
  const [title, blank, status, ...rest] = body;
  return `${[title, blank, status, ...comparisonLines(gate, context.previousCommit), ...rest, ...regressionRows(gate), ...unavailableRows(gate), ...producerRows(jobs, context.files), ...shardRows(context.shardSeconds)].join('\n')}\n`;
}
