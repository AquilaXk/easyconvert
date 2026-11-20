/**
 * XLOOKUP and XMATCH, translated to TypeScript from IronCalc.
 *
 * Source: ironcalc/IronCalc (https://github.com/ironcalc/IronCalc), commit f93662006b8fb1c401dc870bbda26c5d60ac6037,
 *   - base/src/functions/xlookup.rs (SHA-256 fceafa2c16717f1acf841b7e15c6e2f6deb0f8eeb70b8f9e04f3eefa1e06efc4):
 *     `linear_search`, the match and search modes, and the checks `fn_xlookup` makes on its arguments;
 *   - base/src/functions/util.rs: `compare_values` (numbers sort before text, text before booleans, text without regard to
 *     case, an empty cell as the zero of the type next to it).
 * Licence: MIT OR Apache-2.0 (used here under MIT).
 *
 * MIT License
 *
 * Copyright 2023 EqualTo GmbH
 * Copyright 2023 - Present IronCalc contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Changes from the original: the arguments arrive as the values of the vendored parser (a vector is a two-dimensional array
 * with one row or one column, an empty cell is `null`); the binary search modes (2 and -2) are answered by the same linear
 * scan, which finds the same cell in sorted data, the only data those modes are defined for; XMATCH, which IronCalc does not
 * have, returns the position the search finds.
 */
import FormulaParser from './vendor/fast-formula-parser';

const { FormulaError, WildCard } = FormulaParser;

type SearchMode = 1 | -1 | 2 | -2;
type MatchMode = -1 | 0 | 1 | 2;

interface ReceivedArg {
  value?: unknown;
  omitted?: boolean;
}

const TYPE_RANK = { number: 0, string: 1, boolean: 2 } as const;

/** Sort order of two cell values: -1, 0 or 1. An empty cell takes the zero of the type next to it. */
function compareValues(left: unknown, right: unknown): number {
  let a = left;
  let b = right;
  if (a === null || a === undefined) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null || b === undefined) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const rankA = TYPE_RANK[typeof a as keyof typeof TYPE_RANK];
  const rankB = TYPE_RANK[typeof b as keyof typeof TYPE_RANK];
  if (rankA === undefined || rankB === undefined) return rankA === undefined ? 1 : -1;
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  if (typeof a === 'string') {
    const x = a.toUpperCase();
    const y = (b as string).toUpperCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const diff = (b as number) - (a as number);
  if (Math.abs(diff) < Number.EPSILON) return 0;
  return (a as number) < (b as number) ? -1 : 1;
}

/** The position of the match in `array`, searching from the first item or the last. */
function search(lookup: unknown, array: unknown[], searchMode: SearchMode, matchMode: MatchMode): number | undefined {
  const length = array.length;
  const indexAt = (step: number): number => (searchMode === 1 || searchMode === 2 ? step : length - step - 1);

  if (matchMode === 0) {
    for (let step = 0; step < length; step++) {
      const index = indexAt(step);
      if (compareValues(array[index], lookup) === 0) return index;
    }
    return undefined;
  }
  if (matchMode === -1 || matchMode === 1) {
    // Exact match; none found gives the next smaller (-1) or larger (1) item.
    let foundIndex: number | undefined;
    for (let step = 0; step < length; step++) {
      const index = indexAt(step);
      const value = array[index];
      const c = compareValues(value, lookup);
      if (c === 0) return index;
      if (c === matchMode && (foundIndex === undefined || compareValues(array[foundIndex], value) === matchMode)) {
        foundIndex = index;
      }
    }
    return foundIndex;
  }
  const matches: (value: unknown) => boolean =
    typeof lookup === 'string'
      ? ((re) => (value) => typeof value === 'string' && re.test(value))(WildCard.toExactRegex(lookup))
      : (value) => compareValues(value, lookup) === 0;
  for (let step = 0; step < length; step++) {
    const index = indexAt(step);
    if (matches(array[index])) return index;
  }
  return undefined;
}

function vectorOf(arg: ReceivedArg | null): unknown[] | undefined {
  const value = arg?.value;
  if (!Array.isArray(value)) return [value];
  const rows = value as unknown[][];
  if (rows.length === 1) return rows[0];
  if (rows.every((row) => row.length === 1)) return rows.map((row) => row[0]);
  return undefined;
}

function optionalNumber(arg: ReceivedArg | null | undefined): number | undefined | FormulaErrorValue {
  if (arg === null || arg === undefined || arg.omitted) return undefined;
  const v = arg.value;
  if (v instanceof FormulaError) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : FormulaError.VALUE;
}

type FormulaErrorValue = InstanceType<typeof FormulaError>;

const MATCH_MODES: readonly number[] = [-1, 0, 1, 2];
const SEARCH_MODES: readonly number[] = [-2, -1, 1, 2];

function readModes(matchArg?: ReceivedArg | null, searchArg?: ReceivedArg | null): { match: MatchMode; search: SearchMode } | FormulaErrorValue {
  const match = optionalNumber(matchArg);
  if (match instanceof FormulaError) return match;
  const searchMode = optionalNumber(searchArg);
  if (searchMode instanceof FormulaError) return searchMode;
  if ((match !== undefined && !MATCH_MODES.includes(match)) || (searchMode !== undefined && !SEARCH_MODES.includes(searchMode))) {
    return FormulaError.VALUE;
  }
  return { match: (match ?? 0) as MatchMode, search: (searchMode ?? 1) as SearchMode };
}

/** `XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])`. */
export function xlookup(...args: Array<ReceivedArg | null>): unknown {
  if (args.length < 3 || args.length > 6) return FormulaError.NA;
  const lookup = args[0]?.value;
  if (lookup instanceof FormulaError) return lookup;
  const modes = readModes(args[4], args[5]);
  if (modes instanceof FormulaError) return modes;
  const lookupVector = vectorOf(args[1]);
  const returnVector = vectorOf(args[2]);
  if (!lookupVector || !returnVector || lookupVector.length !== returnVector.length) return FormulaError.VALUE;
  const index = search(lookup, lookupVector, modes.search, modes.match);
  if (index !== undefined) return returnVector[index];
  const notFound = args[3];
  return notFound && !notFound.omitted ? notFound.value : FormulaError.NA;
}

/** `XMATCH(lookup_value, lookup_array, [match_mode], [search_mode])`. */
export function xmatch(...args: Array<ReceivedArg | null>): unknown {
  if (args.length < 2 || args.length > 4) return FormulaError.NA;
  const lookup = args[0]?.value;
  if (lookup instanceof FormulaError) return lookup;
  const modes = readModes(args[2], args[3]);
  if (modes instanceof FormulaError) return modes;
  const lookupVector = vectorOf(args[1]);
  if (!lookupVector) return FormulaError.VALUE;
  const index = search(lookup, lookupVector, modes.search, modes.match);
  return index === undefined ? FormulaError.NA : index + 1;
}
