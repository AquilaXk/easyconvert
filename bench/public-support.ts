import { BenchError } from './errors';
import type { BenchRow, Family } from './report';
import { type MetricSpec, measuredRow, skippedRow } from './rows';

/**
 * What the family runners share when they measure a public sample: the row that says whether the product converts the
 * sample at all, and the rule that a refusal of the product is a result, not a failure of the run.
 *
 * A public sample is an input the product was not written against. When the product answers it with a typed refusal (an
 * unsupported feature, a limit, a corrupt-stream error) or with any other exception, the sample's row `converts` is 0 beside
 * the reference's 1 or 0, which puts the sample below the reference without stopping the family. A failure of the harness
 * itself (BenchError: a reference tool that crashed, a missing oracle) still stops the run.
 */

/** 1 when the product converts the sample, 0 when it refuses or fails; the reference's value is 1 when its own tool converted it. */
export const CONVERTS_SPEC = { metric: 'converts', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: { abs: 0, rel: 0 } } as const satisfies MetricSpec;

export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

const REASON_LIMIT = 200;

/**
 * Runs our side of a conversion; a thrown error other than a harness failure is returned as the reason the product gave.
 * `tolerate` is false for the committed corpus, which the product is written against: there a failure stops the run.
 */
export async function attemptOurs<T>(run: () => Promise<T>, tolerate = true): Promise<Attempt<T>> {
  if (!tolerate) return { ok: true, value: await run() };
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof BenchError) throw error;
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `${name}: ${message.replaceAll(/\s+/g, ' ').slice(0, REASON_LIMIT)}` };
  }
}

/** The `converts` row of a case: ours against the reference (1 when its tool converted the sample). */
export function convertsRow(family: Family, caseName: string, oursConverted: boolean, referenceConverted: boolean, referenceTool: string): BenchRow {
  return measuredRow(family, caseName, CONVERTS_SPEC, oursConverted ? 1 : 0, referenceConverted ? 1 : 0, referenceTool);
}

/** The rows of a sample that is not available (the host did not deliver it): skipped, with the reason. */
export function unavailableRows(family: Family, caseName: string, specs: readonly MetricSpec[], referenceTool: string, reason: string): BenchRow[] {
  return specs.map((spec) => skippedRow(family, caseName, spec, referenceTool, 'unsupported', reason));
}
