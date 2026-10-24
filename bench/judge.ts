import fs from 'node:fs';
import path from 'node:path';
import { PARITY_SCHEMA_VERSION, PARITY_VERDICT_FILE } from './speed-config';
import { BenchArgumentError } from './errors';
import { evaluateGate, type GateResult, readBaseline } from './gate';
import { evaluateParity, failureLines, type ParityRunFile, type ParityScope, renderParityMarkdown, renderParityText } from './parity';
import { readGaps } from './parity-gaps';
import type { BenchReport, Family } from './report';
import { rowInScope } from './scope';

/**
 * The verdict of a parity run on a report: the baseline gate, the parity rules, the exit code and the verdict file. It is gate
 * code (the `parity speed` job takes it from the base commit), so a change cannot decide what makes its run pass or which
 * exit code a failure gets.
 */

/** Exit codes of a benchmark run. */
export const EXIT_PASS = 0;
/** A metric got worse than our own baseline: never excused by a label. */
export const EXIT_REGRESSION = 1;
/** Every metric is at its baseline, but at least one row is below the reference tool. */
export const EXIT_BELOW_REFERENCE = 3;

/** What the verdict needs of a run's options. */
export interface JudgeOptions {
  baselinePath: string;
  gapsPath: string;
  baseGapsPath: string | null;
  /** The baseline of the base of the change: with its gap file it backs the quality entries a change adds or edits. */
  baseBaselinePath: string | null;
  families: Family[];
  quick: boolean;
  qualityOnly: boolean;
  speedOnly: boolean;
  outDir: string;
}

export function printGate(result: GateResult, out: (line: string) => void): void {
  out(`gate: ${result.compared} metrics compared, ${result.regressions.length} regressed, ${result.improvements.length} improved, ${result.unbaselined.length} without baseline, ${result.skipped.length} skipped`);
  for (const regression of result.regressions) out(`REGRESSION ${regression.message}`);
  for (const note of result.speedNotes) out(`note ${note}`);
  for (const id of result.unbaselined) out(`no baseline yet: ${id}`);
}


export function parityScope(options: JudgeOptions): ParityScope {
  if (options.qualityOnly) return 'quality';
  return options.speedOnly ? 'speed' : 'both';
}

/**
 * Baseline gate and parity verdict of a parity run. The gate checks only what was measured: quality rows or
 * throughput rows (a baseline throughput entry has a ratio), and the cases of the quick subset when `--quick` is set.
 * Regressions against our own baseline return EXIT_REGRESSION and are never excused; a row below the reference with
 * every metric at its baseline returns EXIT_BELOW_REFERENCE. The verdict is also written for the CI step that applies
 * the label policy.
 */
export function judgeParity(report: BenchReport, options: JudgeOptions, out: (line: string) => void): number {
  if (!fs.existsSync(options.baselinePath)) throw new BenchArgumentError(`no baseline at ${options.baselinePath}; create it with --update-baseline`);
  const scope = parityScope(options);
  const include = (id: string, entry: { ratio: number | null }): boolean => {
    if (!rowInScope(options.quick, id)) return false;
    if (scope === 'both') return true;
    return scope === 'speed' ? entry.ratio !== null : entry.ratio === null;
  };
  const gate = evaluateGate(report, readBaseline(options.baselinePath), { families: new Set(options.families), include });
  printGate(gate, out);
  // A quality-only run measures no speed, so it cannot back a gap entry; the speed run of the same change does.
  const baseGaps = options.baseGapsPath && scope !== 'quality' ? readGaps(options.baseGapsPath) : undefined;
  // A speed run backs speed entries only. A run that judges quality rows needs the base's baseline to back the quality ones, and fails without it rather than checking less.
  if (options.baseGapsPath && scope !== 'speed' && !options.baseBaselinePath) throw new BenchArgumentError('--base-gaps in a run that judges quality rows needs --base-baseline, the baseline of the same base');
  const qualityBase = options.baseGapsPath && options.baseBaselinePath && scope !== 'speed' ? { gaps: readGaps(options.baseGapsPath), baseline: readBaseline(options.baseBaselinePath) } : undefined;
  const measuredFamilies = new Set<string>(options.families);
  // The rows this run is about, as the baseline gate counts them: a quality entry for one of them that the report lacks fails.
  const expectedRows = (id: string): boolean => measuredFamilies.has(id.split('/')[0]) && include(id, { ratio: null });
  const timedByRun = (id: string): boolean => rowInScope(options.quick, id);
  const parity = evaluateParity(report, readGaps(options.gapsPath), { baseGaps, timedByRun, families: options.families, expectedRows, qualityBase });
  for (const line of failureLines(parity)) out(line);
  for (const line of renderParityText(parity)) out(line);

  let exitCode = EXIT_PASS;
  if (gate.regressions.length > 0) exitCode = EXIT_REGRESSION;
  else if (parity.verdict === 'fail') exitCode = EXIT_BELOW_REFERENCE;
  const file: ParityRunFile = {
    schemaVersion: PARITY_SCHEMA_VERSION,
    generatedAt: report.generatedAt,
    families: options.families,
    quick: options.quick,
    scope,
    strictMode: report.strictMode,
    injectedRegression: report.settings.injectedRegression,
    exitCode,
    baseline: { compared: gate.compared, regressions: gate.regressions.map((regression) => regression.message) },
    parity,
  };
  fs.mkdirSync(options.outDir, { recursive: true });
  fs.writeFileSync(path.join(options.outDir, PARITY_VERDICT_FILE), `${JSON.stringify(file, null, 2)}\n`);
  fs.writeFileSync(path.join(options.outDir, PARITY_VERDICT_FILE.replace(/\.json$/, '.md')), renderParityMarkdown(parity));
  return exitCode;
}

