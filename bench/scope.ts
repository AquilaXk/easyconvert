import { QUICK_SUBSET } from './config';

/**
 * Which cases a run measures. A full run measures every case; `--quick` measures the cases listed per family in
 * QUICK_SUBSET (a family listed as null, or absent, is measured whole).
 */
export function caseInScope(quick: boolean, family: string, caseName: string): boolean {
  if (!quick) return true;
  const subset = QUICK_SUBSET[family];
  return subset === undefined || subset === null || subset.includes(caseName);
}

/** The same decision for a row id `<family>/<case>/<metric>`; a case name never contains a slash. */
export function rowInScope(quick: boolean, rowId: string): boolean {
  const [family, caseName] = rowId.split('/');
  return caseInScope(quick, family, caseName);
}
