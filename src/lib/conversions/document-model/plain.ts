import type { DocumentModel, ParagraphBlock } from './model';

/** A4 in points, used when text with no page geometry (recognized text) is turned into a document. */
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const DEFAULT_MARGIN_PT = 72;
const DEFAULT_BODY_PT = 11;
const PARAGRAPH_BREAK = /\n[ \t]*\n+/;

/** A document of paragraphs from text whose paragraphs are separated by blank lines. */
export function plainTextModel(text: string): DocumentModel {
  const blocks: ParagraphBlock[] = text
    .split(PARAGRAPH_BREAK)
    // Join the lines of a paragraph with one space; a split is linear where a \s*\n\s* pattern backtracks on long runs.
    .map((part) =>
      part
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join(' ')
    )
    .filter((part) => part !== '')
    .map((part) => ({ type: 'paragraph', runs: [{ text: part, bold: false, italic: false, monospace: false }], rtl: false, align: 'left' }));
  return {
    sections: [{ columns: 1, blocks }],
    images: [],
    pageWidthPt: A4_WIDTH_PT,
    pageHeightPt: A4_HEIGHT_PT,
    margins: { top: DEFAULT_MARGIN_PT, right: DEFAULT_MARGIN_PT, bottom: DEFAULT_MARGIN_PT, left: DEFAULT_MARGIN_PT },
    bodySize: DEFAULT_BODY_PT,
    bodyFont: 'sans',
    headingSizes: [],
    pageCount: 1,
  };
}
