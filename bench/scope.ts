import { CORPUS_TIER_ENV, QUICK_PUBLIC_SUBSET, QUICK_SUBSET } from './config';
import { isRemoteCase } from './corpora';
import { BenchArgumentError } from './errors';

/**
 * Which cases a run measures. A full run measures every case; `--quick` measures the cases listed per family in
 * QUICK_SUBSET (a family listed as null, or absent, is measured whole).
 *
 * The cases of the public sample sets (bench/corpus/remote-manifest.json) follow their own rule: `--quick` measures the ones
 * QUICK_PUBLIC_SUBSET names; a run without it measures all of them, unless BENCH_CORPUS_TIER=pr says the run is the speed job
 * of a pull request, which times the generated corpus only.
 */
export type CorpusTier = 'pr' | 'full';

export function corpusTier(env: Readonly<Record<string, string | undefined>> = process.env): CorpusTier {
  const value = env[CORPUS_TIER_ENV];
  if (value === undefined || value === '' || value === 'full') return 'full';
  if (value === 'pr') return 'pr';
  throw new BenchArgumentError(`${CORPUS_TIER_ENV} must be "pr" or "full", not "${value}"`);
}

export function caseInScope(quick: boolean, family: string, caseName: string): boolean {
  if (isRemoteCase(caseName)) {
    if (quick) return (QUICK_PUBLIC_SUBSET[family] ?? []).includes(caseName);
    return corpusTier() === 'full';
  }
  if (!quick) return true;
  const subset = QUICK_SUBSET[family];
  return subset === undefined || subset === null || subset.includes(caseName);
}

/** The same decision for a row id `<family>/<case>/<metric>`; a case name never contains a slash. */
export function rowInScope(quick: boolean, rowId: string): boolean {
  const [family, caseName] = rowId.split('/');
  return caseInScope(quick, family, caseName);
}
