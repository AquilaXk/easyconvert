/**
 * Generates the PDF colour corpus in tests/fixtures/pdf-colour/: five documents whose text colours, fills, rules and
 * vector shapes are known from the sources written for this repository (original text, no third-party material). The HTML
 * and flat OpenDocument drawing sources in `sources/` are rendered to PDF by LibreOffice, the SVG source by rsvg-convert
 * (a Cairo PDF), so the corpus has two PDF producers. Run:
 *
 *   npx tsx scripts/generate-pdf-colour-fixtures.ts
 *
 * See tests/fixtures/pdf-colour/PROVENANCE.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUTPUT_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'pdf-colour');
const SOURCE_DIR = path.join(OUTPUT_DIR, 'sources');
const TOOL_TIMEOUT_MS = 180_000;
const SOURCES = ['colour-text.html', 'colour-table.html', 'colour-boxes.html', 'shapes-chart.fodg', 'diagram.svg'] as const;

function renderWithOffice(source: string, outDir: string): string {
  execFileSync('soffice', ['--headless', `-env:UserInstallation=file://${path.join(outDir, 'profile')}`, '--convert-to', 'pdf', '--outdir', outDir, source], {
    timeout: TOOL_TIMEOUT_MS,
    stdio: 'ignore',
  });
  return path.join(outDir, `${path.basename(source).replace(/\.[^.]+$/, '')}.pdf`);
}

function renderWithCairo(source: string, outDir: string): string {
  const target = path.join(outDir, `${path.basename(source, '.svg')}.pdf`);
  execFileSync('rsvg-convert', ['-f', 'pdf', '-o', target, source], { timeout: TOOL_TIMEOUT_MS });
  return target;
}

function main(): void {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-colour-fixtures-'));
  try {
    for (const name of SOURCES) {
      const source = path.join(SOURCE_DIR, name);
      const pdf = name.endsWith('.svg') ? renderWithCairo(source, work) : renderWithOffice(source, work);
      fs.copyFileSync(pdf, path.join(OUTPUT_DIR, path.basename(pdf)));
      console.log(`${name}: ${fs.statSync(pdf).size} bytes`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
