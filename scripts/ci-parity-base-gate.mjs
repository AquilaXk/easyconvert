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

/** The files that decide whether a speed row passes. Keep this list to verdict and threshold code, not to what a family measures. */
export const GATE_FILES = [
  'bench/parity.ts',
  'bench/parity-gaps.ts',
  'bench/speed-history.ts',
  'bench/speed-parity.ts',
  'bench/ab-config.ts',
  'bench/ab-speed.ts',
  'bench/ab-host.ts',
  'bench/ab-child.ts',
  'bench/ab-protocol.ts',
  'bench/product.ts',
  'bench/gate.ts',
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
