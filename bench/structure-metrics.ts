import crypto from 'node:crypto';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

/**
 * Structure precision and recall for document conversions. A document is reduced to multisets of structural facts
 * (headings with their level, list items with their nesting level, table cells with their spans, images by content
 * hash, note texts) read from HTML with a WHATWG parser, so the same reader scores the project's output and a
 * reference tool's output against a truth written by hand. Nothing here is shared with the converters.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export const STRUCTURE_CATEGORIES = ['headings', 'listItems', 'tableCells', 'images', 'notes'] as const;
export type StructureCategory = (typeof STRUCTURE_CATEGORIES)[number];

export type DocumentStructure = Record<StructureCategory, string[]>;

export interface CategoryScore {
  precision: number;
  recall: number;
  truth: number;
  candidate: number;
}

export type StructureScores = Record<StructureCategory, CategoryScore>;

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const LIST_TAGS = new Set(['ul', 'ol']);
const CELL_TAGS = new Set(['td', 'th']);
const NOTE_CONTAINER = /^(?:fn-|footnote-|endnote-|sdfootnote|sdendnote)/;
/** EPUB Structural Semantics vocabulary values that mark a note body (EPUB 3.3 section 4.3 of the structural semantics vocabulary). */
const NOTE_EPUB_TYPES = new Set(['footnote', 'endnote', 'rearnote']);
const DATA_IMAGE = /^data:[^;,]*;base64,(.*)$/s;

export function emptyStructure(): DocumentStructure {
  return { headings: [], listItems: [], tableCells: [], images: [], notes: [] };
}

function isElement(node: Node): node is Element {
  return 'tagName' in node && 'attrs' in node;
}

function childrenOf(node: Node): Node[] {
  if ('content' in node && node.content) return node.content.childNodes;
  return 'childNodes' in node ? node.childNodes : [];
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function textOf(node: Node, skip?: (element: Element) => boolean): string {
  if ('value' in node && node.nodeName === '#text') return node.value;
  if (isElement(node) && skip?.(node)) return '';
  return childrenOf(node)
    .map((child) => textOf(child, skip))
    .join('');
}

/** Own text of a list item: everything but its nested lists. */
function itemText(item: Element): string {
  return textOf(item, (element) => LIST_TAGS.has(element.tagName));
}

/**
 * Reads the structure of an HTML document. `resolveImage` maps an `src` that is not a data: URI to the bytes it
 * names (a reference tool writes pictures next to its HTML).
 */
export function structureOfHtml(html: string, resolveImage?: (src: string) => Buffer | undefined): DocumentStructure {
  const structure = emptyStructure();
  const root = parse(html);

  const visit = (node: Node, listDepth: number, inNote: boolean): void => {
    if (!isElement(node)) {
      for (const child of childrenOf(node)) visit(child, listDepth, inNote);
      return;
    }
    const tag = node.tagName;
    const id = attribute(node, 'id') ?? '';
    const epubTypes = (attribute(node, 'epub:type') ?? '').split(/\s+/);
    const marksNote = NOTE_CONTAINER.test(id) || epubTypes.some((type) => NOTE_EPUB_TYPES.has(type));
    const enteringNote = marksNote && (tag === 'li' || tag === 'div' || tag === 'aside' || tag === 'section');
    if (enteringNote && !inNote) {
      // A note's own numeral and the back-link arrow are reading aids, not its text.
      structure.notes.push(normalizeText(textOf(node)).replace(/^(?:\d+\s*|[ivx]+\s+|[ivx]+(?=[A-Z]))/, '').replace(/\s*↩$/, ''));
      return;
    }
    if (HEADING_TAGS.has(tag)) {
      structure.headings.push(`${tag.slice(1)}|${normalizeText(textOf(node))}`);
    } else if (tag === 'li') {
      const ordered = (node.parentNode as Element | null)?.tagName === 'ol';
      structure.listItems.push(`${listDepth - 1}|${ordered ? 'ol' : 'ul'}|${normalizeText(itemText(node))}`);
    } else if (CELL_TAGS.has(tag)) {
      const colspan = Number(attribute(node, 'colspan') ?? '1') || 1;
      const rowspan = Number(attribute(node, 'rowspan') ?? '1') || 1;
      structure.tableCells.push(`${normalizeText(textOf(node))}|${colspan}|${rowspan}`);
    } else if (tag === 'img') {
      const src = attribute(node, 'src') ?? '';
      const data = DATA_IMAGE.exec(src);
      const bytes = data ? Buffer.from(data[1], 'base64') : resolveImage?.(src);
      if (bytes) structure.images.push(crypto.createHash('sha256').update(bytes).digest('hex'));
    }
    const nextDepth = LIST_TAGS.has(tag) ? listDepth + 1 : listDepth;
    for (const child of childrenOf(node)) visit(child, nextDepth, inNote);
  };
  visit(root, 0, false);
  return structure;
}

function multisetIntersection(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let common = 0;
  for (const item of b) {
    const left = counts.get(item) ?? 0;
    if (left > 0) {
      common += 1;
      counts.set(item, left - 1);
    }
  }
  return common;
}

/** Precision and recall of `candidate` against `truth` for every category (an empty category on both sides scores 1). */
export function scoreStructure(truth: DocumentStructure, candidate: DocumentStructure): StructureScores {
  const scores = {} as StructureScores;
  for (const category of STRUCTURE_CATEGORIES) {
    const common = multisetIntersection(truth[category], candidate[category]);
    const bothEmpty = truth[category].length === 0 && candidate[category].length === 0;
    scores[category] = {
      precision: bothEmpty ? 1 : candidate[category].length === 0 ? 0 : common / candidate[category].length,
      recall: bothEmpty ? 1 : truth[category].length === 0 ? 0 : common / truth[category].length,
      truth: truth[category].length,
      candidate: candidate[category].length,
    };
  }
  return scores;
}

/** Micro-averaged precision and recall over every category with truth. */
export function overallScore(truth: DocumentStructure, candidate: DocumentStructure): { precision: number; recall: number } {
  let common = 0;
  let truthTotal = 0;
  let candidateTotal = 0;
  for (const category of STRUCTURE_CATEGORIES) {
    common += multisetIntersection(truth[category], candidate[category]);
    truthTotal += truth[category].length;
    candidateTotal += candidate[category].length;
  }
  return { precision: candidateTotal === 0 ? 0 : common / candidateTotal, recall: truthTotal === 0 ? 0 : common / truthTotal };
}
