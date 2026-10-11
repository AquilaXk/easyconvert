import { describe, expect, it } from 'vitest';
import { addNewRowsFromReport } from '../bench/baseline-from-report';
import { type Baseline } from '../bench/gate';
import { type BenchReport } from '../bench/report';
import { measuredRow, SPEC, skippedRow } from '../bench/rows';

const report = (over: Partial<BenchReport> = {}, rows: BenchReport['rows'] = []): BenchReport => ({
  schemaVersion: 1,
  generatedAt: '2026-10-11T02:00:00.000Z',
  strictMode: true,
  families: ['image'],
  host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
  tools: {},
  settings: { runs: 5, injectedRegression: null },
  source: { commit: 'a'.repeat(40), branch: 'main', event: 'schedule' },
  rows,
  ...over,
});

const baseline: Baseline = {
  schemaVersion: 1,
  entries: { 'image/old.png->webp/ssim': { direction: 'higher', tolerance: { abs: 0.003, rel: 0 }, ours: 0.9, delta: 0, ratio: null } },
};

describe('baseline entries from a CI report', () => {
  it('adds the measured rows the baseline lacks, with the runner numbers, and never rewrites an entry that exists', () => {
    const rows = [
      measuredRow('image', 'old.png->webp', SPEC.ssim, 0.5, 0.5, 'cwebp'),
      measuredRow('image', 'new.png->webp', SPEC.ssim, 0.97, 0.96, 'cwebp'),
      skippedRow('image', 'new.png->avif', SPEC.ssim, 'avifenc', 'optional-tool', 'tool not installed'),
    ];
    const result = addNewRowsFromReport(report({}, rows), baseline);
    expect(result.added).toEqual(['image/new.png->webp/ssim']);
    expect(result.baseline.entries['image/old.png->webp/ssim']).toEqual(baseline.entries['image/old.png->webp/ssim']);
    expect(result.baseline.entries['image/new.png->webp/ssim']).toMatchObject({ direction: 'higher', ours: 0.97, ratio: null });
    expect(result.baseline.entries['image/new.png->webp/ssim'].delta).toBeCloseTo(0.01, 10);
    expect(Object.keys(result.baseline.entries)).toEqual(['image/new.png->webp/ssim', 'image/old.png->webp/ssim']);
  });

  it('refuses a report that is not the runner, strict, clean and traceable to a workflow run', () => {
    expect(() => addNewRowsFromReport(report({ host: { platform: 'darwin', arch: 'arm64', node: 'v24', cpus: 8 } }), baseline)).toThrow(/linux/);
    expect(() => addNewRowsFromReport(report({ strictMode: false }), baseline)).toThrow(/ORACLE_STRICT_MODE=1/);
    expect(() => addNewRowsFromReport(report({ settings: { runs: 5, injectedRegression: 'webp-quality' } }), baseline)).toThrow(/injected regression/);
    expect(() => addNewRowsFromReport(report({ source: undefined }), baseline)).toThrow(/no workflow run/);
  });
});
