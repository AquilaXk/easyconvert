/**
 * Measures the colour and vector-shape agreement of PDF to PPTX, PPT and DOCX on PDF files, against the office suite's own
 * import of the same files (bench/pdf-colour.ts):
 *
 *   npx tsx bench/pdf-colour-measure.ts [--targets pptx,docx,ppt] [--json out.json] [--work dir] <file.pdf>...
 *
 * With no files it reads tests/fixtures/pdf-colour and tests/fixtures/pdf-structure. Prints one line per file and target, then
 * the scores of each corpus (counts summed over the files).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithProject } from './convert';
import { REPO_ROOT } from './config';
import { MODE_OF, type ColourTarget, type OfficeTools, type PairScore, referenceImport, scoreConverted, sumScores } from './pdf-colour';

const PDF_CORPORA: Readonly<Record<string, string>> = {
  colour: path.join(REPO_ROOT, 'tests', 'fixtures', 'pdf-colour'),
  structure: path.join(REPO_ROOT, 'tests', 'fixtures', 'pdf-structure'),
};

function argumentsOf(): { targets: ColourTarget[]; json?: string; work: string; files: string[] } {
  const args = process.argv.slice(2);
  let targets: ColourTarget[] = ['pptx', 'docx', 'ppt'];
  let json: string | undefined;
  let work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-colour-'));
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--targets') targets = args[++i].split(',') as ColourTarget[];
    else if (args[i] === '--json') json = args[++i];
    else if (args[i] === '--work') work = args[++i];
    else files.push(args[i]);
  }
  return { targets, json, work, files };
}

async function main(): Promise<void> {
  const { targets, json, work, files } = argumentsOf();
  const tools: OfficeTools = { soffice: 'soffice', python: 'python3', profile: `file://${path.join(work, 'profile')}` };
  const groups: Record<string, string[]> =
    files.length > 0
      ? { given: files }
      : Object.fromEntries(Object.entries(PDF_CORPORA).map(([name, dir]) => [name, fs.readdirSync(dir).filter((file) => file.endsWith('.pdf')).sort().map((file) => path.join(dir, file))]));
  const report: Record<string, unknown> = {};
  for (const [group, pdfs] of Object.entries(groups)) {
    for (const target of targets) {
      const ours: PairScore[] = [];
      const reference: PairScore[] = [];
      for (const pdf of pdfs) {
        const name = path.basename(pdf, '.pdf');
        const dir = path.join(work, `${group}-${target}-${name}`);
        fs.mkdirSync(dir, { recursive: true });
        try {
          const converted = (await convertWithProject(fs.readFileSync(pdf), 'pdf', target, {}, `${name}.pdf`)).buffer;
          const oursFile = path.join(dir, `ours-${name}.${target}`);
          fs.writeFileSync(oursFile, converted);
          const refFile = referenceImport(tools, pdf, target, path.join(dir, 'ref'));
          const oursScore = scoreConverted(tools, target, pdf, oursFile, path.join(dir, 'ours-print'));
          const refScore = scoreConverted(tools, target, pdf, refFile, path.join(dir, 'ref-print'));
          ours.push(oursScore);
          reference.push(refScore);
          const brief = (s: PairScore): string => `words ${s.words.matched}/${s.words.source} coloured ${s.words.colouredMatched}/${s.words.colouredSource} shapes ${s.shapes.matched}/${s.shapes.source} (+${s.shapes.drawn - s.shapes.matched})`;
          console.log(`${group} ${target} ${name}: ours ${brief(oursScore)} | ref ${brief(refScore)}`);
        } catch (error) {
          console.log(`${group} ${target} ${name}: FAILED ${(error as Error).message.slice(0, 200)}`);
        }
      }
      const summary = { mode: MODE_OF[target], ours: sumScores(ours), reference: sumScores(reference) };
      report[`${group}/${target}`] = summary;
      console.log(`== ${group}/${target} (${MODE_OF[target]})\n${JSON.stringify(summary, null, 1)}`);
    }
  }
  if (json) fs.writeFileSync(json, `${JSON.stringify(report, null, 1)}\n`);
}

void main();
