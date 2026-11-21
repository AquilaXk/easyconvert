import { type RdPoint, tryBdRate } from '../bd-rate';
import { ClassRows } from '../class-rows';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, SPEC, ssimDb, undeterminedBdRows } from '../rows';

/**
 * The JPEG rows of the high quality range. The four points of the family's own curve (40 to 85) are 4:2:0 and table 3 or 2; from 90 the
 * encoder writes 4:4:4 with the standard table (entry 250), so a picture asking for 88 to 96 is judged on a curve of its own: the five
 * points below, BD-rate of PSNR, SSIM in decibels and SSIMULACRA 2, and the point at the headline quality of the range with the bytes,
 * the PSNR, the SSIM and the SSIMULACRA 2 score. The reference (ImageMagick `-quality`) writes the same layout from 90, so the curves
 * cross its own switch between 88 and 90 on both sides.
 */
export const HIGH_QUALITY_POINTS = [88, 90, 92, 94, 96] as const;
export const HIGH_HEADLINE_QUALITY = 92;
/** Part of the case name after the sample's file name: `kodim23.png->jpg@q88-96`. */
export const HIGH_CASE_SUFFIX = '->jpg@q88-96';

/** What one encode of the range is measured as. `ssimulacra2` is null when the tool is not installed. */
export interface HighQualityPoint {
  bytes: number;
  ssim: number;
  psnr: number;
  ssimulacra2: number | null;
}

type Curve = ReadonlyMap<number, HighQualityPoint>;

const curveOf = (points: Curve, quality: (point: HighQualityPoint) => number): RdPoint[] =>
  HIGH_QUALITY_POINTS.map((q) => {
    const point = points.get(q) as HighQualityPoint;
    return { rate: point.bytes, quality: quality(point) };
  });

/** Which rows of the pooled class are expected: a class row exists only when every sample of the class gave its value. */
export const HIGH_CLASS_METRICS: readonly string[] = [SPEC.bdRatePsnr.metric, SPEC.bdRateSsim.metric];

export interface HighQualityInput {
  caseName: string;
  referenceTool: string;
  ours: Curve;
  reference: Curve;
  /** The class the sample is pooled into, with its rows. */
  classRows: ClassRows | null;
  contentClass: string | null;
}

/** The rows of one photograph at 88 to 96: the point at the headline quality and the BD-rates of the five-point curve. */
export function highQualityRows(input: HighQualityInput): BenchRow[] {
  const { caseName, referenceTool, ours, reference } = input;
  const rows: BenchRow[] = [];
  const o = ours.get(HIGH_HEADLINE_QUALITY) as HighQualityPoint;
  const r = reference.get(HIGH_HEADLINE_QUALITY) as HighQualityPoint;
  rows.push(measuredRow('image', caseName, SPEC.ssim, o.ssim, r.ssim, referenceTool));
  rows.push(measuredRow('image', caseName, SPEC.psnr, o.psnr, r.psnr, referenceTool));
  rows.push(measuredRow('image', caseName, SPEC.bytes, o.bytes, r.bytes, referenceTool));
  const scored = o.ssimulacra2 !== null && r.ssimulacra2 !== null;
  if (scored) rows.push(measuredRow('image', caseName, SPEC.ssimulacra2, o.ssimulacra2 as number, r.ssimulacra2 as number, referenceTool));

  const metrics: Array<[MetricSpec, (point: HighQualityPoint) => number, boolean]> = [
    [SPEC.bdRatePsnr, (point) => point.psnr, true],
    [SPEC.bdRateSsim, (point) => ssimDb(point.ssim), true],
    [SPEC.bdRateSsimulacra2, (point) => point.ssimulacra2 as number, scored],
  ];
  for (const [spec, quality, available] of metrics) {
    if (!available) continue;
    const bd = tryBdRate(curveOf(reference, quality), curveOf(ours, quality));
    const pooled = input.contentClass !== null && input.classRows !== null && HIGH_CLASS_METRICS.includes(spec.metric);
    if ('value' in bd) {
      rows.push(measuredRow('image', caseName, spec, bd.value, 0, referenceTool));
      if (pooled) (input.classRows as ClassRows).add(input.contentClass as string, HIGH_CASE_SUFFIX, spec, bd.value, 0);
    } else {
      rows.push(...undeterminedBdRows('image', caseName, [spec], referenceTool, bd));
      if (pooled) (input.classRows as ClassRows).exclude(input.contentClass as string, HIGH_CASE_SUFFIX, spec.metric);
    }
  }
  return rows;
}
