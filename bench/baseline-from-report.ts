import { type Baseline, buildBaseline } from './gate';
import { BenchArgumentError } from './errors';
import type { BenchReport } from './report';

/**
 * New baseline entries from a report a CI run measured. A quality number is a function of the tool versions, so a baseline
 * entry recorded on a laptop would not be the number the runner measures; this command accepts only a report of a strict
 * parity run on Linux without an injected regression, and it only adds the rows the baseline has no entry for. An entry that
 * exists is never rewritten here (a deliberate update of it is `--update-baseline`, after a run that is meant to move it).
 */
export function addNewRowsFromReport(report: BenchReport, baseline: Baseline): { baseline: Baseline; added: string[] } {
  if (report.host.platform !== 'linux') throw new BenchArgumentError(`the report was measured on ${report.host.platform}; baseline numbers come from the CI runner (linux)`);
  if (!report.strictMode) throw new BenchArgumentError('the report was not measured under ORACLE_STRICT_MODE=1, so a missing tool may have skipped rows');
  if (report.settings.injectedRegression !== null) throw new BenchArgumentError(`the report was measured with the injected regression ${report.settings.injectedRegression}`);
  if (report.source === undefined) throw new BenchArgumentError('the report records no workflow run (commit, branch, event); a baseline entry needs the run that measured it');
  const fresh = report.rows.filter((row) => row.status === 'measured' && baseline.entries[row.id] === undefined);
  const next = buildBaseline({ ...report, rows: fresh }, baseline);
  return { baseline: next, added: fresh.map((row) => row.id) };
}
