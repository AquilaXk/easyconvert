import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { requireOracleTool } from './differential-oracle';

/**
 * Readers and probes for the PDFs an HTML page is converted to. Poppler (pdfimages) and pdf-lib read the PDF; neither
 * shares code with the converter.
 */

const PDFIMAGES_HEADER_LINES = 2;
const IMAGE_ROW_TYPE_COLUMN = 2;
const IMAGE_ROW_TYPE = 'image';
const EXECUTABLE_MODE = 0o755;

/** URI actions of every link annotation of the PDF. */
export async function pdfLinkTargets(pdfBytes: Buffer): Promise<string[]> {
  const pdf = await PDFDocument.load(pdfBytes);
  const uris: string[] = [];
  for (const page of pdf.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const action = annots.lookup(i, PDFDict).lookupMaybe(PDFName.of('A'), PDFDict);
      const uri = action?.lookupMaybe(PDFName.of('URI'), PDFString);
      if (uri) uris.push(uri.decodeText());
    }
  }
  return uris;
}

/** Number of images in the PDF, from the `pdfimages -list` rows (a soft mask is a row of its own and is not counted). */
export function pdfImageCount(pdf: Buffer): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-pdf-images-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const listing = execFileSync(requireOracleTool('pdfimages'), ['-list', file], { encoding: 'utf-8' });
    return listing
      .split('\n')
      .slice(PDFIMAGES_HEADER_LINES)
      .filter((row) => row.trim().split(/\s+/)[IMAGE_ROW_TYPE_COLUMN] === IMAGE_ROW_TYPE).length;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs `convert` while a stand-in for LibreOffice records the HTML document it is handed and answers with a blank PDF,
 * then returns that document: the one thing the renderer ever reads.
 */
export async function withCapturingSoffice(convert: () => Promise<unknown>): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-soffice-'));
  const capture = path.join(dir, 'captured.html');
  const blank = path.join(dir, 'blank.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  fs.writeFileSync(blank, await pdf.save());
  const stub = path.join(dir, 'soffice');
  fs.writeFileSync(
    stub,
    [
      '#!/bin/sh',
      'case "$*" in *--help*) exit 0;; esac',
      'outdir=""; input=""',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "--outdir" ]; then outdir="$2"; fi',
      '  input="$1"',
      '  shift',
      'done',
      'name=$(basename "$input"); name="${name%.*}"',
      `case "$input" in *.html) cp "$input" '${capture}';; esac`,
      `cp '${blank}' "$outdir/$name.pdf"`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: EXECUTABLE_MODE }
  );
  const previous = process.env.SOFFICE_PATH;
  process.env.SOFFICE_PATH = stub;
  try {
    await convert();
    return fs.readFileSync(capture, 'utf-8');
  } finally {
    if (previous === undefined) delete process.env.SOFFICE_PATH;
    else process.env.SOFFICE_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
