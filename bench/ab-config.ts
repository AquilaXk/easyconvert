/**
 * The thresholds of the A/B speed comparison (bench/ab-speed.ts). They are the gate's own numbers, so a pull request is
 * judged by the ones of its base: the `parity speed` job takes this file, with the other gate files, from the base
 * commit (scripts/ci-parity-base-gate.mjs).
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
/** The most pairs a row may reach through extra pairs; the sign-test bound is exact for any count (binomial sums of a few terms in a double), and the budget of the shard ends the extension long before this for a slow row. */
export const AB_MAX_PAIRS = 240;

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
export const AB_ROW_REGRESSION: Readonly<Record<string, AbRegressionOverride>> =
  {
    "image/photo-a.jpg->jpg/throughput": {
      delta: 0.125,
      reason:
        "noise 0.040 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "ocr/scan.png->pdf/throughput": {
      delta: 0.15,
      reason:
        "noise 0.039 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "document/report.docx->pdf/throughput": {
      delta: 0.2,
      reason:
        "noise 0.057 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "document/rich-structure.docx->html/throughput": {
      delta: 1.25,
      reason:
        "noise 0.196 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard; no threshold up to 125 percent reaches 95 percent, so 1.25 only fails a slowdown of 2.25 times or more, and the row stays guarded by the nightly run.",
    },
    "document/rich-structure.docx->odt/throughput": {
      delta: 1.25,
      reason:
        "noise 0.136 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard; no threshold up to 125 percent reaches 95 percent, so 1.25 only fails a slowdown of 2.25 times or more, and the row stays guarded by the nightly run.",
    },
    "document/rich-structure.docx->epub/throughput": {
      delta: 1.25,
      reason:
        "noise 0.197 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard; no threshold up to 125 percent reaches 95 percent, so 1.25 only fails a slowdown of 2.25 times or more, and the row stays guarded by the nightly run.",
    },
    "document/rich-structure.docx->pdf/throughput": {
      delta: 0.25,
      reason:
        "noise 0.048 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "document/noori.hwp->txt/throughput": {
      delta: 1.0625,
      reason:
        "noise 0.181 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "document/pdf-text->txt/throughput": {
      delta: 0.125,
      reason:
        "noise 0.029 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "document/pdf-structure->docx/throughput": {
      delta: 1.25,
      reason:
        "noise 0.187 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "document/complex-script txt->pdf/throughput": {
      delta: 0.375,
      reason:
        "noise 0.056 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "compression/mixed.tar->zst/throughput": {
      delta: 0.15,
      reason:
        "noise 0.054 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "compression/mixed.tar->7z/throughput": {
      delta: 1.25,
      reason:
        "noise 0.315 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard; no threshold up to 125 percent reaches 95 percent, so 1.25 only fails a slowdown of 2.25 times or more, and the row stays guarded by the nightly run.",
    },
    "compression/mixed.zst->tar/throughput": {
      delta: 0.5625,
      reason:
        "noise 0.122 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "compression/mixed.xz->tar/throughput": {
      delta: 0.2,
      reason:
        "noise 0.074 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "compression/mixed.7z->tar/throughput": {
      delta: 0.35,
      reason:
        "noise 0.116 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "pdf-ops/merge.pdf->pdf/throughput": {
      delta: 0.225,
      reason:
        "noise 0.105 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "pdf-ops/watermark.pdf->pdf/throughput": {
      delta: 0.3,
      reason:
        "noise 0.079 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "pdf-ops/protect.pdf->pdf/throughput": {
      delta: 0.2,
      reason:
        "noise 0.061 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
    "pdf-ops/decrypt.pdf->pdf/throughput": {
      delta: 0.225,
      reason:
        "noise 0.079 (sd of the log pair ratio, median of 14 reports of the nightly dispatch run 38037770394, the commit as its own base); the smallest threshold at which the gate fails 1.5 times it in 95 percent of 300 simulated trials with the shared extra budget of its shard.",
    },
  };

/**
 * A row whose first pairs leave it undecided (the lower bound of its median under the row's slowdown line and the upper bound
 * over it: it could still turn out slower than the threshold, or not) gets more pairs, six at a time up to AB_MAX_PAIRS, while
 * the extra measuring time of its shard lasts. A row the first pairs decide (not slower than the threshold with confidence)
 * gets none: more pairs cannot make it fail. The confirmation set of a failure counts against the same time. The time is
 * a share of the job: the speed job runs one shard per family, each with this much.
 */
export const AB_EXTRA_STEP_PAIRS = 6;
export const AB_EXTRA_BUDGET_MS = 4 * 60 * 1000;

/**
 * A row whose first pairs show it credibly slower is measured once more with as many fresh pairs, and fails only when
 * those show it slower too (at this looser error rate: the first set already carries the strict one). Noise that comes in
 * bursts of seconds or minutes (a neighbour on the runner) can shift one set of pairs; it does not shift two sets taken
 * one after the other, and a slowdown of the code does.
 */
export const AB_CONFIRM_ALPHA = 0.01;
