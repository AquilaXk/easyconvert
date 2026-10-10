/**
 * Replays recorded speed reports through the speed verdict: `npx tsx bench/replay-speed-reports.ts <report or directory>...`
 * (a directory is searched for `*-parity-speed.json` reports, such as the `bench-speed-results` artifact of a nightly run
 * or the `parity-speed-results` artifact of a pull request run). For each report it prints the rows that fail the gate
 * with the bench/parity-gaps.json of the working tree, and counts the rows decided by the A/B comparison with the base
 * (reports with `abPairs`) apart from the rows judged against the reference alone (older reports, or rows the base
 * cannot run). Rows listed in the gaps file are tracked as the gate tracks them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PARITY_GAPS_PATH } from './config';
import { evaluateParity } from './parity';
import { readGaps } from './parity-gaps';
import { validateReport } from './report';

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

if (require.main === module) {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    process.stderr.write('usage: tsx bench/replay-speed-reports.ts <report.json | directory>...\n');
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
}
