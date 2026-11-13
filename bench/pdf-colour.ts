import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './config';
import { runTool } from './tools';

/**
 * Colour and vector-shape agreement of a document converted from a PDF (bench/pdf-colour-metrics.py reads both PDFs). The
 * converted file is printed to PDF by the office suite and read back with the PDF oracle of the other families, so the metrics
 * judge what a viewer draws and not the markup. The reference is the office suite's own import of the same PDF, saved in the
 * same format and printed the same way.
 */

export type ColourTarget = 'pptx' | 'ppt' | 'docx';

/** A slide holds one page, so a shape must be where the page has it; a Word document reflows its pages. */
export const MODE_OF: Readonly<Record<ColourTarget, 'placed' | 'unplaced'>> = { pptx: 'placed', ppt: 'placed', docx: 'unplaced' };

const METRICS_SCRIPT = path.join(REPO_ROOT, 'bench', 'pdf-colour-metrics.py');
const REFERENCE_IMPORT: Readonly<Record<ColourTarget, { infilter: string; convertTo: string }>> = {
  pptx: { infilter: 'impress_pdf_import', convertTo: 'pptx' },
  ppt: { infilter: 'impress_pdf_import', convertTo: 'ppt' },
  docx: { infilter: 'writer_pdf_import', convertTo: 'docx:MS Word 2007 XML' },
};

/** What `bench/pdf-colour-metrics.py` counts for one file. */
export interface PairScore {
  pages: [number, number];
  words: { source: number; drawn: number; matched: number; wordMatched: number; colouredSource: number; colouredMatched: number };
  shapes: { source: number; drawn: number; matched: number; byKind: Record<string, [number, number]> };
  ssim?: { grey: number; rgb: number; mae: number };
}

/** The scores of a corpus: counts summed over its files, ratios taken from the sums. */
export interface ColourScores {
  files: number;
  /** F1 of the (word, colour) pairs: a word counts when the drawn text has it in the same colour. */
  textColourF1: number;
  /** Share of the words of the source that are not dark and come back in their colour. */
  colouredWordRecall: number;
  /** Share of the words of the source that come back at all, of any colour (the text itself, for context). */
  wordRecall: number;
  /** Share of the source's boxes, lines and curves that the drawn document has, with the colour (and the place for a slide). */
  shapeRecall: number;
  shapePrecision: number;
  /** Mean SSIM of the drawn page against the source page, grey and over the three channels, and the mean absolute pixel error (slides only). */
  ssimGrey: number | null;
  ssimRgb: number | null;
  pixelError: number | null;
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 1 : part / whole);

export function sumScores(scores: readonly PairScore[]): ColourScores {
  const total = { source: 0, drawn: 0, matched: 0, wordMatched: 0, colouredSource: 0, colouredMatched: 0, shapeSource: 0, shapeDrawn: 0, shapeMatched: 0 };
  const ssim = { grey: 0, rgb: 0, mae: 0, count: 0 };
  for (const score of scores) {
    total.source += score.words.source;
    total.drawn += score.words.drawn;
    total.matched += score.words.matched;
    total.wordMatched += score.words.wordMatched;
    total.colouredSource += score.words.colouredSource;
    total.colouredMatched += score.words.colouredMatched;
    total.shapeSource += score.shapes.source;
    total.shapeDrawn += score.shapes.drawn;
    total.shapeMatched += score.shapes.matched;
    if (score.ssim) {
      ssim.grey += score.ssim.grey;
      ssim.rgb += score.ssim.rgb;
      ssim.mae += score.ssim.mae;
      ssim.count++;
    }
  }
  const precision = ratio(total.matched, total.drawn);
  const recall = ratio(total.matched, total.source);
  return {
    files: scores.length,
    textColourF1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    colouredWordRecall: ratio(total.colouredMatched, total.colouredSource),
    wordRecall: ratio(total.wordMatched, total.source),
    shapeRecall: ratio(total.shapeMatched, total.shapeSource),
    shapePrecision: ratio(total.shapeMatched, total.shapeDrawn),
    ssimGrey: ssim.count > 0 ? ssim.grey / ssim.count : null,
    ssimRgb: ssim.count > 0 ? ssim.rgb / ssim.count : null,
    pixelError: ssim.count > 0 ? ssim.mae / ssim.count : null,
  };
}

export interface OfficeTools {
  soffice: string;
  python: string;
  /** `file://` URL of the office suite's profile directory. */
  profile: string;
}

function convertWithOffice(tools: OfficeTools, input: string, convertTo: string, outDir: string, infilter?: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  runTool(tools.soffice, [`-env:UserInstallation=${tools.profile}`, '--headless', ...(infilter ? [`--infilter=${infilter}`] : []), '--convert-to', convertTo, '--outdir', outDir, input]);
  return path.join(outDir, `${path.parse(input).name}.${convertTo.split(':')[0]}`);
}

/** The office suite's own import of a PDF, saved in the format of the target. */
export function referenceImport(tools: OfficeTools, pdf: string, target: ColourTarget, outDir: string): string {
  const { infilter, convertTo } = REFERENCE_IMPORT[target];
  return convertWithOffice(tools, pdf, convertTo, outDir, infilter);
}

/** Scores a converted file against its source PDF: the office suite prints it to PDF, which the metrics script reads. */
export function scoreConverted(tools: OfficeTools, target: ColourTarget, sourcePdf: string, converted: string, outDir: string): PairScore {
  const printed = convertWithOffice(tools, converted, 'pdf', outDir);
  const run = runTool(tools.python, [METRICS_SCRIPT, MODE_OF[target], sourcePdf, printed]);
  return JSON.parse(run.stdout.toString('utf8')) as PairScore;
}
