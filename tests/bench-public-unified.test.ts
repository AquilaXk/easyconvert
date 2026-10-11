import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClassRows } from '../bench/class-rows';
import { CORPUS_TIER_ENV } from '../bench/config';
import { readRemoteManifest, remoteSamples, type RemoteFamily } from '../bench/corpora';
import { bdRateRows } from '../bench/families/raw';
import { validateGaps } from '../bench/parity-gaps';
import { measuredRow, SPEC, unavailableSampleRows } from '../bench/rows';
import { rowInScope } from '../bench/scope';

/**
 * The eight families of phase 2 of #733 (document, PDF, ebook, font, CAD, RAW, vector, data) use the sample system of phase 1: one
 * manifest, one fetcher with its redirect and size guards, one class-row pool, one quick list and one scope switch. These checks
 * hold that in place, so that a fix to the gate of one phase reaches the other.
 */

const ROOT = path.join(__dirname, '..');
const PHASE_TWO = ['document', 'pdf-ops', 'ebook', 'font', 'cad', 'raw', 'vector', 'data'] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('one sample system', () => {
  it('holds the samples of every family in the one manifest, at least ten per family', () => {
    const manifest = readRemoteManifest();
    for (const family of PHASE_TWO) expect(remoteSamples(family as RemoteFamily, manifest).length, family).toBeGreaterThanOrEqual(10);
  });

  it('has no second manifest, fetcher, class-row pool or scope switch', () => {
    for (const file of ['bench/corpus/public-manifest.json', 'bench/public-samples.ts', 'bench/public-classes.ts', 'bench/public-scope.ts']) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(false);
    }
  });
});

describe('the known gaps', () => {
  it('name only speed rows that the speed job of a pull request measures, since a gap entry for a row the run skips is not backed', () => {
    vi.stubEnv(CORPUS_TIER_ENV, 'pr');
    const gaps = validateGaps(JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'parity-gaps.json'), 'utf8')));
    const unmeasured = gaps.gaps.map((gap) => gap.id).filter((id) => id.endsWith('/throughput') && !rowInScope(false, id));
    expect(unmeasured).toEqual([]);
  });
});

describe('the class rows of the further families', () => {
  it('pool a size ratio by the weight of its sample, through the one pool of phase 1 (whose add takes the weighted values)', () => {
    const classes = new ClassRows();
    classes.expectCases('cjk', [{ suffix: '->woff2', metric: SPEC.ratio.metric }]);
    classes.expectCases('cjk', [{ suffix: '->woff2', metric: SPEC.ratio.metric }]);
    classes.addCases('cjk', 'a.ttf', [{ ...measuredRow('font', 'a.ttf->woff2', SPEC.ratio, 0.5, 0.4, 'woff2'), case: 'a.ttf->woff2' }], () => 100);
    classes.addCases('cjk', 'b.ttf', [{ ...measuredRow('font', 'b.ttf->woff2', SPEC.ratio, 0.25, 0.2, 'woff2'), case: 'b.ttf->woff2' }], () => 300);
    const [row] = classes.rows('font', () => 'woff2');
    expect(row.case).toBe('class-cjk->woff2');
    expect(row.ours).toBeCloseTo((0.5 * 100 + 0.25 * 300) / 400, 10);
    expect(row.reference).toBeCloseTo((0.4 * 100 + 0.2 * 300) / 400, 10);
  });
});

describe('a sample that is not available', () => {
  it('is skipped as an optional tool does, so that a baselined row of a run without network is not read as lost', () => {
    const rows = unavailableSampleRows('font', 'x.ttf->woff2', [SPEC.ratio, SPEC.tableMismatches], 'woff2', 'x.ttf');
    expect(rows.map((row) => [row.status, row.skipKind])).toEqual([
      ['skipped', 'optional-tool'],
      ['skipped', 'optional-tool'],
    ]);
    expect(rows[0].skipReason).toContain('x.ttf');
  });
});

describe('the BD-rate of the RAW samples', () => {
  const point = (rate: number, quality: number): { rate: number; quality: number } => ({ rate, quality });
  const gaining = [point(100, 30), point(150, 33), point(220, 36), point(330, 39)];
  const falling = [point(100, 39), point(150, 36), point(220, 33), point(330, 30)];

  it('is a measured row against zero when both curves gain quality with their rate', () => {
    const classes = new ClassRows();
    classes.expect('canon', '->jpg', [SPEC.bdRatePsnr.metric]);
    const rows = bdRateRows('raw', 'x.cr2->jpg', 'dcraw_emu', [[SPEC.bdRatePsnr, gaining, gaining]], classes, 'canon');
    expect(rows.map((row) => `${row.metric}:${row.status}`)).toEqual(['bd_rate_psnr:measured']);
  });

  it('fails the row when the curve of ours falls, instead of recording the number of the cubic fit', () => {
    const classes = new ClassRows();
    classes.expect('canon', '->jpg', [SPEC.bdRatePsnr.metric]);
    const rows = bdRateRows('raw', 'x.cr2->jpg', 'dcraw_emu', [[SPEC.bdRatePsnr, gaining, falling]], classes, 'canon');
    expect(rows.map((row) => `${row.metric}:${row.status}:${row.ours}`).sort()).toEqual(['bd_rate_psnr:skipped:null', 'rd_curve_psnr:measured:0']);
    expect(classes.rows('raw', () => 'dcraw_emu')).toEqual([]);
  });

  it('does not evaluate the row when the reference curve is the broken one', () => {
    const classes = new ClassRows();
    classes.expect('canon', '->jpg', [SPEC.bdRatePsnr.metric]);
    const rows = bdRateRows('raw', 'x.cr2->jpg', 'dcraw_emu', [[SPEC.bdRatePsnr, falling, gaining]], classes, 'canon');
    expect(rows.map((row) => `${row.metric}:${row.status}`)).toEqual(['bd_rate_psnr:skipped']);
  });
});
