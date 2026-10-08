import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../bench/config';
import { ReportSchemaError } from '../bench/errors';
import { type BenchReport, renderMarkdown, validateReport } from '../bench/report';

/** A hand-written report in the on-disk shape, one measured row and one skipped row. */
function validReport(): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    strictMode: true,
    families: ['image', 'video'],
    host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
    tools: { ffmpeg: 'ffmpeg version 6.1', ssimulacra2: null },
    settings: { runs: 5, injectedRegression: null },
    rows: [
      {
        id: 'image/photo-a.jpg->webp/bytes',
        family: 'image',
        case: 'photo-a.jpg->webp',
        metric: 'bytes',
        unit: 'bytes',
        direction: 'lower',
        kind: 'size',
        status: 'measured',
        ours: 21000,
        reference: 20000,
        delta: 1000,
        ratio: null,
        referenceTool: 'cwebp',
        tolerance: { abs: 0, rel: 0.03 },
      },
      {
        id: 'video/clip.mp4->h264/vmaf',
        family: 'video',
        case: 'clip.mp4->h264',
        metric: 'vmaf',
        unit: 'score',
        direction: 'higher',
        kind: 'quality',
        status: 'skipped',
        ours: null,
        reference: null,
        delta: null,
        ratio: null,
        referenceTool: 'ffmpeg libx264',
        tolerance: { abs: 1, rel: 0 },
        skipKind: 'optional-tool',
        skipReason: 'optional tool not installed: libvmaf',
      },
    ],
  };
}

function mutate(change: (report: Record<string, unknown>) => void): unknown {
  const report = validReport();
  change(report);
  return report;
}

function firstRow(report: Record<string, unknown>): Record<string, unknown> {
  return (report.rows as Record<string, unknown>[])[0];
}

describe('report schema', () => {
  it('accepts a well-formed report and returns every field', () => {
    const parsed = validateReport(validReport());
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ id: 'image/photo-a.jpg->webp/bytes', ours: 21000, reference: 20000, delta: 1000 });
    expect(parsed.rows[1]).toMatchObject({ status: 'skipped', skipKind: 'optional-tool', skipReason: 'optional tool not installed: libvmaf' });
    expect(parsed.tools.ssimulacra2).toBeNull();
  });

  it.each([
    ['a wrong schema version', (r: Record<string, unknown>) => { r.schemaVersion = 2; }, /schemaVersion/],
    ['an unknown family', (r: Record<string, unknown>) => { firstRow(r).family = 'sound'; }, /rows\[0\]\.family/],
    ['an id that is not family/case/metric', (r: Record<string, unknown>) => { firstRow(r).id = 'image/other/bytes'; }, /rows\[0\]\.id/],
    ['a direction other than higher or lower', (r: Record<string, unknown>) => { firstRow(r).direction = 'up'; }, /rows\[0\]\.direction/],
    ['a measured row without a reference value', (r: Record<string, unknown>) => { firstRow(r).reference = null; firstRow(r).delta = null; }, /measured row/],
    ['a delta that is not ours minus reference', (r: Record<string, unknown>) => { firstRow(r).delta = 5; }, /ours - reference/],
    ['a non-finite value', (r: Record<string, unknown>) => { firstRow(r).ours = Number.POSITIVE_INFINITY; }, /finite number/],
    ['a negative tolerance', (r: Record<string, unknown>) => { firstRow(r).tolerance = { abs: -1, rel: 0 }; }, /non-negative/],
    ['a skipped row that still carries values', (r: Record<string, unknown>) => { (r.rows as Record<string, unknown>[])[1].ours = 3; }, /skipped row without values/],
    ['a skipped row without a reason', (r: Record<string, unknown>) => { delete (r.rows as Record<string, unknown>[])[1].skipReason; }, /skipReason/],
    ['a duplicate row id', (r: Record<string, unknown>) => { (r.rows as unknown[]).push({ ...firstRow(r) }); }, /unique/],
    ['a throughput row without a speed ratio', (r: Record<string, unknown>) => { Object.assign(firstRow(r), { id: 'image/photo-a.jpg->webp/throughput', metric: 'throughput', kind: 'throughput' }); }, /speed ratio/],
    ['rows that are not an array', (r: Record<string, unknown>) => { r.rows = {}; }, /rows must be an array/],
  ])('rejects %s with a typed error naming the field', (_name, change, message) => {
    const attempt = (): unknown => validateReport(mutate(change));
    expect(attempt).toThrow(ReportSchemaError);
    expect(attempt).toThrow(message);
  });

  it('rejects a report that is not an object', () => {
    expect(() => validateReport(null)).toThrow(ReportSchemaError);
    expect(() => validateReport([])).toThrow(ReportSchemaError);
  });
});

describe('markdown summary', () => {
  it('renders our value, the reference value and the delta per row, then lists the skipped rows', () => {
    const header = '| Case | Metric | Unit | Better | Ours | Reference | Delta | Ratio | Reference tool | CV ours/ref |';
    const rule = '|---|---|---|---|---|---|---|---|---|---|';
    const golden = [
      '# Quality benchmark',
      '',
      'Generated 2026-01-01T00:00:00.000Z on linux/x64, node v20.0.0, 4 CPUs, 5 timing runs per throughput row.',
      '',
      'Reference tools: ffmpeg: ffmpeg version 6.1; ssimulacra2: not installed',
      '',
      '## image',
      '',
      header,
      rule,
      '| photo-a.jpg->webp | bytes | bytes | lower | 21000 | 20000 | 1000 | - | cwebp | - |',
      '',
      '## video',
      '',
      header,
      rule,
      '',
      '## Skipped rows (1)',
      '',
      '| Row | Kind | Reason |',
      '|---|---|---|',
      '| video/clip.mp4->h264/vmaf | optional-tool | optional tool not installed: libvmaf |',
      '',
    ].join('\n');
    expect(renderMarkdown(validateReport(validReport()) as BenchReport)).toBe(golden);
  });
});
