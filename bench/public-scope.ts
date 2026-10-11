import { BenchArgumentError } from './errors';
import { isPublicCase } from './public-samples';

/**
 * Which cases of the public sample sets (bench/corpus/public-manifest.json) a run measures.
 *
 * - `--quick` (the pull request quality job) measures the cases PUBLIC_QUICK_CASES names: a few samples of each content class,
 *   on the targets the gate must not leave unmeasured. The per-class rows average every sample of a class and are nightly-only.
 * - A run without `--quick` (the nightly run, a local run) measures all of them, unless BENCH_CORPUS_TIER=pr says the run is
 *   the speed job of a pull request, which times the generated corpus only: its paired sequential sampling over every public
 *   sample would multiply the wall-clock time of a pull request.
 */
export const CORPUS_TIER_ENV = 'BENCH_CORPUS_TIER';
export type CorpusTier = 'pr' | 'full';

export function corpusTier(env: Readonly<Record<string, string | undefined>> = process.env): CorpusTier {
  const value = env[CORPUS_TIER_ENV];
  if (value === undefined || value === '' || value === 'full') return 'full';
  if (value === 'pr') return 'pr';
  throw new BenchArgumentError(`${CORPUS_TIER_ENV} must be "pr" or "full", not "${value}"`);
}

/** The public cases `--quick` measures, per family. A family absent here measures none of them quickly. */
export const PUBLIC_QUICK_CASES: Readonly<Record<string, readonly string[]>> = {
  document: ['doc-poi-61787.docx->pdf', 'doc-poi-japanese.pptx->pdf', 'doc-poi-53446.doc->pdf', 'doc-gov-001858.rtf->pdf'],
  'pdf-ops': ['pdf-pdfjs-form-test.pdf->extract', 'pdf-gov-000341.pdf->unlock', 'pdf-pdfjs-cjk-1.pdf->rotate'],
  ebook: ['book-wasteland.epub->txt', 'book-wasteland.fb2->txt'],
  font: ['font-lato-regular.ttf->woff2', 'font-sourcecodepro-regular.otf->woff', 'font-amiri-regular.ttf->otf'],
  cad: ['cad-openscad-export.dxf->svg', 'cad-circles-ellipses-arcs.dxf->pdf', 'cad-blocks.dxf->png'],
  raw: ['raw-canon-g1.crw->jpg'],
  vector: ['vec-path-M-C-S.svg->png', 'vec-radialGradient-fr-0.5.svg->png', 'vec-clipPath-clip-path-on-children.svg->pdf'],
  data: ['data-penguins.json->csv', 'data-delta-byte-array.csv->parquet', 'data-weather.csv->json'],
};

/**
 * Public samples whose throughput rows the nightly run measures, per family. Quality is measured on every sample; speed
 * depends on the code path and the size of the input more than on the document, so a few samples of each class stand for the
 * rest, which keeps the timing job inside its budget. A pull request measures none of them (BENCH_CORPUS_TIER=pr).
 */
export const PUBLIC_SPEED_SAMPLES: Readonly<Record<string, readonly string[]>> = {
  document: ['doc-poi-61787.docx', 'doc-poi-45544.xlsx', 'doc-poi-japanese.pptx', 'doc-poi-53446.doc'],
  'pdf-ops': ['pdf-pdfjs-form-test.pdf', 'pdf-gov-000142.pdf'],
  ebook: ['book-wasteland.epub'],
  font: ['font-lato-regular.ttf', 'font-sourcecodepro-regular.otf'],
  cad: ['cad-openscad-export.dxf', 'cad-circles-ellipses-arcs.dxf'],
  raw: ['raw-canon-eos5d3-compress.dng'],
  vector: ['vec-path-M-C-S.svg'],
  data: ['data-penguins.json', 'data-delta-byte-array.csv'],
};

/** The decision for a public case, or null when the case is none of them. */
export function publicCaseScope(quick: boolean, family: string, caseName: string): boolean | null {
  if (!isPublicCase(caseName)) return null;
  if (quick) return (PUBLIC_QUICK_CASES[family] ?? []).includes(caseName);
  return corpusTier() === 'full';
}

/** Whether the throughput rows of this sample are measured when the run measures speed. */
export function publicSpeedSample(family: string, sampleId: string): boolean {
  return (PUBLIC_SPEED_SAMPLES[family] ?? []).includes(sampleId);
}
