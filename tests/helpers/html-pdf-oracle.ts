import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
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

/** A word of the PDF with its box in points, and the width of the page it is on. */
export interface PdfWordBox {
  text: string;
  xMin: number;
  xMax: number;
  pageWidth: number;
}

const BOX_PATTERN = /<page width="([\d.]+)"|<word xMin="([-\d.]+)" yMin="[-\d.]+" xMax="([-\d.]+)" yMax="[-\d.]+">([^<]*)<\/word>/g;
const XML_ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  [/&amp;/g, '&'],
];

/** The words Poppler finds in the PDF (`pdftotext -bbox`) with the box of each; text outside the page is not in the PDF, so it is not listed. */
export function pdfWordBoxes(pdf: Buffer): PdfWordBox[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-pdf-boxes-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const listing = execFileSync(requireOracleTool('pdftotext'), ['-bbox', file, '-'], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
    const words: PdfWordBox[] = [];
    let pageWidth = 0;
    for (const match of listing.matchAll(BOX_PATTERN)) {
      if (match[1] !== undefined) {
        pageWidth = Number(match[1]);
        continue;
      }
      const text = XML_ENTITIES.reduce((decoded, [entity, character]) => decoded.replace(entity, character), match[4]);
      words.push({ text, xMin: Number(match[2]), xMax: Number(match[3]), pageWidth });
    }
    return words;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The words of the PDF whose box is not inside the width of its page. */
export function wordsOutsidePage(words: readonly PdfWordBox[]): string[] {
  return words.filter((word) => word.xMin < 0 || word.xMax > word.pageWidth).map((word) => word.text);
}

/** The text of an HTML page as parse5 reads it: the text nodes of the body, without scripts, styles and templates. */
export function htmlText(html: string): string {
  const parts: string[] = [];
  const visit = (node: DefaultTreeAdapterMap['node']): void => {
    if ('tagName' in node && NON_TEXT_ELEMENTS.has(node.tagName)) return;
    if (node.nodeName === '#text') parts.push((node as DefaultTreeAdapterMap['textNode']).value);
    const children = 'content' in node ? node.content.childNodes : 'childNodes' in node ? node.childNodes : [];
    for (const child of children) visit(child);
  };
  visit(parse(html));
  return parts.join(' ');
}

const NON_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['head', 'script', 'style', 'template', 'noscript']);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

/**
 * How many letters and digits the HTML text holds that the PDF text does not (each character counted by value, so the way a
 * reader joins or splits words at a line end or between columns does not matter). Zero when nothing was lost.
 */
export function lostCharacters(expectedText: string, pdfText: string): number {
  const available = new Map<string, number>();
  for (const character of pdfText.match(LETTER_OR_DIGIT) ?? []) available.set(character, (available.get(character) ?? 0) + 1);
  let lost = 0;
  for (const character of expectedText.match(LETTER_OR_DIGIT) ?? []) {
    const left = available.get(character) ?? 0;
    if (left > 0) available.set(character, left - 1);
    else lost += 1;
  }
  return lost;
}
