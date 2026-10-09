import type { PdfContentFont, PdfContentImage, PdfContentItem, PdfPageContent } from '../pdf-text-types';
import type {
  Block,
  DocumentImage,
  Inline,
  DocumentMargins,
  DocumentModel,
  HeadingBlock,
  ListBlock,
  ParagraphBlock,
  Section,
  TableBlock,
  TableCellBlock,
} from '../document-model/model';
import { isRightToLeftRegion, orderRows, type LineGroup } from './columns';
import { buildRows } from './lines';
import { LayoutBudget } from './limits';
import { continuesInNextFlow, mergeParagraphs, paragraphsOfFlow } from './paragraphs';
import { assembleLists, bodySizeOf, headingLevels, inlineRuns } from './structure';
import { detectLatticeTables, detectStreamTables, tableSegment } from './tables';
import { extractVerticalLines } from './vertical';
import type { DetectedTable, FontList, LayoutLine, Paragraph, Row } from './types';

/**
 * Document structure from the positioned content of a PDF's pages: lines and rows, tables (ruled, then aligned),
 * columns and reading order, paragraphs, headings and lists. Pure functions over the content the text thread returns;
 * every page is bounded by a step budget (PDF_LAYOUT_MAX_STEPS_PER_PAGE) and its recursion depth by PDF_LAYOUT_MAX_DEPTH.
 */

export { PdfLayoutLimitError, PDF_LAYOUT_MAX_DEPTH, PDF_LAYOUT_MAX_STEPS_PER_PAGE } from './limits';

/** Default page margin in points when a page has no text to measure one from. */
const DEFAULT_MARGIN = 72;
const MIN_MARGIN = 18;
const MAX_MARGIN = 144;
/** An image is placed after the block it sits under when their horizontal extents overlap by this share of the image. */
const IMAGE_OVERLAP_SHARE = 0.2;
const COLUMN_FLOW_BASE = 10;

interface BlockMeta {
  columns: number;
  band: number;
}

type PageBlock =
  | ({ kind: 'paragraph'; paragraph: Paragraph; full: boolean } & BlockMeta)
  | ({ kind: 'table'; table: DetectedTable } & BlockMeta)
  | ({ kind: 'image'; image: PdfContentImage; imageId: number } & BlockMeta);

interface PageLayout {
  page: PdfPageContent;
  blocks: PageBlock[];
  /** Extent of the page's body text. */
  bounds: { x0: number; y0: number; x1: number; y1: number } | null;
}

function textBounds(items: PdfContentItem[]): PageLayout['bounds'] {
  const body = items.filter((item) => !item.angled && item.text.trim() !== '');
  if (body.length === 0) return null;
  return {
    x0: Math.min(...body.map((item) => item.x)),
    x1: Math.max(...body.map((item) => item.x + item.width)),
    y0: Math.min(...body.map((item) => item.baseline - item.size)),
    y1: Math.max(...body.map((item) => item.baseline)),
  };
}

function tableRow(table: DetectedTable): Row {
  return { segments: [tableSegment(table)], baseline: table.box.y1, top: table.box.y0, bottom: table.box.y1, table };
}

/** Rows in reading order top to bottom: text rows by baseline, table rows by their top edge. */
function sortedRows(rows: Row[]): Row[] {
  const key = (row: Row): number => (row.table ? row.top : row.baseline);
  return [...rows].sort((a, b) => key(a) - key(b));
}

function angledParagraphs(items: PdfContentItem[], fonts: FontList, budget: LayoutBudget, flow: number, pageNumber: number): Paragraph[] {
  const angled = items.filter((item) => item.angled && item.text.trim() !== '');
  const paragraphs: Paragraph[] = [];
  for (const item of angled) {
    const rows = buildRows([{ ...item, angled: false }], fonts, budget);
    const lines = rows.map((row) => row.segments[0]);
    paragraphs.push(...paragraphsOfFlow(lines, flow, pageNumber, true));
  }
  return paragraphs;
}

class Counter {
  private value = 0;

  next(): number {
    return ++this.value;
  }
}

function layoutPage(page: PdfPageContent, fonts: FontList, flows: Counter, bandBase: number): PageLayout {
  const budget = new LayoutBudget(page.pageNumber);
  const vertical = extractVerticalLines(page.items, fonts, budget);
  const lattice = detectLatticeTables(page.rules, vertical.rest, fonts, budget, page.pageNumber);
  let rows = buildRows(lattice.remaining, fonts, budget);
  rows = detectStreamTables(rows, fonts, budget, page.pageNumber);
  rows = sortedRows([...rows, ...lattice.tables.map(tableRow)]);
  const groups: LineGroup[] = orderRows(rows, budget, isRightToLeftRegion(rows));

  const blocks: PageBlock[] = [];
  for (const group of groups) {
    const meta: BlockMeta = { columns: group.columns, band: group.band < 0 ? -1 : bandBase + group.band };
    if (group.table) {
      blocks.push({ kind: 'table', table: group.table, ...meta });
      continue;
    }
    const flow = flows.next();
    for (const paragraph of paragraphsOfFlow(group.lines, flow, page.pageNumber, group.full)) {
      blocks.push({ kind: 'paragraph', paragraph, full: group.full, ...meta });
    }
  }
  if (vertical.lines.length > 0) {
    const flow = flows.next();
    for (const paragraph of paragraphsOfFlow(vertical.lines, flow, page.pageNumber, true)) {
      const boxes = paragraph.lines.map((line) => line.pageBox!);
      const box = {
        x0: Math.min(...boxes.map((b) => b.x0)),
        x1: Math.max(...boxes.map((b) => b.x1)),
        y0: Math.min(...boxes.map((b) => b.y0)),
        y1: Math.max(...boxes.map((b) => b.y1)),
      };
      blocks.push({ kind: 'paragraph', paragraph: { ...paragraph, box }, full: true, columns: 1, band: -1 });
    }
  }
  for (const paragraph of angledParagraphs(page.items, fonts, budget, flows.next(), page.pageNumber)) {
    blocks.push({ kind: 'paragraph', paragraph, full: true, columns: 1, band: -1 });
  }
  return { page, blocks, bounds: textBounds(page.items) };
}

function blockBox(block: PageBlock): { x0: number; y0: number; x1: number; y1: number } {
  if (block.kind === 'paragraph') return block.paragraph.box;
  if (block.kind === 'table') return block.table.box;
  return { x0: block.image.x, y0: block.image.y, x1: block.image.x + block.image.width, y1: block.image.y + block.image.height };
}

/** Puts each image of a page before the first block below its top edge that shares horizontal space with it. */
function placeImages(layout: PageLayout, images: (DocumentImage | undefined)[]): void {
  layout.page.images.forEach((image, index) => {
    const decoded = images[index];
    if (!decoded) return;
    const entry: PageBlock = { kind: 'image', image, imageId: decoded.id, columns: 1, band: -1 };
    const spans = (block: PageBlock): boolean => {
      const box = blockBox(block);
      const overlap = Math.min(box.x1, image.x + image.width) - Math.max(box.x0, image.x);
      return overlap > IMAGE_OVERLAP_SHARE * image.width;
    };
    const at = layout.blocks.findIndex((block) => block.kind !== 'image' && blockBox(block).y0 >= image.y - 1 && spans(block));
    if (at < 0) layout.blocks.push(entry);
    else layout.blocks.splice(at, 0, entry);
  });
}

/** Largest difference (points) between the column widths of a table and its continuation on the next page. */
const TABLE_WIDTH_TOLERANCE = 4;

/** Whether `next` is the rest of `last` on a following page: the same grid of columns. */
function continuesTable(last: DetectedTable, next: DetectedTable): boolean {
  if (next.pageNumber <= last.pageNumber || last.kind !== next.kind) return false;
  if (last.columnWidths.length !== next.columnWidths.length) return false;
  return last.columnWidths.every((width, index) => Math.abs(width - next.columnWidths[index]) <= TABLE_WIDTH_TOLERANCE);
}

function rowText(row: DetectedTable['rows'][number]): string {
  return row.map((cell) => cell.paragraphs.map((paragraph) => paragraph.text).join(' ')).join('|');
}

/** The rows of both tables; a header repeated at the top of the continuation is not written twice. */
function joinTables(last: DetectedTable, next: DetectedTable): DetectedTable {
  const repeated = next.rows.length > 0 && last.rows.length > 0 && rowText(next.rows[0]) === rowText(last.rows[0]);
  return { ...last, rows: [...last.rows, ...(repeated ? next.rows.slice(1) : next.rows)], box: { ...last.box, y1: Math.max(last.box.y1, next.box.y1) } };
}

/** Paragraphs that continue into the next flow (column or page) become one. */
function joinContinuations(blocks: PageBlock[]): PageBlock[] {
  const flowRight = new Map<number, number>();
  for (const block of blocks) {
    if (block.kind === 'paragraph') flowRight.set(block.paragraph.flow, Math.max(flowRight.get(block.paragraph.flow) ?? 0, block.paragraph.box.x1));
  }
  const joined: PageBlock[] = [];
  for (const block of blocks) {
    const last = joined[joined.length - 1];
    if (block.kind === 'table' && last?.kind === 'table' && continuesTable(last.table, block.table)) {
      joined[joined.length - 1] = { ...last, table: joinTables(last.table, block.table) };
      continue;
    }
    if (
      block.kind === 'paragraph' &&
      last?.kind === 'paragraph' &&
      last.paragraph.flow !== block.paragraph.flow &&
      continuesInNextFlow(last.paragraph, block.paragraph, flowRight.get(last.paragraph.flow) ?? last.paragraph.box.x1)
    ) {
      joined[joined.length - 1] = { ...last, paragraph: mergeParagraphs(last.paragraph, block.paragraph) };
    } else {
      joined.push(block);
    }
  }
  return joined;
}

/** Runs without bold when the whole text is bold already because of its role (a heading, a table header). */
function plainWeight(runs: Inline[], applies: boolean): Inline[] {
  return applies ? runs.map((run) => ({ ...run, bold: false })) : runs;
}

function paragraphBlockOf(paragraph: Paragraph, bodySize: number, header = false): ParagraphBlock {
  const different = Math.abs(paragraph.size - bodySize) > 0.5;
  return { type: 'paragraph', runs: plainWeight(inlineRuns(paragraph.runs), header), rtl: paragraph.rtl, align: 'left', ...(different ? { size: paragraph.size } : {}) };
}

function tableBlockOf(table: DetectedTable, bodySize: number): TableBlock {
  const rows: TableCellBlock[][] = table.rows.map((row) =>
    row.map((cell) => ({
      paragraphs: cell.paragraphs.map((paragraph) => paragraphBlockOf(paragraph, bodySize, cell.header)),
      colSpan: cell.colSpan,
      rowSpan: cell.rowSpan,
      continuation: cell.continuation,
      header: cell.header,
    }))
  );
  return { type: 'table', rows, columnWidths: table.columnWidths, bordered: table.kind === 'lattice' };
}

function dominantFont(paragraphs: Paragraph[], fonts: FontList): DocumentModel['bodyFont'] {
  const weight = { serif: 0, sans: 0, monospace: 0 };
  const byName = new Map<string, PdfContentFont>();
  fonts.forEach((font) => byName.set(font.name, font));
  for (const paragraph of paragraphs) {
    const font = byName.get(paragraph.fontKey);
    if (font?.monospace) weight.monospace += paragraph.text.length;
    else if (font?.serif) weight.serif += paragraph.text.length;
    else weight.sans += paragraph.text.length;
  }
  if (weight.serif > weight.sans && weight.serif >= weight.monospace) return 'serif';
  if (weight.monospace > weight.sans) return 'monospace';
  return 'sans';
}

function headingSizesOf(levels: Map<Paragraph, number>): (number | undefined)[] {
  const sums: { total: number; count: number }[] = [];
  for (const [paragraph, level] of levels) {
    sums[level - 1] = sums[level - 1] ?? { total: 0, count: 0 };
    sums[level - 1].total += paragraph.size;
    sums[level - 1].count++;
  }
  return Array.from(sums, (entry) => (entry ? entry.total / entry.count : undefined));
}

function clampMargin(value: number): number {
  return Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, value));
}

function marginsOf(layouts: PageLayout[]): DocumentMargins {
  const measured = layouts.filter((layout) => layout.bounds !== null);
  if (measured.length === 0) return { top: DEFAULT_MARGIN, right: DEFAULT_MARGIN, bottom: DEFAULT_MARGIN, left: DEFAULT_MARGIN };
  const first = measured[0].page;
  return {
    left: clampMargin(Math.min(...measured.map((layout) => layout.bounds!.x0))),
    top: clampMargin(Math.min(...measured.map((layout) => layout.bounds!.y0))),
    right: clampMargin(first.width - Math.max(...measured.map((layout) => layout.bounds!.x1))),
    bottom: clampMargin(first.height - Math.max(...measured.map((layout) => layout.bounds!.y1))),
  };
}

/**
 * Lays out the pages of a document.
 * @throws PdfLayoutLimitError when a page needs more than PDF_LAYOUT_MAX_STEPS_PER_PAGE steps.
 */
/** Share of the page height at the top and at the bottom where running headers and footers sit. */
const PAGE_FURNITURE_BAND = 0.08;
/** Pages a running header or footer must recur on in a document of several pages. */
const PAGE_FURNITURE_MIN_PAGES = 2;
/** Tolerance in points when comparing a header's size with the body size. */
const PAGE_FURNITURE_SIZE_TOLERANCE = 0.5;
const PAGE_NUMBER = /\d+/g;

type ParagraphEntry = Extract<PageBlock, { kind: 'paragraph' }>;
type FurnitureBand = 'header' | 'footer';

/** The band of the page a one-line paragraph sits in, or undefined when it is in the body. */
function furnitureBand(entry: ParagraphEntry, pageHeights: Map<number, number>): FurnitureBand | undefined {
  const { paragraph } = entry;
  const height = pageHeights.get(paragraph.pageNumber);
  if (!height || paragraph.lines.length !== 1) return undefined;
  if (paragraph.box.y1 <= height * PAGE_FURNITURE_BAND) return 'header';
  if (paragraph.box.y0 >= height * (1 - PAGE_FURNITURE_BAND)) return 'footer';
  return undefined;
}

/** Text with page numbers masked, so "Page 3" and "Page 4" count as the same running line. */
function furnitureKey(text: string): string {
  return text.replace(PAGE_NUMBER, '#').trim();
}

/**
 * Running headers and footers: one-line paragraphs in the top or bottom band of their page that recur on several
 * pages (page numbers masked) or, in a one-page document, are no larger than the body text. They leave the body flow
 * and become the document's page header and footer.
 */
function splitPageFurniture(
  blocks: PageBlock[],
  pages: PdfPageContent[]
): { body: PageBlock[]; header: Paragraph[]; footer: Paragraph[] } {
  const pageHeights = new Map(pages.map((page) => [page.pageNumber, page.height]));
  const candidates = new Map<PageBlock, FurnitureBand>();
  for (const block of blocks) {
    if (block.kind !== 'paragraph') continue;
    const band = furnitureBand(block, pageHeights);
    if (band) candidates.set(block, band);
  }
  if (candidates.size === 0) return { body: blocks, header: [], footer: [] };
  const accepted = new Set<PageBlock>();
  if (pages.length >= PAGE_FURNITURE_MIN_PAGES) {
    const pagesByKey = new Map<string, Set<number>>();
    for (const [block, band] of candidates) {
      const entry = block as ParagraphEntry;
      const key = `${band}:${furnitureKey(entry.paragraph.text)}`;
      const seen = pagesByKey.get(key) ?? new Set<number>();
      seen.add(entry.paragraph.pageNumber);
      pagesByKey.set(key, seen);
    }
    for (const [block, band] of candidates) {
      const entry = block as ParagraphEntry;
      if ((pagesByKey.get(`${band}:${furnitureKey(entry.paragraph.text)}`)?.size ?? 0) >= PAGE_FURNITURE_MIN_PAGES) accepted.add(block);
    }
  } else {
    const rest = blocks.flatMap((block) => (block.kind === 'paragraph' && !candidates.has(block) ? [block.paragraph] : []));
    if (rest.length > 0) {
      const body = bodySizeOf(rest);
      for (const block of candidates.keys()) {
        if ((block as ParagraphEntry).paragraph.size <= body + PAGE_FURNITURE_SIZE_TOLERANCE) accepted.add(block);
      }
    }
  }
  if (accepted.size === 0) return { body: blocks, header: [], footer: [] };
  const firstPageOf = (band: FurnitureBand): Paragraph[] => {
    const lines = [...accepted].filter((block) => candidates.get(block) === band).map((block) => (block as ParagraphEntry).paragraph);
    if (lines.length === 0) return [];
    const firstPage = Math.min(...lines.map((paragraph) => paragraph.pageNumber));
    return lines.filter((paragraph) => paragraph.pageNumber === firstPage).sort((a, b) => a.box.y0 - b.box.y0);
  };
  return { body: blocks.filter((block) => !accepted.has(block)), header: firstPageOf('header'), footer: firstPageOf('footer') };
}

export function layoutPdfDocument(pages: PdfPageContent[], fonts: PdfContentFont[]): DocumentModel {
  const flows = new Counter();
  const imageIds = new Counter();
  const layouts = pages.map((page, index) => layoutPage(page, fonts, flows, index * COLUMN_FLOW_BASE * 1000));
  const documentImages: DocumentImage[] = [];
  layouts.forEach((layout) => {
    // Images that came with their file become blocks; a placement without one (not asked for, too large) has nothing to write.
    const decoded = layout.page.images.map((image): DocumentImage | undefined => {
      if (!image.data || !image.format) return undefined;
      const entry: DocumentImage = { id: imageIds.next(), format: image.format, data: image.data, pixelWidth: image.pixelWidth, pixelHeight: image.pixelHeight };
      documentImages.push(entry);
      return entry;
    });
    placeImages(layout, decoded);
  });
  const furniture = splitPageFurniture(joinContinuations(layouts.flatMap((layout) => layout.blocks)), pages);
  const blocks = furniture.body;

  const paragraphs = blocks.flatMap((block) => (block.kind === 'paragraph' && !block.full ? [block.paragraph] : []));
  const bodySize = bodySizeOf(paragraphs.length > 0 ? paragraphs : blocks.flatMap((block) => (block.kind === 'paragraph' ? [block.paragraph] : [])));
  const levels = headingLevels(
    blocks.flatMap((block) => (block.kind === 'paragraph' ? [block.paragraph] : [])),
    bodySize
  );

  const model: Block[] = [];
  const columnsOf: number[] = [];
  const push = (block: Block, columns: number): void => {
    model.push(block);
    columnsOf.push(columns);
  };
  let listId = 0;
  let at = 0;
  while (at < blocks.length) {
    const block = blocks[at];
    if (block.kind === 'table') {
      push(tableBlockOf(block.table, bodySize), block.columns);
      at++;
      continue;
    }
    if (block.kind === 'image') {
      push({ type: 'image', imageId: block.imageId, widthPt: block.image.width, heightPt: block.image.height }, block.columns);
      at++;
      continue;
    }
    // Lists are assembled over the run of consecutive paragraphs starting here.
    let runEnd = at;
    while (runEnd < blocks.length && blocks[runEnd].kind === 'paragraph') runEnd++;
    const run = blocks.slice(at, runEnd).map((entry) => (entry as Extract<PageBlock, { kind: 'paragraph' }>));
    const runParagraphs = run.map((entry) => entry.paragraph);
    const listRuns = assembleLists(runParagraphs, (paragraph) => !levels.has(paragraph), () => ++listId);
    let cursor = 0;
    const emitParagraph = (index: number): void => {
      const entry = run[index];
      const level = levels.get(entry.paragraph);
      if (level !== undefined) {
        const heading: HeadingBlock = { type: 'heading', level, runs: plainWeight(inlineRuns(entry.paragraph.runs), entry.paragraph.lines.every((line) => line.bold)), rtl: entry.paragraph.rtl };
        push(heading, entry.columns);
      } else {
        push(paragraphBlockOf(entry.paragraph, bodySize), entry.columns);
      }
    };
    for (const listRun of listRuns) {
      for (; cursor < listRun.from; cursor++) emitParagraph(cursor);
      const list: ListBlock = listRun.list;
      push(list, run[listRun.from].columns);
      cursor = listRun.to;
    }
    for (; cursor < run.length; cursor++) emitParagraph(cursor);
    at = runEnd;
  }

  const sections: Section[] = [];
  model.forEach((block, index) => {
    const columns = columnsOf[index];
    const last = sections[sections.length - 1];
    if (last && last.columns === columns) last.blocks.push(block);
    else sections.push({ columns, blocks: [block] });
  });
  const first = pages[0];
  return {
    sections,
    images: documentImages,
    pageWidthPt: first?.width ?? 0,
    pageHeightPt: first?.height ?? 0,
    margins: marginsOf(layouts),
    bodySize,
    bodyFont: dominantFont(paragraphs, fonts),
    headingSizes: headingSizesOf(levels),
    pageCount: pages.length,
    ...(furniture.header.length > 0 ? { pageHeader: furniture.header.map((paragraph) => inlineRuns(paragraph.runs)) } : {}),
    ...(furniture.footer.length > 0 ? { pageFooter: furniture.footer.map((paragraph) => inlineRuns(paragraph.runs)) } : {}),
  };
}

export type { DocumentModel, LayoutLine };
