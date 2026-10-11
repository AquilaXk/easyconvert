import { PSNR_CAP_DB, SSIM_DISTANCE_FLOOR } from './config';
import type { BenchRow, Family, SkipKind, Tolerance } from './report';
import { type MetricSpec, THROUGHPUT_SPEC } from './speed-rows';
import type { ToolPlanSkipped } from './tools';

export { measuredRow, type MetricSpec, speedRowId, THROUGHPUT_SPEC, throughputRow } from './speed-rows';

/** Row construction shared by every family: metric specs with their gate tolerances, and the row builders. */

const tol = (abs: number, rel: number): Tolerance => ({ abs, rel });

/** Gate tolerances per metric. Pixel and sample metrics are deterministic for fixed tool versions, so they are tight. */
export const SPEC = {
  ssim: { metric: 'ssim', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.003, 0) },
  psnr: { metric: 'psnr', unit: 'dB', direction: 'higher', kind: 'quality', tolerance: tol(0.3, 0) },
  vmaf: { metric: 'vmaf', unit: 'score', direction: 'higher', kind: 'quality', tolerance: tol(1, 0) },
  ssimulacra2: { metric: 'ssimulacra2', unit: 'score', direction: 'higher', kind: 'quality', tolerance: tol(1, 0) },
  bytes: { metric: 'bytes', unit: 'bytes', direction: 'lower', kind: 'size', tolerance: tol(0, 0.03) },
  bitrate: { metric: 'bitrate', unit: 'kbit/s', direction: 'lower', kind: 'size', tolerance: tol(0, 0.03) },
  bdRatePsnr: { metric: 'bd_rate_psnr', unit: '%', direction: 'lower', kind: 'bdrate', tolerance: tol(1.5, 0) },
  bdRateSsim: { metric: 'bd_rate_ssim', unit: '%', direction: 'lower', kind: 'bdrate', tolerance: tol(1.5, 0) },
  bdRateSnr: { metric: 'bd_rate_snr', unit: '%', direction: 'lower', kind: 'bdrate', tolerance: tol(1.5, 0) },
  snr: { metric: 'snr', unit: 'dB', direction: 'higher', kind: 'quality', tolerance: tol(0.5, 0) },
  loudnessShift: { metric: 'loudness_shift', unit: 'LU', direction: 'lower', kind: 'quality', tolerance: tol(0.3, 0) },
  truePeakShift: { metric: 'true_peak_shift', unit: 'dB', direction: 'lower', kind: 'quality', tolerance: tol(0.3, 0) },
  losslessExact: { metric: 'lossless_exact', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: tol(0, 0) },
  cer: { metric: 'cer', unit: '%', direction: 'lower', kind: 'quality', tolerance: tol(0.75, 0) },
  wordF1: { metric: 'word_f1', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  wordRecall: { metric: 'word_recall', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  structurePrecision: { metric: 'structure_precision', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  structureRecall: { metric: 'structure_recall', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  epubcheckErrors: { metric: 'epubcheck_errors', unit: 'count', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  headingF1: { metric: 'heading_f1', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.03, 0) },
  listF1: { metric: 'list_f1', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.03, 0) },
  tableTeds: { metric: 'table_teds', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.03, 0) },
  columnAccuracy: { metric: 'column_accuracy', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.05, 0) },
  paragraphCountError: { metric: 'paragraph_count_error', unit: 'ratio', direction: 'lower', kind: 'quality', tolerance: tol(0.03, 0) },
  readingOrderTau: { metric: 'reading_order_tau', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  pdfCheckFailures: { metric: 'pdf_check_failures', unit: 'count', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  pageCountError: { metric: 'page_count_error', unit: 'pages', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  rotationErrors: { metric: 'rotation_errors', unit: 'pages', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  renderMatchesReference: { metric: 'render_matches_reference', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: tol(0, 0) },
  stampInkMatchesReference: { metric: 'stamp_ink_matches_reference', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: tol(0, 0) },
  stampGeometryMatchesSpec: { metric: 'stamp_geometry_matches_spec', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: tol(0, 0) },
  encryptionMatchesReference: { metric: 'encryption_matches_reference', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: tol(0, 0) },
  pdfEmbeddedImages: { metric: 'pdf_embedded_images', unit: 'count', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  unembeddedFonts: { metric: 'unembedded_fonts', unit: 'count', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  metafileViolations: { metric: 'metafile_violations', unit: 'count', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  inkPrecision: { metric: 'ink_precision', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  inkRecall: { metric: 'ink_recall', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  extentError: { metric: 'extent_error', unit: 'ratio', direction: 'lower', kind: 'quality', tolerance: tol(0.01, 0) },
  ratio: { metric: 'compression_ratio', unit: 'ratio', direction: 'lower', kind: 'size', tolerance: tol(0, 0.01) },
  cellMismatches: { metric: 'cell_mismatches', unit: 'cells', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  tableMismatches: { metric: 'font_table_mismatches', unit: 'tables', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  fontValidationFailures: { metric: 'font_validation_failures', unit: 'count', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  outlineMismatches: { metric: 'glyph_outline_mismatches', unit: 'glyphs', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  throughput: THROUGHPUT_SPEC,
} as const satisfies Record<string, MetricSpec>;

export function skippedRow(
  family: Family,
  caseName: string,
  spec: MetricSpec,
  referenceTool: string,
  skipKind: SkipKind,
  skipReason: string
): BenchRow {
  return {
    id: `${family}/${caseName}/${spec.metric}`,
    family,
    case: caseName,
    metric: spec.metric,
    unit: spec.unit,
    direction: spec.direction,
    kind: spec.kind,
    status: 'skipped',
    ours: null,
    reference: null,
    delta: null,
    ratio: null,
    referenceTool,
    tolerance: spec.tolerance,
    skipKind,
    skipReason,
  };
}

/** One skipped row per metric of a group whose tools are missing. */
export function skippedGroup(
  family: Family,
  caseName: string,
  specs: readonly MetricSpec[],
  referenceTool: string,
  plan: ToolPlanSkipped
): BenchRow[] {
  const kind: SkipKind = plan.optional ? 'optional-tool' : 'missing-tool';
  return specs.map((spec) => skippedRow(family, caseName, spec, referenceTool, kind, plan.reason));
}

/** PSNR with the infinite value of a lossless result recorded at a finite cap, so the report stays valid JSON. */
export function capPsnr(psnr: number): number {
  return Math.min(psnr, PSNR_CAP_DB);
}

/** SSIM in decibels, -10 log10(1 - SSIM): the scale on which SSIM differences are comparable across the range. */
export function ssimDb(ssim: number): number {
  return -10 * Math.log10(Math.max(1 - ssim, SSIM_DISTANCE_FLOOR));
}
