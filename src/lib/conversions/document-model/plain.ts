import { blankDocument } from './build';
import type { DocumentModel, ParagraphBlock } from './model';

/** A blank line (LF or CRLF line ends) ends a paragraph. */
const PARAGRAPH_BREAK = /\r?\n[ \t]*(?:\r?\n[ \t]*)+/;

export interface PlainTextOptions {
  /** `join` reflows the lines of a paragraph into one (recognized text); `keep` keeps each line break (a text file). */
  lines?: 'join' | 'keep';
}

/** A document of paragraphs from text whose paragraphs are separated by blank lines. */
export function plainTextModel(text: string, options: PlainTextOptions = {}): DocumentModel {
  const separator = options.lines === 'keep' ? '\n' : ' ';
  const blocks: ParagraphBlock[] = text
    .split(PARAGRAPH_BREAK)
    // Join the lines of a paragraph; a split is linear where a \s*\n\s* pattern backtracks on long runs.
    .map((part) =>
      part
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join(separator)
    )
    .filter((part) => part !== '')
    .map((part) => ({ type: 'paragraph', runs: [{ text: part, bold: false, italic: false, monospace: false }], rtl: false, align: 'left' }));
  return blankDocument([{ columns: 1, blocks }]);
}
