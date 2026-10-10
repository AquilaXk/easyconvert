#!/usr/bin/env node
// Puts the gate of the base commit in place of the one of the change under test, so that a pull request cannot loosen
// the verdict that judges it:
//
//   node ab-base/scripts/ci-parity-base-gate.mjs ab-base
//
// run from the root of the tested checkout, with the checkout of the base commit as its argument (and run from that
// checkout's copy of this script, which the workflow does). It copies the gate files (the speed verdict, its thresholds
// and overrides, the A/B machinery) from the base over the tested tree. A file the base does not have is left alone, so the
// change that introduces a gate file is judged by its own. The family runners, the rows, the corpus and the baseline stay
// the change's: a change that adds a family or a row is measured with it. Prints every file it replaced.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The files that decide whether a speed row passes, and the inputs they read: the verdict and the exit code (judge, parity,
 * gate), the rules and constants that judge (speed-config, speed-parity, speed-history, ab-config, ab-speed), how a speed row
 * is timed and built (speed-timing, speed-rows, the A/B host, child and protocol), the shape of a row a verdict can read
 * (report-schema), and the plain helpers under them (stats, errors, parity-gaps, product). What a family measures stays
 * the change's: bench/rows.ts (the metric specs of the quality rows), bench/config.ts (paths, quick subset), bench/report.ts
 * (the family names), bench/context.ts, bench/run.ts and every family runner.
 */
export const GATE_FILES = [
  'bench/judge.ts',
  'bench/parity.ts',
  'bench/parity-gaps.ts',
  'bench/gate.ts',
  'bench/speed-config.ts',
  'bench/speed-parity.ts',
  'bench/speed-history.ts',
  'bench/speed-timing.ts',
  'bench/speed-rows.ts',
  'bench/report-schema.ts',
  'bench/ab-config.ts',
  'bench/ab-speed.ts',
  'bench/ab-host.ts',
  'bench/ab-child-core.ts',
  'bench/ab-protocol.ts',
  'bench/product.ts',
  'bench/stats.ts',
  'bench/errors.ts',
];

/** Copies the gate files of `baseDir` over those of `targetDir`; returns the files it replaced and those the base lacks. */
export function takeBaseGate(baseDir, targetDir = '.') {
  const replaced = [];
  const missing = [];
  for (const file of GATE_FILES) {
    const from = path.join(baseDir, file);
    const to = path.join(targetDir, file);
    if (!existsSync(from)) {
      missing.push(file);
      continue;
    }
    if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
    copyFileSync(from, to);
    replaced.push(file);
  }
  return { replaced, missing };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseDir = process.argv[2];
  if (!baseDir) {
    console.error('usage: node ci-parity-base-gate.mjs <checkout of the base commit>');
    process.exit(2);
  }
  const { replaced, missing } = takeBaseGate(baseDir);
  for (const file of replaced) console.log(`gate of the base: ${file}`);
  for (const file of missing) console.log(`::notice::${file} is not in the base: the change's own is used`);
  if (replaced.length === 0) console.log('the gate of the base is the one of the change');
}
