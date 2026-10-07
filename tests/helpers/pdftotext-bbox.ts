import { execFileSync } from 'node:child_process';
import { getOracleToolPath, OracleToolMissingError } from './differential-oracle';

/**
 * Word positions of a PDF as Poppler reports them (`pdftotext -bbox-layout`): an independent
 * reader of the text layer, in points from the top left of the page.
 */

export interface PdfWord {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface PdfPageWords {
  width: number;
  height: number;
  words: PdfWord[];
}

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity]);
}

export function requirePdftotext(): string {
  const tool = getOracleToolPath('pdftotext');
  if (!tool) throw new OracleToolMissingError('pdftotext', 'pdftotext is not installed');
  return tool;
}

export function pdfWords(pdfPath: string): PdfPageWords[] {
  const html = execFileSync(requirePdftotext(), ['-bbox-layout', '-enc', 'UTF-8', pdfPath, '-'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const pages: PdfPageWords[] = [];
  for (const pageMatch of html.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)) {
    const words: PdfWord[] = [];
    for (const wordMatch of pageMatch[3].matchAll(
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g
    )) {
      words.push({
        xMin: Number(wordMatch[1]),
        yMin: Number(wordMatch[2]),
        xMax: Number(wordMatch[3]),
        yMax: Number(wordMatch[4]),
        text: unescapeXml(wordMatch[5]),
      });
    }
    pages.push({ width: Number(pageMatch[1]), height: Number(pageMatch[2]), words });
  }
  return pages;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function boxIou(a: Box, b: Box): number {
  const overlapX = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const overlapY = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const intersection = overlapX * overlapY;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * For each reference word, the best IoU with a word of the PDF that has the same text; a reference
 * word with no such word scores 0. Each PDF word is used once.
 */
export function wordIous(
  reference: ReadonlyArray<Box & { text: string }>,
  actual: readonly PdfWord[]
): number[] {
  const used = new Set<number>();
  return reference.map((ref) => {
    let best = 0;
    let bestIndex = -1;
    actual.forEach((word, index) => {
      if (used.has(index) || word.text !== ref.text) return;
      const iou = boxIou(ref, { x0: word.xMin, y0: word.yMin, x1: word.xMax, y1: word.yMax });
      if (iou > best) {
        best = iou;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) used.add(bestIndex);
    return best;
  });
}
