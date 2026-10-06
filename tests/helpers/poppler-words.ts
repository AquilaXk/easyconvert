import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';
import { xpathText } from './xml-oracle';

/**
 * Word boxes from the reference text extractor (`pdftotext -bbox-layout`), in the rotated page's own
 * top-left coordinate frame, points. Used as an independent oracle for word geometry that is
 * derived from a PDF's text layer.
 */

export interface WordBox {
  page: number;
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const PDFTOTEXT_TIMEOUT_MS = 60_000;
const WORD_ELEMENT = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/;
const ENTITIES: ReadonlyArray<[RegExp, string]> = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  [/&amp;/g, '&'],
];

function decode(text: string): string {
  return ENTITIES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

export function popplerWords(pdf: Buffer): WordBox[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppler-words-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const xhtml = execFileSync(requireOracleTool('pdftotext'), ['-bbox-layout', file, '-'], {
      encoding: 'utf-8',
      timeout: PDFTOTEXT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    const words: WordBox[] = [];
    let page = 0;
    for (const line of xhtml.split('\n')) {
      if (line.trimStart().startsWith('<page ')) page++;
      const match = WORD_ELEMENT.exec(line);
      if (match) {
        words.push({ page, text: decode(match[5]), x0: Number(match[1]), y0: Number(match[2]), x1: Number(match[3]), y1: Number(match[4]) });
      }
    }
    return words;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One serialized word element: anchored, with the text matched up to the next tag, so matching is linear in the line. */
const HOCR_WORD_LINE = /^<span class="ocrx_word" id="word_(\d+)_\d+_\d+" title="bbox (\d+) (\d+) (\d+) (\d+)(?:;[^"]*)?">([^<]*)<\/span>$/;

/** Word boxes of an hOCR document, read through xmllint's serialization of the word elements. */
export function hocrWords(hocr: string): WordBox[] {
  const out = xpathText(hocr, "//*[@class='ocrx_word']");
  const words: WordBox[] = [];
  for (const line of out.split('\n')) {
    const match = HOCR_WORD_LINE.exec(line.trim());
    if (match) {
      words.push({ page: Number(match[1]), text: decode(match[6]), x0: Number(match[2]), y0: Number(match[3]), x1: Number(match[4]), y1: Number(match[5]) });
    }
  }
  return words;
}

/** The part of a per-page OCR result this helper reads (structural, so the helper imports no production module). */
interface PageWords {
  lineBlocks?: Array<{ words: Array<{ text: string; bbox: { x: number; y: number; width: number; height: number } }> }>;
}

/** Word boxes of per-page OCR results (the exact geometry, before an export rounds it to pixels). */
export function ocrWords(pages: Map<number, PageWords>): WordBox[] {
  const words: WordBox[] = [];
  for (const [page, result] of [...pages].sort(([p, ], [q, ]) => p - q)) {
    for (const block of result.lineBlocks ?? []) {
      for (const word of block.words) {
        words.push({
          page,
          text: word.text,
          x0: word.bbox.x,
          y0: word.bbox.y,
          x1: word.bbox.x + word.bbox.width,
          y1: word.bbox.y + word.bbox.height,
        });
      }
    }
  }
  return words;
}

export function intersectionOverUnion(a: WordBox, b: WordBox): number {
  const width = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const height = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - intersection;
  return intersection / union;
}

/**
 * The extractor writes words as drawn: ligature glyphs keep their compatibility code points and
 * right-to-left words come out in visual (reversed) character order. A candidate in logical order with
 * plain letters is the same word when it equals either form after NFKC.
 */
export function sameWord(reference: string, candidate: string): boolean {
  const drawn = reference.normalize('NFKC');
  const logical = candidate.normalize('NFKC');
  return drawn === logical || [...drawn].reverse().join('') === logical;
}

/**
 * Pairs every reference word with the unused word of the same page and the same text (see sameWord) that overlaps it most,
 * and returns the IoU of each pair (0 when there is none).
 */
export function matchedIou(reference: WordBox[], candidate: WordBox[]): number[] {
  const used = new Set<number>();
  return reference.map((expected) => {
    let best = 0;
    let bestIndex = -1;
    candidate.forEach((actual, index) => {
      if (used.has(index) || actual.page !== expected.page || !sameWord(expected.text, actual.text)) return;
      const iou = intersectionOverUnion(expected, actual);
      if (iou > best) {
        best = iou;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) used.add(bestIndex);
    return best;
  });
}
