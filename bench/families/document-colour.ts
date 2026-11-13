import fs from 'node:fs';
import path from 'node:path';
import { convertWithProject } from '../convert';
import type { FamilyRunner } from '../context';
import { REPO_ROOT } from '../config';
import { type ColourTarget, type OfficeTools, type PairScore, referenceImport, scoreConverted, sumScores } from '../pdf-colour';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC } from '../rows';
import { PYMUPDF_PSEUDO_TOOL } from '../tools';

/**
 * Colour and vector shapes of the slides and Word documents written from a PDF, on the five documents of tests/fixtures/pdf-colour
 * (coloured text, shaded and ruled tables, filled boxes and bands, charts and diagrams drawn with rectangles, lines and curves).
 * The converted file is printed to PDF by the office suite and read, with the source PDF, by PyMuPDF (bench/pdf-colour-metrics.py);
 * the reference is the office suite's own import of the PDF, saved in the same format and printed the same way. A slide is compared
 * with its page place by place, a Word document (which reflows its pages) by the kinds and colours of its words and shapes.
 */

const FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'pdf-colour');
const TARGETS: readonly ColourTarget[] = ['pptx', 'docx', 'ppt'];
const SPECS: readonly MetricSpec[] = [SPEC.textColourF1, SPEC.colouredWordRecall, SPEC.shapeRecall, SPEC.shapePrecision];
const REFERENCE = 'soffice';

const caseOf = (target: ColourTarget): string => `pdf-colour->${target}`;

async function runTarget(ctx: Parameters<FamilyRunner>[0], target: ColourTarget, rows: BenchRow[]): Promise<void> {
  const caseName = caseOf(target);
  if (!ctx.inScope('document', caseName)) return;
  const plan = ctx.plan([REFERENCE, 'python3', PYMUPDF_PSEUDO_TOOL], caseName);
  if (!plan.ok) {
    rows.push(...skippedGroup('document', caseName, SPECS, REFERENCE, plan));
    return;
  }
  ctx.log(`document ${caseName}`);
  if (!ctx.quality) return;
  const tools: OfficeTools = { soffice: plan.paths.soffice, python: plan.paths.python3, profile: `file://${path.join(ctx.work, 'soffice-profile-colour')}` };
  const names = fs.readdirSync(FIXTURE_DIR).filter((file) => file.endsWith('.pdf')).sort();
  const ours: PairScore[] = [];
  const reference: PairScore[] = [];
  for (const file of names) {
    const name = path.basename(file, '.pdf');
    const pdf = path.join(FIXTURE_DIR, file);
    const converted = (await convertWithProject(fs.readFileSync(pdf), 'pdf', target, {}, file)).buffer;
    const oursFile = ctx.scratch(`ours-${name}.${target}`);
    fs.writeFileSync(oursFile, converted);
    ours.push(scoreConverted(tools, target, pdf, oursFile, ctx.scratch(`ours-print-${name}-${target}`)));
    const referenceFile = referenceImport(tools, pdf, target, ctx.scratch(`reference-${name}-${target}`));
    reference.push(scoreConverted(tools, target, pdf, referenceFile, ctx.scratch(`reference-print-${name}-${target}`)));
  }
  const ourScores = sumScores(ours);
  const referenceScores = sumScores(reference);
  rows.push(
    measuredRow('document', caseName, SPEC.textColourF1, ourScores.textColourF1, referenceScores.textColourF1, REFERENCE),
    measuredRow('document', caseName, SPEC.colouredWordRecall, ourScores.colouredWordRecall, referenceScores.colouredWordRecall, REFERENCE),
    measuredRow('document', caseName, SPEC.shapeRecall, ourScores.shapeRecall, referenceScores.shapeRecall, REFERENCE),
    measuredRow('document', caseName, SPEC.shapePrecision, ourScores.shapePrecision, referenceScores.shapePrecision, REFERENCE)
  );
}

export const runDocumentColour: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  for (const target of TARGETS) await runTarget(ctx, target, rows);
  return rows;
};
