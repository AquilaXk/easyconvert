import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireOracleTool } from './differential-oracle';

/**
 * Where the internal links of a PDF point, read with qpdf (the link annotations and their destinations, as JSON) and
 * pdftotext (the words of each page with their boxes). Neither shares code with the converter. A link is described by
 * its text, the page its destination is on and the first word at or below the destination point on that page.
 */

export interface PdfLinkTarget {
  /** The words under the link annotation. */
  link: string;
  /** Page of the destination, from 1. */
  page: number;
  /** The first word at or below the destination point. */
  after: string;
}

export interface Word {
  page: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  text: string;
}

interface QpdfObject {
  value?: unknown;
}

interface QpdfJson {
  pages: Array<{ object: string }>;
  qpdf: [unknown, Record<string, QpdfObject>];
}

type PdfDict = Record<string, unknown>;

const POINT_TOLERANCE = 1;
const WORD_BOX = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/;
const PAGE_HEIGHT = /<page width="[\d.]+" height="([\d.]+)"/;
const HTML_ENTITIES: ReadonlyArray<[RegExp, string]> = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&amp;/g, '&'],
];

export function wordsOf(pdfPath: string): { words: Word[]; heights: number[] } {
  const listing = execFileSync(requireOracleTool('pdftotext'), ['-bbox', pdfPath, '-'], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
  const words: Word[] = [];
  const heights: number[] = [];
  for (const line of listing.split('\n')) {
    const height = PAGE_HEIGHT.exec(line);
    if (height) heights.push(Number(height[1]));
    const box = WORD_BOX.exec(line);
    if (box) {
      const text = HTML_ENTITIES.reduce((decoded, [pattern, replacement]) => decoded.replace(pattern, replacement), box[5]);
      words.push({ page: heights.length, xMin: Number(box[1]), yMin: Number(box[2]), xMax: Number(box[3]), yMax: Number(box[4]), text });
    }
  }
  return { words, heights };
}

/** The pages (from 1) that show `word`, from the words pdftotext reads. */
export function pdfPagesOfWord(pdf: Buffer, word: string): number[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-word-pages-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    return [...new Set(wordsOf(file).words.filter((candidate) => candidate.text === word).map((candidate) => candidate.page))];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The internal links of a PDF (a link annotation with a destination inside the document), in reading order. */
export function pdfInternalLinkTargets(pdf: Buffer): PdfLinkTarget[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-link-targets-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const json = JSON.parse(execFileSync(requireOracleTool('qpdf'), ['--json', file], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 })) as QpdfJson;
    const objects = json.qpdf[1];
    const dereference = (reference: unknown): PdfDict => (objects[`obj:${String(reference)}`]?.value ?? {}) as PdfDict;
    const pageNumbers = new Map(json.pages.map((page, index) => [page.object, index + 1]));
    const { words, heights } = wordsOf(file);
    const targets: PdfLinkTarget[] = [];
    json.pages.forEach((pageEntry, pageIndex) => {
      const annotations = ((dereference(pageEntry.object)['/Annots'] as string[] | undefined) ?? []).map(dereference);
      // The annotations are not stored in reading order: top to bottom, then left to right.
      annotations.sort((a, b) => (b['/Rect'] as number[])[3] - (a['/Rect'] as number[])[3] || (a['/Rect'] as number[])[0] - (b['/Rect'] as number[])[0]);
      for (const annotation of annotations) {
        const action = annotation['/A'] as PdfDict | undefined;
        const destination = (annotation['/Dest'] ?? action?.['/D']) as unknown[] | undefined;
        if (annotation['/Subtype'] !== '/Link' || !Array.isArray(destination) || typeof destination[0] !== 'string') continue;
        const [left, bottom, right, top] = annotation['/Rect'] as number[];
        const height = heights[pageIndex];
        const link = words
          .filter((word) => word.page === pageIndex + 1 && word.xMin >= left - POINT_TOLERANCE && word.xMax <= right + POINT_TOLERANCE && word.yMin >= height - top - POINT_TOLERANCE && word.yMax <= height - bottom + POINT_TOLERANCE)
          .map((word) => word.text)
          .join(' ');
        const page = pageNumbers.get(destination[0]) ?? 0;
        const destinationTop = heights[page - 1] - Number(destination[3]);
        const after = words
          .filter((word) => word.page === page && word.yMin >= destinationTop - POINT_TOLERANCE && word.xMax >= Number(destination[2]) - POINT_TOLERANCE)
          .sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin)[0];
        targets.push({ link, page, after: after?.text ?? '' });
      }
    });
    return targets;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
