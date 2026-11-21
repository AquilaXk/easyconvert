import { describe, expect, it } from 'vitest';
import { ClassRows } from '../bench/class-rows';
import { HIGH_CASE_SUFFIX, HIGH_QUALITY_POINTS, highQualityRows, type HighQualityPoint } from '../bench/families/image-jpeg-high';
import { evaluateParity } from '../bench/parity';
import type { BenchReport } from '../bench/report';

/**
 * The JPEG rows of the high quality range: a picture asking for 88 to 96 is judged on its own five-point curve, with a headline
 * point at 92, and the photographs pool into a class row.
 */

/** A curve of ours that is `bytesShare` of the reference's size at the same quality (a log-linear rate-distortion line). */
function curve(bytesShare: number, scored: boolean): Map<number, HighQualityPoint> {
  return new Map(
    HIGH_QUALITY_POINTS.map((quality, index) => [
      quality,
      { bytes: Math.round(100_000 * 1.35 ** index * bytesShare), ssim: 0.97 + index * 0.005, psnr: 40 + index * 1.5, ssimulacra2: scored ? 80 + index * 2 : null },
    ])
  );
}

const rowsOf = (bytesShare: number, scored = true, classRows: ClassRows | null = null) =>
  highQualityRows({ caseName: `kodim23.png${HIGH_CASE_SUFFIX}`, referenceTool: 'ImageMagick', ours: curve(bytesShare, scored), reference: curve(1, scored), classRows, contentClass: classRows === null ? null : 'photo' });

describe('JPEG rows over 88 to 96', () => {
  it('measures five points from 88 to 96 and names the case after the range', () => {
    expect(HIGH_QUALITY_POINTS).toEqual([88, 90, 92, 94, 96]);
    expect(HIGH_CASE_SUFFIX).toBe('->jpg@q88-96');
  });

  it('writes the headline point at 92 and a BD-rate of PSNR, SSIM and SSIMULACRA 2', () => {
    const rows = rowsOf(0.96);
    const byMetric = Object.fromEntries(rows.map((row) => [row.metric, row]));
    expect(Object.keys(byMetric).sort()).toEqual(['bd_rate_psnr', 'bd_rate_ssim', 'bd_rate_ssimulacra2', 'bytes', 'psnr', 'ssim', 'ssimulacra2']);
    expect(byMetric.bytes.ours).toBe(Math.round(100_000 * 1.35 ** 2 * 0.96));
    expect(byMetric.bytes.reference).toBe(Math.round(100_000 * 1.35 ** 2));
    for (const metric of ['bd_rate_psnr', 'bd_rate_ssim', 'bd_rate_ssimulacra2']) {
      expect(byMetric[metric].ours).toBeCloseTo(-4, 2);
      expect(byMetric[metric].reference).toBe(0);
      expect(byMetric[metric].kind).toBe('bdrate');
    }
  });

  it('leaves out SSIMULACRA 2 when the tool is not installed', () => {
    const metrics = rowsOf(1, false).map((row) => row.metric);
    expect(metrics).not.toContain('ssimulacra2');
    expect(metrics).not.toContain('bd_rate_ssimulacra2');
    expect(metrics).toContain('bd_rate_psnr');
  });

  it('pools the BD-rates of PSNR and SSIM into a class row', () => {
    const classRows = new ClassRows();
    classRows.expect('photo', HIGH_CASE_SUFFIX, ['bd_rate_psnr', 'bd_rate_ssim']);
    rowsOf(0.96, true, classRows);
    const pooled = classRows.rows('image', () => 'ImageMagick');
    expect(pooled.map((row) => `${row.case}/${row.metric}`).sort()).toEqual([`class-photo${HIGH_CASE_SUFFIX}/bd_rate_psnr`, `class-photo${HIGH_CASE_SUFFIX}/bd_rate_ssim`]);
  });

  it('is judged by the BD-rate at unequal size: ahead passes, more than 1.5 percent behind fails', () => {
    const verdict = (share: number) => {
      const report: BenchReport = {
        schemaVersion: 1,
        generatedAt: '2026-11-21T00:00:00.000Z',
        strictMode: true,
        families: ['image'],
        host: { platform: 'linux', arch: 'x64', node: 'v24.0.0', cpus: 4 },
        tools: {},
        settings: { runs: 5, injectedRegression: null },
        rows: rowsOf(share),
      };
      return evaluateParity(report, { schemaVersion: 1, gaps: [] }).verdict;
    };
    expect(verdict(0.96)).toBe('pass');
    expect(verdict(1.05)).toBe('fail');
  });
});
