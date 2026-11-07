import { instruments } from '../../src/lib/metrics/instruments';

export interface Sample {
  metricName: string;
  labels: Record<string, string>;
  value: number;
}

/** Every sample of the metrics registry, as the scrape would render it (histograms with their `_bucket`, `_sum` and `_count`). */
export async function allSamples(): Promise<Sample[]> {
  const metrics = await instruments().registry.getMetricsAsJSON();
  return metrics.flatMap((metric) =>
    (metric.values as Array<{ metricName?: string; labels: Record<string, string>; value: number }>).map((sample) => ({
      metricName: sample.metricName ?? metric.name,
      labels: Object.fromEntries(Object.entries(sample.labels ?? {}).map(([name, value]) => [name, String(value)])),
      value: sample.value,
    }))
  );
}

/** The value of the sample of `name` whose labels include `labels`; 0 when there is none. */
export async function reading(name: string, labels: Record<string, string> = {}): Promise<number> {
  const matching = (await allSamples()).filter(
    (sample) => sample.metricName === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value)
  );
  return matching.reduce((sum, sample) => sum + sample.value, 0);
}

export function resetMetrics(): void {
  instruments().registry.resetMetrics();
}
