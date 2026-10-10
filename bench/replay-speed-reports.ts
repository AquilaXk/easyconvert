/**
 * Replays recorded speed reports through the speed verdict: `npx tsx bench/replay-speed-reports.ts <report or directory>...`
 * (a directory is searched for `*-parity-speed.json` reports, such as the `bench-speed-results` artifact of a nightly run
 * or the `parity-speed-results` artifact of a pull request run). For each report it prints the rows that fail the gate
 * with the bench/parity-gaps.json of the working tree, and counts the rows decided by the A/B comparison with the base
 * (reports with `abPairs`) apart from the rows judged against the reference alone (older reports, or rows the base
 * cannot run). Rows listed in the gaps file are tracked as the gate tracks them.
 *
 * With `--noise-out <file>`, reports of a commit compared with itself (the nightly dispatch `ab_base_ref`) are also summed
 * up per row into the file the simulation reads (bench/ab-noise-samples.json): the noise of the comparison (the standard
 * deviation of the log of the pair ratios, the median over the reports), the bias (the mean log of the head-to-base median,
 * which is 0 when the comparison is fair) and whether the row is heavy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PARITY_GAPS_PATH } from './config';
import { evaluateParity } from './parity';
import { readGaps } from './parity-gaps';
import { type BenchReport, validateReport } from './report';
import { mean, median } from './stats';

function reportFiles(input: string): string[] {
  if (!fs.statSync(input).isDirectory()) return [input];
  return fs.readdirSync(input, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('-parity-speed.json')).map((name) => path.join(input, name)).sort();
}

export interface ReplaySummary {
  report: string;
  rows: number;
  abRows: number;
  failures: string[];
}

export function replay(file: string, gapsPath: string = PARITY_GAPS_PATH): ReplaySummary {
  const report = validateReport(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  const verdict = evaluateParity(report, readGaps(gapsPath));
  const speed = report.rows.filter((row) => row.status === 'measured' && row.kind === 'throughput');
  return {
    report: file,
    rows: speed.length,
    abRows: speed.filter((row) => row.abPairs !== undefined).length,
    failures: verdict.rows.filter((row) => row.outcome === 'fail' && row.metric === 'throughput').map((row) => `${row.id} [${row.basis}] ${row.detail}`),
  };
}

const HEAVY_FAMILIES: ReadonlySet<string> = new Set(['video', 'ocr', 'document']);

export interface NoiseRow {
  id: string;
  weight: 'light' | 'heavy';
  /** Median over the reports of the standard deviation of the log of the pair ratios. */
  noise: number;
  /** Mean over the reports of the log of the median head-to-base ratio: 0 when two copies of one code are measured alike. */
  bias: number;
  /** Median over the reports of the milliseconds one pair took (the simulation spends the extra budget with it). */
  pairMs: number;
  reports: number;
}

/** The noise and the bias of every speed row over reports of a commit compared with itself. */
export function noiseSamples(reports: readonly BenchReport[]): NoiseRow[] {
  const byRow = new Map<string, { noise: number[]; bias: number[]; pairMs: number[] }>();
  for (const report of reports) {
    for (const row of report.rows) {
      if (row.status !== 'measured' || row.kind !== 'throughput' || row.abNoise === undefined || row.abMedian === undefined) continue;
      const entry = byRow.get(row.id) ?? { noise: [], bias: [], pairMs: [] };
      entry.noise.push(row.abNoise);
      if (row.abPairMs !== undefined) entry.pairMs.push(row.abPairMs);
      entry.bias.push(Math.log(row.abMedian));
      byRow.set(row.id, entry);
    }
  }
  return [...byRow].map(([id, entry]) => ({
    id,
    weight: HEAVY_FAMILIES.has(id.split('/')[0]) ? 'heavy' : 'light',
    noise: Number(median(entry.noise).toFixed(4)),
    bias: Number(mean(entry.bias).toFixed(4)),
    pairMs: entry.pairMs.length > 0 ? Math.round(median(entry.pairMs)) : 0,
    reports: entry.noise.length,
  }));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const noiseAt = args.indexOf('--noise-out');
  const noiseOut = noiseAt >= 0 ? args[noiseAt + 1] : null;
  const inputs = args.filter((_, index) => noiseAt < 0 || (index !== noiseAt && index !== noiseAt + 1));
  if (inputs.length === 0) {
    process.stderr.write('usage: tsx bench/replay-speed-reports.ts [--noise-out file] <report.json | directory>...\n');
    process.exit(2);
  }
  let reports = 0;
  let rows = 0;
  let failing = 0;
  for (const file of inputs.flatMap(reportFiles)) {
    const summary = replay(file);
    reports++;
    rows += summary.rows;
    failing += summary.failures.length;
    console.log(`${summary.report}: ${summary.rows} speed rows, ${summary.abRows} compared with the base, ${summary.failures.length} failing`);
    for (const failure of summary.failures) console.log(`  ${failure}`);
  }
  console.log(`${reports} reports, ${rows} speed rows, ${failing} failing rows`);
  if (noiseOut) {
    const parsed = inputs.flatMap(reportFiles).map((file) => validateReport(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown));
    fs.writeFileSync(noiseOut, `${JSON.stringify({ reports: parsed.length, rows: noiseSamples(parsed) }, null, 2)}\n`);
    console.log(`noise of ${parsed.length} reports written to ${noiseOut}`);
  }
}
