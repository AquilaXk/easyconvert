/**
 * The stratified draw of the regression corpus. A file's stratum is its format, the class of the application that wrote it and
 * its size class. The budget of a group (a format, or a format from one source) is shared equally between the strata of the
 * group: a stratum with fewer files than its share is taken whole and gives the rest of its share to the others (max-min
 * fairness). Rare producers and unusual sizes therefore stay in the corpus entirely, where a draw in proportion to the
 * population would drop them. Within a stratum the files are taken in the order of the hash of their id, so the draw does not
 * depend on the order of the pool.
 */
import { createHash } from 'node:crypto';

const KIB = 1024;

/** Upper bounds (exclusive) of the size classes; a file at or above the last bound is `huge`. */
const SIZE_CLASS_BOUNDS: ReadonlyArray<readonly [string, number]> = [
  ['small', 64 * KIB],
  ['medium', 512 * KIB],
  ['large', 2 * KIB * KIB],
];
const LARGEST_SIZE_CLASS = 'huge';

export type SizeClass = 'small' | 'medium' | 'large' | 'huge';

export function sizeClassOf(bytes: number): SizeClass {
  const found = SIZE_CLASS_BOUNDS.find(([, below]) => bytes < below);
  return (found === undefined ? LARGEST_SIZE_CLASS : found[0]) as SizeClass;
}

export interface StratumCandidate {
  id: string;
  /** Registry format of the file. */
  format: string;
  producerClass: string;
  size: number;
  /** The budget group the file draws from: its format, or its format and source where a format has two. */
  group: string;
}

export const stratumOf = (candidate: StratumCandidate): string => `${candidate.format}|${candidate.producerClass}|${sizeClassOf(candidate.size)}`;

/** How many files each stratum gives, for stratum populations in the given order, so that the total is the budget or the whole population. */
export function allocate(populations: readonly number[], budget: number): number[] {
  const order = populations.map((population, index) => ({ population, index })).sort((a, b) => a.population - b.population || a.index - b.index);
  const taken = new Array<number>(populations.length).fill(0);
  let remaining = Math.max(0, budget);
  order.forEach(({ population, index }, position) => {
    const share = Math.floor(remaining / (order.length - position));
    taken[index] = Math.min(population, share);
    remaining -= taken[index];
  });
  return taken;
}

const hashOf = (id: string): string => createHash('sha256').update(id).digest('hex');

/** The files drawn for the budgets of the groups (a group without a budget draws nothing), sorted by id. */
export function selectStratified<T extends StratumCandidate>(pool: readonly T[], budgets: Readonly<Record<string, number>>): T[] {
  const chosen: T[] = [];
  for (const [group, budget] of Object.entries(budgets)) {
    const strata = new Map<string, T[]>();
    for (const candidate of pool.filter((entry) => entry.group === group)) {
      const key = stratumOf(candidate);
      strata.set(key, [...(strata.get(key) ?? []), candidate]);
    }
    const keys = [...strata.keys()].sort();
    const counts = allocate(keys.map((key) => strata.get(key)!.length), budget);
    keys.forEach((key, index) => {
      const ordered = strata.get(key)!.map((entry) => ({ entry, hash: hashOf(entry.id) })).sort((a, b) => (a.hash < b.hash ? -1 : 1));
      chosen.push(...ordered.slice(0, counts[index]).map(({ entry }) => entry));
    });
  }
  return chosen.sort((a, b) => (a.id < b.id ? -1 : 1));
}
