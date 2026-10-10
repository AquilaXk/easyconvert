/**
 * The thresholds of the A/B speed comparison (bench/ab-speed.ts). They are the gate's own numbers, so a pull request is
 * judged by the ones of its base: the `parity speed` job takes this file, with the other gate files, from the base
 * commit (scripts/ci-base-gate.mjs).
 */

/**
 * Each pair times the head, the base and the reference once, in a rotating order of six; the pairs are a multiple of six
 * so that every order runs equally often. A row fails only when the head is credibly slower than the base: the one-sided
 * upper confidence bound of the median head-to-base speed ratio is below the row's slowdown line (below). The bound's error
 * rate is the family-wise level shared by AB_ROW_BUDGET rows (Bonferroni), so a run of unchanged code fails with a
 * probability under AB_FAMILYWISE_ALPHA. The pair counts are the fewest that give the sign test a bound at that rate
 * with ranks 4 and 2 (P(Binomial(24, 1/2) <= 3) = 1.4e-4, P(Binomial(18, 1/2) <= 1) = 7.2e-5, both under 0.01 / 50).
 */
export const AB_LIGHT_PAIRS = 24;
export const AB_HEAVY_PAIRS = 18;
export const AB_FAMILYWISE_ALPHA = 0.01;
export const AB_ROW_BUDGET = 50;
/** The sign-test interval, and so the pair count of a row, is exact up to this many pairs. */
export const AB_MAX_PAIRS = 60;

/**
 * The regression threshold: a row fails when the head takes more than this share more time than the base, with the
 * confidence above. It is the size of a change worth stopping, not the 3 percent the reference may lead by.
 */
export const AB_DEFAULT_REGRESSION = 0.1;

export interface AbRegressionOverride {
  /** The share of extra time that counts as a regression for this row. */
  delta: number;
  /** Why the default does not fit: the A/B noise or the bias measured for the row, and the run that measured it. */
  reason: string;
}

/**
 * Rows with their own threshold. An entry needs the measurement that justifies it in its reason, names a row of
 * bench/baseline.json, and sets a threshold above the default only when the measured noise of the row needs it, or
 * below it (5 percent) when the row is worth guarding more closely (tests/bench-ab-speed.test.ts checks the form).
 */
export const AB_ROW_REGRESSION: Readonly<Record<string, AbRegressionOverride>> = {};

/**
 * A row whose bound is too wide to show, with margin, a slowdown of 1.25 times its threshold (a bound at that width fails the row half of the time at 1.25 times and almost always at 1.5 times) gets more pairs, six at a time up to
 * AB_MAX_PAIRS, while the extra measuring time of the job lasts. The width of the bound does not depend on whether the
 * head is slower, so extending on it does not change the error rate of the verdict.
 */
export const AB_EXTRA_STEP_PAIRS = 6;
export const AB_DETECTABLE_FACTOR = 1.25;
export const AB_EXTRA_BUDGET_MS = 12 * 60 * 1000;
