#!/usr/bin/env node
// Splits the registry conformance gate's work into parts of about equal recorded duration.
//
// The gate (tests/registry-engine-conformance.test.ts) used to give each `source->target` key to the part its SHA-256
// hash selected. Keys differ in cost by orders of magnitude (a 39-megapixel RAW decode against a text pair), so the
// parts ran from 108 s to 249 s in one CI run. This planner packs the keys by their recorded duration the way
// scripts/ci-test-shards.mjs packs test files (longest first, always into the lightest part), and puts the checks
// that only part 1 runs on part 1's side of the scale.
//
//   node scripts/ci-conformance-parts.mjs --summary <count>      planned load of every part, from the table's own keys
//   node scripts/ci-conformance-parts.mjs --update <recording>... merges recordings into the table
//
// A recording is written by the gate itself when CONFORMANCE_DURATIONS_OUT names a file:
//   CONFORMANCE_DURATIONS_OUT=conformance-recording.json npx vitest run tests/registry-engine-conformance.test.ts
// Durations live in .github/ci/conformance-durations.json (seconds per key). A key without an entry weighs the median of
// the recorded ones, so a new format is spread like an average one until the table is refreshed; a key the plan does
// not list at all falls back to the old hash rule, so no key can end up in no part.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SHARDS, planShards, ShardPlanError } from './ci-test-shards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFORMANCE_DURATIONS_FILE = path.join(ROOT, '.github', 'ci', 'conformance-durations.json');
/** Upper bounds on the table and a recording: a larger file is a mistake, not a plan. */
export const MAX_KEYS = 200_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const DURATION_DECIMALS = 100;
const HASH_PREFIX_BYTES = 4;

export class ConformancePlanError extends ShardPlanError {}

function readJson(file) {
  const text = readFileSync(file, 'utf8');
  if (text.length > MAX_FILE_BYTES) throw new ConformancePlanError(`${file} is over ${MAX_FILE_BYTES} bytes`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConformancePlanError(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkSeconds(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ConformancePlanError(`${where} must be a non-negative number of seconds`);
  return value;
}

/** Validates `{ firstPartSeconds, seconds: { key: seconds } }`. */
export function validateTable(value, where = 'the conformance duration table') {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConformancePlanError(`${where} must be an object`);
  const firstPartSeconds = checkSeconds(value.firstPartSeconds, `${where}: firstPartSeconds`);
  const seconds = value.seconds;
  if (typeof seconds !== 'object' || seconds === null || Array.isArray(seconds)) throw new ConformancePlanError(`${where}: seconds must be an object`);
  const entries = Object.entries(seconds);
  if (entries.length > MAX_KEYS) throw new ConformancePlanError(`${where}: at most ${MAX_KEYS} keys`);
  for (const [key, item] of entries) checkSeconds(item, `${where}: the duration of ${key}`);
  return { firstPartSeconds, seconds: Object.fromEntries(entries) };
}

export function loadConformanceDurations(file = CONFORMANCE_DURATIONS_FILE) {
  return validateTable(readJson(file), file);
}

/** The part (1-based) the old hash rule gave a key: the fallback for a key the plan does not list. */
export function hashPart(key, count) {
  return (createHash('sha256').update(key).digest().readUIntBE(0, HASH_PREFIX_BYTES) % count) + 1;
}

/**
 * Packs `keys` into `count` parts by recorded duration. Part 1 starts with `firstPartSeconds` of work, the checks only
 * part 1 runs. Returns the shard plan (`load`, `files` = keys, per part) and a lookup from key to part.
 */
export function planConformanceParts(keys, table, count) {
  if (keys.length > MAX_KEYS) throw new ConformancePlanError(`more than ${MAX_KEYS} keys`);
  const shards = planShards([...new Set(keys)], table.seconds, count, [table.firstPartSeconds]);
  const partOf = new Map();
  shards.forEach((shard, index) => {
    for (const key of shard.files) partOf.set(key, index + 1);
  });
  return { shards, partOf };
}

/** The part a key runs in: its place in the plan, or the hash rule when the plan does not list it. */
export function partOfKey(plan, key, count) {
  return plan.partOf.get(key) ?? hashPart(key, count);
}

/**
 * Merges recordings (`{ seconds: { key: seconds }, firstPartSeconds? }`) into a table: a recorded key replaces its
 * entry, the others stay. Seconds are rounded to centiseconds and the keys sorted, so the file diffs cleanly.
 */
export function mergeRecordings(table, recordings) {
  const seconds = { ...table.seconds };
  let firstPartSeconds = table.firstPartSeconds;
  for (const recording of recordings) {
    const checked = validateTable({ firstPartSeconds: recording.firstPartSeconds ?? firstPartSeconds, seconds: recording.seconds }, 'a recording');
    for (const [key, value] of Object.entries(checked.seconds)) seconds[key] = Math.round(value * DURATION_DECIMALS) / DURATION_DECIMALS;
    if (recording.firstPartSeconds !== undefined) firstPartSeconds = Math.round(checked.firstPartSeconds * DURATION_DECIMALS) / DURATION_DECIMALS;
  }
  return { firstPartSeconds, seconds: Object.fromEntries(Object.entries(seconds).sort(([a], [b]) => (a < b ? -1 : 1))) };
}

function main(argv) {
  const [first, ...rest] = argv;
  if (first === '--update') {
    if (rest.length === 0) throw new ConformancePlanError('--update needs at least one recording');
    const merged = mergeRecordings(loadConformanceDurations(), rest.map((file) => readJson(file)));
    writeFileSync(CONFORMANCE_DURATIONS_FILE, `${JSON.stringify(merged, null, 2)}\n`);
    return;
  }
  if (first === '--summary') {
    const count = Number(rest[0]);
    if (!Number.isInteger(count) || count < 1 || count > MAX_SHARDS) throw new ConformancePlanError(`usage: ci-conformance-parts.mjs --summary <count from 1 to ${MAX_SHARDS}>`);
    const table = loadConformanceDurations();
    const { shards } = planConformanceParts(Object.keys(table.seconds), table, count);
    shards.forEach((shard, index) => console.log(`part ${index + 1}: ${shard.files.length} keys, ${shard.load.toFixed(1)} s`));
    return;
  }
  throw new ConformancePlanError('usage: ci-conformance-parts.mjs --summary <count> | --update <recording>...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
