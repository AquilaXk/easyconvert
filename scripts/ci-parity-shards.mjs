#!/usr/bin/env node
// Requires a speed shard for every family whose known-gap entries a pull request adds or changes.
//
//   PR_BASE_SHA=<base> node scripts/ci-parity-shards.mjs <families the run measures, comma list>
//
// A speed shard backs the gap entries of its own family only (bench/parity.ts), so an entry whose family no shard measures
// would pass unchecked. The families that must be measured come from the base commit's bench/family-map.json and
// bench/parity-gaps.json and from the ids of the entries that differ from the working tree's, never from the family map
// of the change: a change cannot map its own gap entries away from the shard that would back them.
//
// This file needs no installed dependencies: the `changes` job runs it after the families are mapped.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedRowIds, gitShow, validateFamilyMap } from './ci-parity-families.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAPS_FILE = 'bench/parity-gaps.json';
const MAP_FILE = 'bench/family-map.json';

/**
 * The benchmarked families that must have a shard: those of the entries that differ between `baseGaps` and `headGaps`
 * under the family map `baseMap` (parsed JSON). An entry of a family the map does not know, or a gap file that is not
 * shaped like one, calls for every family.
 */
export function requiredShards(baseMap, baseGaps, headGaps) {
  const map = validateFamilyMap(baseMap);
  const ids = changedRowIds('gaps', baseGaps, headGaps);
  if (ids === null) return [...map.benchmarked];
  const required = new Set();
  for (const id of ids) {
    const family = String(id).split('/')[0];
    if (!map.families.has(family)) return [...map.benchmarked];
    const bench = map.families.get(family);
    if (bench !== null) required.add(bench);
  }
  return map.benchmarked.filter((name) => required.has(name));
}

/** The required families that `shards` does not list. */
export function missingShards(required, shards) {
  const present = new Set(shards);
  return required.filter((family) => !present.has(family));
}

function main() {
  const baseSha = process.env.PR_BASE_SHA;
  if (!baseSha) {
    console.log('no base commit: every family is measured');
    return 0;
  }
  const shards = (process.argv[2] ?? '').split(',').filter((name) => name !== '');
  const baseMap = gitShow(baseSha, MAP_FILE, ROOT);
  if (baseMap === null) throw new Error(`${MAP_FILE} is not in the base commit`);
  const baseGaps = gitShow(baseSha, GAPS_FILE, ROOT);
  const required = requiredShards(
    JSON.parse(baseMap),
    baseGaps === null ? { gaps: [] } : JSON.parse(baseGaps),
    JSON.parse(readFileSync(path.join(ROOT, GAPS_FILE), 'utf8'))
  );
  const missing = missingShards(required, shards);
  console.log(`known-gap entries changed in: ${required.join(',') || 'none'}; speed shards: ${shards.join(',') || 'none'}`);
  for (const family of missing) {
    console.error(`::error::${GAPS_FILE} changes entries of ${family}, but no speed shard measures ${family}; its entries would pass unchecked`);
  }
  return missing.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
