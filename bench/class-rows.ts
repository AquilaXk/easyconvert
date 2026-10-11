import type { BenchRow, Family } from './report';
import { measuredRow, type MetricSpec } from './rows';

/**
 * Per-class rows of the public sample sets. Codec comparisons report the average over the samples of a content class beside
 * the per-sample numbers, and this benchmark does the same: every sample keeps its own rows, so a sample that is behind the
 * reference shows, and the class row is the pooled result over the class, so a class is judged as a whole as well.
 *
 * - A BD-rate is averaged over the samples of the class without weights (the way the common test conditions of video codecs
 *   report it): each sample adds its own BD-rate with weight 1 and the class row is their mean.
 * - A size ratio is pooled: the sum of the compressed sizes over the sum of the original sizes, so a large file counts for
 *   its size, as in the published results of compression corpora.
 *
 * A class row exists only when every sample of the class was measured for that target; a run that measured some of them (a
 * sample the host did not deliver, a quick subset) states nothing about the class.
 */

interface Pool {
  spec: MetricSpec;
  ours: number;
  reference: number;
  weight: number;
  samples: number;
}

export class ClassRows {
  private readonly planned = new Map<string, number>();
  private readonly pools = new Map<string, Pool>();

  /** A class row is named by the class, the part of the case name after it (`->webp`, `.tar->zst`) and the metric. */
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

  /** A sample that states no value for a class row (its curve is undetermined): it leaves that mean, and its own rows say why. */
  exclude(className: string, suffix: string, metric: string): void {
    const key = this.key(className, suffix, metric);
    this.planned.set(key, (this.planned.get(key) ?? 1) - 1);
  }

  /** A measured sample: its value for the metric and the reference's, each with the weight it has in the pool. */
  add(className: string, suffix: string, spec: MetricSpec, ours: number, reference: number, weight = 1): void {
    const key = this.key(className, suffix, spec.metric);
    const pool = this.pools.get(key) ?? { spec, ours: 0, reference: 0, weight: 0, samples: 0 };
    pool.ours += ours;
    pool.reference += reference;
    pool.weight += weight;
    pool.samples += 1;
    this.pools.set(key, pool);
  }

  rows(family: Family, referenceTool: (suffix: string) => string): BenchRow[] {
    const rows: BenchRow[] = [];
    for (const [key, pool] of this.pools) {
      const [className, suffix] = key.split('\n');
      if (pool.samples === 0 || pool.samples !== this.planned.get(key)) continue;
      rows.push(measuredRow(family, `class-${className}${suffix}`, pool.spec, pool.ours / pool.weight, pool.reference / pool.weight, referenceTool(suffix)));
    }
    return rows;
  }
}
