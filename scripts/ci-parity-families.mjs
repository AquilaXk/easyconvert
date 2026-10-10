#!/usr/bin/env node
// Maps the files a pull request changes to the benchmark families the reference-parity gate must run.
//
//   git diff --name-only <base> HEAD | node scripts/ci-parity-families.mjs
//
// prints four lines for the `changes` job of ci.yml:
//   families=<comma list>    benchmarked families to measure (those whose `bench` is set in the map)
//   specific=<comma list>    the part of `families` that a rule names itself; a family reached only through the
//                            all-family rules ("*") is not in it
//   unmapped=<comma list>    conversion families that have no reference-compared bench rows yet
//   unclassified=<comma list> conversion paths no rule of bench/family-map.json covers (exit status 1)
//
// The map is data (bench/family-map.json). A path inside its `scope` must match a rule, so a new conversion file
// cannot escape the gate by being unlisted; a path outside the scope is not conversion code and maps to nothing.
// A family whose `bench` is null has no benchmark rows: a change to it fails the gate with "add reference-compared
// bench rows for <family>" until the same change adds the rows (a runner in bench/families/) and sets the family's
// `bench` to its own name; tests/ci-parity-families.test.ts keeps the map and the runners in step.
//
// This file needs no installed dependencies: the `changes` job runs it straight after checkout.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAMILY_MAP_FILE = path.join(ROOT, 'bench', 'family-map.json');
/** Rule value that stands for every benchmarked family (shared code every conversion passes through). */
export const ALL_FAMILIES = '*';
/** Upper bounds on untrusted sizes: a larger input is a mistake, not a plan. */
export const MAX_CHANGED_PATHS = 100_000;
export const MAX_PATH_LENGTH = 1024;
export const MAX_RULES = 200;
export const MAX_PATTERN_LENGTH = 2000;
const MAP_SCHEMA_VERSION = 1;
const FAMILY_NAME = /^[a-z][a-z0-9-]*$/;
/** The files whose rows belong to families: a rule with `rows` maps such a file by the rows that changed, not by its name. */
const ROW_FILE_KINDS = new Set(['baseline', 'gaps']);
const MAX_MAP_BYTES = 1024 * 1024;

export class FamilyMapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FamilyMapError';
  }
}

function compile(pattern, where) {
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > MAX_PATTERN_LENGTH) {
    throw new FamilyMapError(`${where} must be a non-empty pattern of at most ${MAX_PATTERN_LENGTH} characters`);
  }
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new FamilyMapError(`${where} is not a valid pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validates a parsed map and returns it with its patterns compiled. */
export function validateFamilyMap(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new FamilyMapError('family map must be an object');
  if (value.schemaVersion !== MAP_SCHEMA_VERSION) throw new FamilyMapError(`family map schemaVersion must be ${MAP_SCHEMA_VERSION}`);
  const scope = compile(value.scope, 'scope');
  if (typeof value.families !== 'object' || value.families === null || Array.isArray(value.families)) throw new FamilyMapError('families must be an object');
  const families = new Map();
  for (const [name, entry] of Object.entries(value.families)) {
    if (name === ALL_FAMILIES || !FAMILY_NAME.test(name)) throw new FamilyMapError(`"${name}" cannot name a family`);
    const bench = entry?.bench;
    // A benchmarked family is measured under its own name: bench/families/<name>.ts and the --family flag use it.
    if (bench !== null && bench !== name) throw new FamilyMapError(`families.${name}.bench must be null or "${name}"`);
    families.set(name, bench);
  }
  const benchmarked = [...families].filter(([, bench]) => bench !== null).map(([name]) => name);
  if (benchmarked.length === 0) throw new FamilyMapError('at least one family must be benchmarked');
  if (!Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > MAX_RULES) {
    throw new FamilyMapError(`rules must be a list of 1 to ${MAX_RULES} rules`);
  }
  const rules = value.rules.map((rule, index) => {
    const where = `rules[${index}]`;
    if (!Array.isArray(rule?.families) || rule.families.length === 0) throw new FamilyMapError(`${where}.families must be a non-empty list`);
    for (const name of rule.families) {
      if (name !== ALL_FAMILIES && !families.has(name)) throw new FamilyMapError(`${where} names the unknown family ${String(name)}`);
    }
    if (rule.rows !== undefined && !ROW_FILE_KINDS.has(rule.rows)) throw new FamilyMapError(`${where}.rows must be "baseline" or "gaps"`);
    return { families: rule.families, match: compile(rule.match, `${where}.match`), rows: rule.rows };
  });
  return { scope, families, benchmarked, rules };
}

export function loadFamilyMap(file = FAMILY_MAP_FILE) {
  const text = readFileSync(file, 'utf8');
  if (text.length > MAX_MAP_BYTES) throw new FamilyMapError(`${file} is over ${MAX_MAP_BYTES} bytes`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new FamilyMapError(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateFamilyMap(parsed);
}

/**
 * Classifies changed paths. `benchmarked` lists the families to measure, in harness order; `unmapped` the conversion
 * families without bench rows; `unclassified` the paths inside the scope that no rule covers.
 */
export function classifyPaths(paths, map, options = {}) {
  if (paths.length > MAX_CHANGED_PATHS) throw new FamilyMapError(`more than ${MAX_CHANGED_PATHS} changed paths`);
  const benchmarked = new Set();
  const specific = new Set();
  const unmapped = new Set();
  const unclassified = [];
  for (const file of paths) {
    if (file.length > MAX_PATH_LENGTH) throw new FamilyMapError(`a changed path is longer than ${MAX_PATH_LENGTH} characters`);
    if (!map.scope.test(file)) continue;
    const rule = map.rules.find((candidate) => candidate.match.test(file));
    if (!rule) {
      unclassified.push(file);
      continue;
    }
    const rowIds = rule.rows === undefined ? null : (options.changedRows?.(file, rule.rows) ?? null);
    if (rowIds !== null) {
      // A file of rows maps by the families of the rows that changed; a row of a family the map does not know could be anything.
      for (const id of rowIds) {
        const name = id.split('/')[0];
        if (!map.families.has(name)) {
          for (const bench of map.benchmarked) {
            benchmarked.add(bench);
            specific.add(bench);
          }
        } else if (map.families.get(name) === null) {
          unmapped.add(name);
        } else {
          benchmarked.add(map.families.get(name));
          specific.add(map.families.get(name));
        }
      }
      continue;
    }
    for (const name of rule.families) {
      if (name === ALL_FAMILIES) {
        for (const bench of map.benchmarked) {
          benchmarked.add(bench);
          // A row file whose rows cannot be told apart stands for rows of any family: nothing is shared about it.
          if (rule.rows !== undefined) specific.add(bench);
        }
        continue;
      }
      const bench = map.families.get(name);
      if (bench === null) {
        unmapped.add(name);
      } else {
        benchmarked.add(bench);
        specific.add(bench);
      }
    }
  }
  return {
    benchmarked: map.benchmarked.filter((name) => benchmarked.has(name)),
    specific: map.benchmarked.filter((name) => specific.has(name)),
    unmapped: [...unmapped].sort(),
    unclassified: unclassified.sort(),
  };
}

/** Rows of a parsed row file by id, or null when the file is not shaped like one. */
function rowsById(kind, value) {
  if (kind === 'baseline') {
    const entries = value?.entries;
    return entries !== null && typeof entries === 'object' && !Array.isArray(entries) ? entries : null;
  }
  const gaps = value?.gaps;
  return Array.isArray(gaps) ? Object.fromEntries(gaps.map((gap) => [gap?.id, gap])) : null;
}

/** Ids of the rows that differ between two parsed row files, or null when either is not shaped like one. */
export function changedRowIds(kind, before, after) {
  const old = rowsById(kind, before);
  const next = rowsById(kind, after);
  if (old === null || next === null) return null;
  const ids = new Set([...Object.keys(old), ...Object.keys(next)]);
  return [...ids].filter((id) => JSON.stringify(old[id]) !== JSON.stringify(next[id]));
}

const ABSENT_AT_BASE = /does not exist in|exists on disk, but not in/;

/** The text of `file` at `sha`: null when the commit has no such file, an error when the commit cannot be read. */
function gitShow(sha, file, root) {
  execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' });
  try {
    return execFileSync('git', ['show', `${sha}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (ABSENT_AT_BASE.test(String(error?.stderr ?? ''))) return null;
    throw error;
  }
}

/**
 * The `changedRows` reader for a change measured against `baseSha`: the row file in the working tree against the file
 * at the base. It answers null (every family) when there is no base, the base cannot be read or a file is not a row file.
 */
export function gitChangedRows(baseSha, root = ROOT, readBase = gitShow) {
  if (!baseSha) return () => null;
  return (file, kind) => {
    try {
      const old = readBase(baseSha, file, root);
      const before = old === null ? { entries: {}, gaps: [] } : JSON.parse(old);
      return changedRowIds(kind, before, JSON.parse(readFileSync(path.join(root, file), 'utf8')));
    } catch {
      return null;
    }
  };
}

function main() {
  const paths = readFileSync(0, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const result = classifyPaths(paths, loadFamilyMap(), { changedRows: gitChangedRows(process.env.PR_BASE_SHA) });
  console.log(`families=${result.benchmarked.join(',')}`);
  console.log(`specific=${result.specific.join(',')}`);
  console.log(`unmapped=${result.unmapped.join(',')}`);
  console.log(`unclassified=${result.unclassified.join(',')}`);
  if (result.unclassified.length > 0) {
    console.error(`::error::no rule in bench/family-map.json covers ${result.unclassified.join(', ')}; classify the path under a benchmarked family or one that needs bench rows`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
