#!/usr/bin/env node
/**
 * Authors `symbol-fonts.doc`, a Word 97-2003 document with runs in Symbol, Wingdings, Wingdings 2, Wingdings 3 and
 * Webdings, by exporting a flat OpenDocument text file from the office suite (headless). The file is written by the
 * office suite, not by the converter, so its character formatting is an input the reader has not shaped.
 * `PROVENANCE.md` lists the runs and the characters each one is expected to become.
 *
 * Run:  node tests/fixtures/word-symbol-fonts/build-symbol-fonts-doc.mjs [output.doc]   (needs `soffice` on PATH)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One paragraph per run: the font of the span and the characters it holds (code in the font + U+F000). */
export const RUNS = [
  { font: 'Symbol', chars: '\uF0B7\uF061\uF062\uF0E5' },
  { font: 'Wingdings', chars: '\uF0FC\uF06C\uF0A7' },
  { font: 'Wingdings 2', chars: '\uF052\uF054' },
  { font: 'Wingdings 3', chars: '\uF070\uF071' },
  { font: 'Webdings', chars: '\uF061' },
];

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';

export function flatOdtWithSymbolRuns() {
  const faces = RUNS.map(
    ({ font }) => `<style:font-face style:name="${font}" svg:font-family="${font}" style:font-charset="x-symbol" style:font-pitch="variable"/>`
  ).join('');
  const styles = RUNS.map(
    ({ font }, i) => `<style:style style:name="T${i}" style:family="text"><style:text-properties style:font-name="${font}" fo:font-family="${font}"/></style:style>`
  ).join('');
  const paragraphs = RUNS.map(({ chars }, i) => `<text:p>Run ${i + 1}: <text:span text:style-name="T${i}">${chars}</text:span> end</text:p>`).join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><office:document ${NS} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.text">` +
      `<office:font-face-decls>${faces}</office:font-face-decls><office:automatic-styles>${styles}</office:automatic-styles>` +
      `<office:body><office:text>${paragraphs}</office:text></office:body></office:document>`,
    'utf-8'
  );
}

export function buildSymbolFontsDoc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-fonts-doc-'));
  try {
    fs.writeFileSync(path.join(dir, 'symbol-fonts.fodt'), flatOdtWithSymbolRuns());
    execFileSync(
      'soffice',
      ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'doc', '--outdir', dir, path.join(dir, 'symbol-fonts.fodt')],
      { stdio: 'ignore', timeout: 120_000, env: { ...process.env, HOME: dir } }
    );
    return fs.readFileSync(path.join(dir, 'symbol-fonts.doc'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'symbol-fonts.doc');
  fs.writeFileSync(output, buildSymbolFontsDoc());
  console.log(`wrote ${output}`);
}
