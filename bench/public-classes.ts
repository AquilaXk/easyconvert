import type { BenchRow, Family } from './report';
import { measuredRow, type MetricSpec } from './rows';
import { CLASS_CASE_PREFIX } from './public-samples';

/**
 * Per-class rows of the public sample sets. Converter evaluations report a macro average over the documents of a class beside
 * the per-document numbers, and this benchmark does the same: every sample keeps its own rows, so a sample that is behind the
 * reference shows, and the class row is the unweighted mean over the samples of the class, so a class is judged as a whole as
 * well and a large file does not outweigh a small one. A size ratio is the exception: it is pooled (the sum of the output sizes
 * over the sum of the input sizes), the way compression results are published.
 *
 * A class row exists only when every sample of the class was measured for that target: a run that measured some of them (a
 * sample the host did not deliver, a quick subset) states nothing about the class.
 */

interface Pool {
  spec: MetricSpec;
  ours: number;
  reference: number;
  weight: number;
  samples: number;
}

export class PublicClassRows {
  private readonly planned = new Map<string, number>();
  private readonly pools = new Map<string, Pool>();

  /** A class row is named by the class, the part of the case name after it (`->pdf`) and the metric. */
  private key(className: string, suffix: string, metric: string): string {
    return `${className}\n${suffix}\n${metric}`;
  }

  /** One more sample is expected in the class rows of these metrics. */
  expect(className: string, suffix: string, metrics: readonly string[]): void {
    for (const metric of metrics) {
      const key = this.key(className, suffix, metric);
      this.planned.set(key, (this.planned.get(key) ?? 0) + 1);
    }
  }

  /** A measured sample: its value for the metric and the reference's, with the weight it has in the pool (1 for a mean). */
  add(className: string, suffix: string, spec: MetricSpec, ours: number, reference: number, weight = 1): void {
    const key = this.key(className, suffix, spec.metric);
    const pool = this.pools.get(key) ?? { spec, ours: 0, reference: 0, weight: 0, samples: 0 };
    pool.ours += ours * weight;
    pool.reference += reference * weight;
    pool.weight += weight;
    pool.samples += 1;
    this.pools.set(key, pool);
  }

  /** Adds every measured quality row of a sample's case to the class pools; `weightOf` gives a metric the weight it has in its pool (default 1). */
  addRows(className: string, suffix: string, rows: readonly BenchRow[], specs: readonly MetricSpec[], weightOf: (spec: MetricSpec) => number = () => 1): void {
    for (const spec of specs) {
      const row = rows.find((candidate) => candidate.metric === spec.metric && candidate.status === 'measured');
      if (row?.ours !== null && row?.ours !== undefined && row.reference !== null) this.add(className, suffix, spec, row.ours, row.reference, weightOf(spec));
    }
  }

  /** Expects the rows of a sample whose cases are named `<sampleId><suffix>` (`->pdf`, `->epub:headings`): one entry per row it will produce. */
  expectCases(className: string, plan: ReadonlyArray<{ suffix: string; metric: string }>): void {
    for (const entry of plan) this.expect(className, entry.suffix, [entry.metric]);
  }

  /** Adds the measured quality rows of a sample, each under the part of its case name after the sample's id. */
  addCases(className: string, sampleId: string, rows: readonly BenchRow[]): void {
    for (const row of rows) {
      if (row.status !== 'measured' || row.ours === null || row.reference === null || row.kind === 'throughput' || !row.case.startsWith(sampleId)) continue;
      const spec: MetricSpec = { metric: row.metric, unit: row.unit, direction: row.direction, kind: row.kind, tolerance: row.tolerance };
      this.add(className, row.case.slice(sampleId.length), spec, row.ours, row.reference);
    }
  }

  rows(family: Family, referenceTool: (suffix: string) => string): BenchRow[] {
    const rows: BenchRow[] = [];
    for (const [key, pool] of this.pools) {
      const [className, suffix] = key.split('\n');
      if (pool.samples === 0 || pool.samples !== this.planned.get(key)) continue;
      rows.push(measuredRow(family, `${CLASS_CASE_PREFIX}${className}${suffix}`, pool.spec, pool.ours / pool.weight, pool.reference / pool.weight, referenceTool(suffix)));
    }
    return rows;
  }
}
