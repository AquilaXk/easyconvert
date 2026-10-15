import type { Block, DocumentImage, DocumentModel, ImageFormat, Inline, NoteDefinition, TableCellBlock } from './model';

/** Helpers every reader and writer of the document model shares: traversal, picture formats and link targets. */

/** The content of a table cell in order: its blocks when it holds more than paragraphs, otherwise its paragraphs. */
export function cellBlocks(cell: TableCellBlock): readonly Block[] {
  return cell.blocks ?? cell.paragraphs;
}

/** Visits `blocks` and every block nested in quotes and table cells, in document order. */
export function walkBlocks(blocks: readonly Block[], visit: (block: Block) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.type === 'quote') {
      walkBlocks(block.blocks, visit);
    } else if (block.type === 'table') {
      for (const row of block.rows) for (const cell of row) walkBlocks(cellBlocks(cell), visit);
    }
  }
}

/** The runs a block holds directly: a heading's, a paragraph's, and those of every item of a list. */
export function blockRuns(block: Block): Inline[][] {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return [block.runs];
    case 'list':
      return block.items.map((item) => item.runs);
    default:
      return [];
  }
}

/** Visits the runs of `blocks`, those nested in quotes and table cells included, in document order. */
export function walkRuns(blocks: readonly Block[], visit: (run: Inline) => void): void {
  walkBlocks(blocks, (block) => {
    for (const runs of blockRuns(block)) for (const run of runs) visit(run);
  });
}

/** The blocks of every section of `model` in order. */
export function bodyBlocks(model: DocumentModel): Block[] {
  return model.sections.flatMap((section) => section.blocks);
}

export function notesOf(model: DocumentModel, kind: 'footnote' | 'endnote'): NoteDefinition[] {
  return (kind === 'footnote' ? model.footnotes : model.endnotes) ?? [];
}

/** The pictures of `model` by id. */
export function imagesById(model: DocumentModel): Map<number, DocumentImage> {
  return new Map(model.images.map((image) => [image.id, image]));
}

export const IMAGE_MIME: Readonly<Record<ImageFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
};

export const IMAGE_EXTENSION: Readonly<Record<ImageFormat, string>> = {
  jpeg: 'jpg',
  png: 'png',
  gif: 'gif',
  bmp: 'bmp',
  tiff: 'tif',
  svg: 'svg',
};

const IMAGE_SIGNATURES: readonly { format: ImageFormat; prefix: readonly number[] }[] = [
  { format: 'png', prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'jpeg', prefix: [0xff, 0xd8, 0xff] },
  { format: 'gif', prefix: [0x47, 0x49, 0x46, 0x38] },
  { format: 'bmp', prefix: [0x42, 0x4d] },
  { format: 'tiff', prefix: [0x49, 0x49, 0x2a, 0x00] },
  { format: 'tiff', prefix: [0x4d, 0x4d, 0x00, 0x2a] },
];
const SVG_SCAN_BYTES = 512;

/** The picture format of `data` by its magic bytes, or null when it is none the model carries. */
export function sniffImageFormat(data: Uint8Array): ImageFormat | null {
  for (const { format, prefix } of IMAGE_SIGNATURES) {
    if (prefix.every((byte, index) => data[index] === byte)) return format;
  }
  if (Buffer.from(data.subarray(0, SVG_SCAN_BYTES)).toString('utf8').includes('<svg')) return 'svg';
  return null;
}

const SAFE_LINK_SCHEMES = /^(?:https?|mailto|ftp):/i;

/** A link target a writer may emit: an allowed scheme or an in-document anchor; anything else is not a link. */
export function safeHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  const trimmed = href.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('#') || SAFE_LINK_SCHEMES.test(trimmed)) return trimmed;
  return undefined;
}

/** A run of text with the given style; the other style fields are left unset. */
export function textRun(text: string, style: Partial<Omit<Inline, 'text'>> = {}): Inline {
  return { bold: false, italic: false, monospace: false, ...style, text };
}

export function imageRun(image: NonNullable<Inline['image']>): Inline {
  return textRun('', { image });
}

export function noteRun(note: NonNullable<Inline['note']>): Inline {
  return textRun('', { note });
}

export function anchorRun(name: string): Inline {
  return textRun('', { anchor: name });
}

/** Whether the run carries text (not a picture, a note reference or an anchor). */
export function isTextRun(run: Inline): boolean {
  return run.image === undefined && run.note === undefined && run.anchor === undefined;
}

/** Whether two text runs have one format, so their texts can be joined. */
export function sameRunFormat(a: Inline, b: Inline): boolean {
  return (
    isTextRun(a) &&
    isTextRun(b) &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.monospace === b.monospace &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.superscript === b.superscript &&
    a.subscript === b.subscript &&
    a.href === b.href &&
    a.sizePt === b.sizePt &&
    a.color === b.color
  );
}

/**
 * Finds the text size most characters use, stores it as `model.bodySize` and removes `sizePt` from runs of that
 * size, so only runs that differ from the body text carry a size.
 */
export function normalizeBodySize(model: DocumentModel): void {
  const weight = new Map<number, number>();
  const groups: Block[][] = [...model.sections.map((section) => section.blocks), ...(model.footnotes ?? []).map((note) => note.blocks), ...(model.endnotes ?? []).map((note) => note.blocks)];
  for (const blocks of groups) {
    walkRuns(blocks, (run) => {
      if (run.sizePt !== undefined) weight.set(run.sizePt, (weight.get(run.sizePt) ?? 0) + run.text.length);
    });
  }
  let best: number | undefined;
  let bestWeight = 0;
  for (const [size, total] of weight) {
    if (total > bestWeight) {
      best = size;
      bestWeight = total;
    }
  }
  if (best === undefined) return;
  model.bodySize = best;
  for (const blocks of groups) {
    walkRuns(blocks, (run) => {
      if (run.sizePt === best) delete run.sizePt;
    });
  }
}
