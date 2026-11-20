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
  ParagraphFormat,
  Section,
  TableBlock,
  TableCellBlock,
} from '../document-model/model';
import { isRightToLeftRegion, orderRows, type LineGroup } from './columns';
import { buildRows } from './lines';
import { LayoutBudget } from './limits';
import { pageCounterBlocks, type CounterForm, type FurnitureLine } from './page-counters';
import { builderOf, continuesInNextFlow, type ParagraphBuilder, paragraphsOfFlow } from './paragraphs';
import { hangShapes, type BlockOrigin, type BodyBlocks } from './figures';
import { absorbFigureSpacers, irregularColumnPages, PageFlow, pageSections } from './page-flow';
import { hexOf, PageInk, readableRuns } from './ink';
import { assembleLists, bodySizeOf, headingLevels, inlineRuns } from './structure';
import { detectLatticeTables, detectStreamTables, tableSegment } from './tables';
import { extractVerticalLines } from './vertical';
import type { Box, DetectedTable, FontList, LayoutLine, Paragraph, Row, TableCell } from './types';

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

export type PageBlock =
  | ({ kind: 'paragraph'; paragraph: Paragraph; full: boolean } & BlockMeta)
  | ({ kind: 'table'; table: DetectedTable } & BlockMeta)
  | ({ kind: 'image'; image: PdfContentImage; imageId: number; pageNumber: number } & BlockMeta);

export interface PageLayout {
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

/**
 * The positioned blocks of every page as the layout pass finds them, with nothing taken out and nothing joined across pages: the
 * running headers and footers, page counters and the pieces of a table that goes on over a page stay where the page draws them. A
 * writer that keeps the page (slides) reads this; one that makes a flow (documents) reads `layoutPdf`.
 * @throws PdfLayoutLimitError when a page needs more than PDF_LAYOUT_MAX_STEPS_PER_PAGE steps.
 */
export function layoutPdfPages(pages: PdfPageContent[], fonts: PdfContentFont[]): PageLayout[] {
  const flows = new Counter();
  return pages.map((page, index) => layoutPage(page, fonts, flows, index * COLUMN_FLOW_BASE * 1000));
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
    const entry: PageBlock = { kind: 'image', image, imageId: decoded.id, pageNumber: layout.page.pageNumber, columns: 1, band: -1 };
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

/** A table and the tables that continue it on the following pages, made one table when the run ends (a header repeated at the top of a continuation is not written twice). */
class TableRun {
  private readonly rows: TableCell[][];
  private y1: number;

  constructor(private readonly head: DetectedTable) {
    this.rows = [...head.rows];
    this.y1 = head.box.y1;
  }

  add(next: DetectedTable): void {
    const repeated = next.rows.length > 0 && this.rows.length > 0 && rowText(next.rows[0]) === rowText(this.rows[0]);
    for (let i = repeated ? 1 : 0; i < next.rows.length; i++) this.rows.push(next.rows[i]);
    this.y1 = Math.max(this.y1, next.box.y1);
  }

  finish(): DetectedTable {
    return { ...this.head, rows: this.rows, box: { ...this.head.box, y1: this.y1 } };
  }
}

/**
 * Tables that continue on a following page become one, and with `'all'` so do paragraphs that continue into the next flow (column or page).
 * With `'page'` nothing is joined across a page, and paragraphs that continue into the next column of their page are.
 * A run of tables or of paragraphs that continue into one another is gathered once and made a table or a paragraph when the run ends:
 * building the merged block at every step copies the rows or the lines before it, which a document of pages that are each one open
 * paragraph, or one table, turns into work quadratic in the page count. The block that starts a run stays at the end of `joined` as it
 * was built until the run ends. A caller that keeps only the tables asks for `'tables'` and merges no paragraph. Exported for its tests.
 */
export function joinContinuations(blocks: PageBlock[], join: 'all' | 'tables' | 'page' = 'all'): PageBlock[] {
  const flowRight = new Map<number, number>();
  for (const block of blocks) {
    if (join !== 'tables' && block.kind === 'paragraph') {
      flowRight.set(block.paragraph.flow, Math.max(flowRight.get(block.paragraph.flow) ?? 0, block.paragraph.box.x1));
    }
  }
  const joined: PageBlock[] = [];
  let paragraphRun: ParagraphBuilder | undefined;
  let tableRun: TableRun | undefined;
  const finishRun = (): void => {
    const at = joined.length - 1;
    if (paragraphRun) joined[at] = { ...(joined[at] as ParagraphEntry), paragraph: paragraphRun.finish() };
    else if (tableRun) joined[at] = { ...(joined[at] as TableEntry), table: tableRun.finish() };
    paragraphRun = undefined;
    tableRun = undefined;
  };
  for (const block of blocks) {
    const last = joined[joined.length - 1];
    if (join !== 'page' && block.kind === 'table' && last?.kind === 'table' && continuesTable(last.table, block.table)) {
      tableRun ??= new TableRun(last.table);
      tableRun.add(block.table);
      continue;
    }
    // A full paragraph (vertical, angled, or one that fills its flow) never continues, and its stored box is not the one its lines give.
    if (join !== 'tables' && block.kind === 'paragraph' && last?.kind === 'paragraph' && !last.paragraph.full && last.paragraph.flow !== block.paragraph.flow && (join === 'all' || last.paragraph.pageNumber === block.paragraph.pageNumber)) {
      const open = paragraphRun ?? builderOf(last.paragraph);
      const end = open.end();
      if (continuesInNextFlow(end, block.paragraph, flowRight.get(last.paragraph.flow) ?? end.x1)) {
        open.addAll(block.paragraph.lines);
        paragraphRun = open;
        continue;
      }
    }
    finishRun();
    joined.push(block);
  }
  finishRun();
  return joined;
}

/** Runs without bold when the whole text is bold already because of its role (a heading, a table header). */
function plainWeight(runs: Inline[], applies: boolean): Inline[] {
  return applies ? runs.map((run) => ({ ...run, bold: false })) : runs;
}

/**
 * The fill behind a paragraph or heading and its runs with colours that can be read. A page read with colour paints text on fills:
 * the fill goes with the paragraph, and light text (white on a dark band) stays light only where a fill is carried.
 */
function inkOfParagraph(paragraph: Paragraph, runs: Inline[], ink: PageInk | undefined): { runs: Inline[]; shading?: string } {
  if (!ink?.active) return { runs };
  const fill = ink.fillBehind(paragraph.pageNumber, paragraph.box);
  return { runs: readableRuns(runs, fill !== undefined), ...(fill === undefined ? {} : { shading: hexOf(fill) }) };
}

function paragraphBlockOf(paragraph: Paragraph, bodySize: number, header = false, ink?: PageInk, cellFilled?: boolean): ParagraphBlock {
  const different = Math.abs(paragraph.size - bodySize) > 0.5;
  const runs = plainWeight(inlineRuns(paragraph.runs), header);
  // The paragraph of a shaded cell has the cell's fill, so the cell carries it and its text stays as it is.
  const painted = cellFilled === undefined ? inkOfParagraph(paragraph, runs, ink) : { runs: ink?.active ? readableRuns(runs, cellFilled) : runs };
  return { type: 'paragraph', ...painted, rtl: paragraph.rtl, align: 'left', ...(different ? { size: paragraph.size } : {}) };
}

/** The box of the text of a table cell: the union of the boxes of its paragraphs; null for an empty cell. */
function cellTextBox(cell: TableCell): Paragraph['box'] | null {
  const boxes = cell.paragraphs.map((paragraph) => paragraph.box);
  if (boxes.length === 0) return null;
  return { x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)), x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)) };
}

/** `block` set as its page set it, when the flow of a page is kept. */
function formatted<T extends { format?: ParagraphFormat }>(block: T, format: ParagraphFormat | undefined): T {
  if (format) block.format = format;
  return block;
}

/** The page's x of each column edge of a table: its left edge, then the right edge of every column. */
function columnEdgesOf(table: DetectedTable): number[] {
  const edges = [table.box.x0];
  for (const width of table.columnWidths) edges.push(edges[edges.length - 1] + width);
  return edges;
}

/** Points a row grows by when its text sets taller than the page's row. */
interface RowGrowth {
  total: number;
}

function tableBlockOf(table: DetectedTable, bodySize: number, ink?: PageInk, flow?: PageFlow, growth?: RowGrowth): TableBlock {
  const columnEdges = columnEdgesOf(table);
  const rows: TableCellBlock[][] = table.rows.map((row, rowIndex) => {
    let column = 0;
    let needed = 0;
    const cells = row.map((cell) => {
      const box = ink?.active ? cellTextBox(cell) : null;
      const fill = box ? ink?.fillBehind(table.pageNumber, box) : undefined;
      const inCell = flow?.cell({ y0: table.rowEdges?.[rowIndex], y1: table.rowEdges?.[rowIndex + 1], x0: columnEdges[column], x1: columnEdges[column + cell.colSpan] });
      column += cell.colSpan;
      const paragraphs = cell.paragraphs.map((paragraph) =>
        formatted(paragraphBlockOf(paragraph, bodySize, cell.header, ink, ink?.active ? fill !== undefined : undefined), inCell?.paragraph(paragraph, 1))
      );
      const rowTop = table.rowEdges?.[rowIndex];
      if (inCell?.end !== undefined && rowTop !== undefined && cell.rowSpan <= 1) needed = Math.max(needed, inCell.end - rowTop);
      return {
        paragraphs,
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
        continuation: cell.continuation,
        header: cell.header,
        ...(fill === undefined ? {} : { shading: hexOf(fill) }),
      };
    });
    const height = (table.rowEdges?.[rowIndex + 1] ?? 0) - (table.rowEdges?.[rowIndex] ?? 0);
    if (growth) growth.total += Math.max(0, needed - height);
    return cells;
  });
  const rules = table.kind === 'lattice' ? ink?.borderOf(table) : null;
  return {
    type: 'table',
    rows,
    columnWidths: table.columnWidths,
    bordered: table.kind === 'lattice',
    ...(rules ? { border: { color: hexOf(rules.color), widthPt: rules.width } } : {}),
  };
}

/** The boxes of the tables each page draws as grids: its ruled tables but those that box labels in several colours. */
function gridBoxesOf(layouts: readonly PageLayout[], ink: PageInk): Map<number, Box[]> {
  const grids = new Map<number, Box[]>();
  for (const layout of layouts) {
    const boxes = layout.blocks.flatMap((block) => (block.kind === 'table' && !ink.boxesInColours(block.table) ? [block.table.box] : []));
    grids.set(layout.page.pageNumber, boxes);
  }
  return grids;
}

/** Where a run of paragraphs (a list) stood: its first page and the box of the paragraphs of that page. */
function originOfRun(paragraphs: Paragraph[]): BlockOrigin | null {
  if (paragraphs.length === 0) return null;
  const onFirst = paragraphs.filter((paragraph) => paragraph.pageNumber === paragraphs[0].pageNumber);
  return {
    pageNumber: paragraphs[0].pageNumber,
    box: { x0: Math.min(...onFirst.map((p) => p.box.x0)), y0: Math.min(...onFirst.map((p) => p.box.y0)), x1: Math.max(...onFirst.map((p) => p.box.x1)), y1: Math.max(...onFirst.map((p) => p.box.y1)) },
  };
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

/** The page a block stands on. */
function pageOfBlock(block: PageBlock): number {
  if (block.kind === 'paragraph') return block.paragraph.pageNumber;
  if (block.kind === 'table') return block.table.pageNumber;
  return block.pageNumber;
}

/** What a document that keeps its pages needs of the tops of its pages (see `pageTopsOf`). */
interface PageTops {
  /** The top margin of each page that has a body: where its body starts. */
  margins: Map<number, number>;
  /** Where the body of each page starts once its running header is above it: the margin, or the foot of the header when that is lower. */
  starts: Map<number, number>;
}

/** The body of a page starts at its top margin, or below its running header when that is lower; a page may start higher than the others. */
function pageTopsOf(body: PageBlock[], header: Paragraph[], headerPages: ReadonlySet<number>): PageTops {
  const margins = new Map<number, number>();
  for (const block of body) {
    const page = pageOfBlock(block);
    margins.set(page, Math.min(margins.get(page) ?? Infinity, Math.max(0, blockBox(block).y0)));
  }
  const headerFoot = header.length > 0 ? Math.max(...header.map((paragraph) => paragraph.box.y1)) : 0;
  const starts = new Map([...margins].map(([page, top]) => [page, headerPages.has(page) ? Math.max(top, headerFoot) : top]));
  return { margins, starts };
}

/** What a document that keeps its pages sets up before its page blocks become blocks of the model. */
interface PageKeeping {
  flow: PageFlow;
  /** The pages whose columns are no equal columns: their paragraphs are frames at their places on the page. */
  framed: ReadonlySet<number>;
  tops: PageTops;
  margins: DocumentMargins;
}

function pageKeepingOf(blocks: PageBlock[], furniture: PageFurniture, measured: DocumentMargins, pageWidth: number): PageKeeping {
  const tops = pageTopsOf(blocks, furniture.header, furniture.headerPages);
  const margins = pageMarginsOf(measured, tops);
  const columned = blocks.map((block) => ({ pageNumber: pageOfBlock(block), columns: block.columns, boxes: block.kind === 'paragraph' ? block.paragraph.lines.map((line) => line.box) : [blockBox(block)] }));
  return { flow: new PageFlow({ margins, pageWidth, pageTops: tops.starts }), framed: irregularColumnPages(columned), tops, margins };
}

/** The margins of a document that keeps its pages: the page's own at the top, and none at the bottom, so a page whose lines come out a hair taller does not start another page. */
function pageMarginsOf(margins: DocumentMargins, tops: PageTops): DocumentMargins {
  return { ...margins, top: tops.margins.size > 0 ? Math.min(...tops.margins.values()) : margins.top, bottom: 0 };
}

/** Where the running header and footer of the first page that has them stand against the page's edges, for the document that keeps its pages. */
function furnitureDistances(furniture: PageFurniture, pageHeight: number): Pick<DocumentModel, 'headerDistancePt' | 'footerDistancePt'> {
  return {
    ...(furniture.header.length > 0 ? { headerDistancePt: Math.max(0, Math.min(...furniture.header.map((paragraph) => paragraph.box.y0))) } : {}),
    ...(furniture.footer.length > 0 ? { footerDistancePt: Math.max(0, pageHeight - Math.max(...furniture.footer.map((paragraph) => paragraph.box.y1))) } : {}),
  };
}

/** Share of the page height at the top and at the bottom where running headers and footers sit. */
const PAGE_FURNITURE_BAND = 0.08;
/** Pages a running header or footer must recur on in a document of several pages. */
const PAGE_FURNITURE_MIN_PAGES = 2;
/** Tolerance in points when comparing a header's size with the body size. */
const PAGE_FURNITURE_SIZE_TOLERANCE = 0.5;
const PAGE_NUMBER = /\d+/g;

type ParagraphEntry = Extract<PageBlock, { kind: 'paragraph' }>;
type TableEntry = Extract<PageBlock, { kind: 'table' }>;
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

/** The header and footer lines among `blocks` that print the number of their page (`pageCounterBlocks`). */
function pageCountersOf(blocks: Iterable<PageBlock>, candidates: ReadonlyMap<PageBlock, FurnitureBand>): Map<PageBlock, CounterForm> {
  const lines = [...blocks].map((block): FurnitureLine<PageBlock> => {
    const { paragraph } = block as ParagraphEntry;
    return { block, key: `${candidates.get(block)}:${furnitureKey(paragraph.text)}`, text: paragraph.text, pageNumber: paragraph.pageNumber };
  });
  return pageCounterBlocks(lines);
}

/** What `splitPageFurniture` takes out of the flow, and which of those blocks are the page counter of their page, in the form each prints. */
interface PageFurniture {
  body: PageBlock[];
  header: Paragraph[];
  footer: Paragraph[];
  counters: ReadonlyMap<PageBlock, CounterForm>;
  /** The counters that are a bare number in the header band: a bare number at the foot of a page is its page number, one at its head can be text. */
  headerBareCounters: ReadonlySet<PageBlock>;
  /** The pages that have a running header line, and the pages that have a footer line, among the lines taken out. */
  headerPages: ReadonlySet<number>;
  footerPages: ReadonlySet<number>;
}

/**
 * Running headers and footers: one-line paragraphs in the top or bottom band of their page that recur on several
 * pages (page numbers masked) or, in a one-page document, are no larger than the body text. They leave the body flow
 * and become the document's page header and footer.
 */
function splitPageFurniture(blocks: PageBlock[], pages: PdfPageContent[]): PageFurniture {
  const pageHeights = new Map(pages.map((page) => [page.pageNumber, page.height]));
  const candidates = new Map<PageBlock, FurnitureBand>();
  for (const block of blocks) {
    if (block.kind !== 'paragraph') continue;
    const band = furnitureBand(block, pageHeights);
    if (band) candidates.set(block, band);
  }
  if (candidates.size === 0) return { body: blocks, header: [], footer: [], counters: new Map(), headerBareCounters: new Set(), headerPages: new Set(), footerPages: new Set() };
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
      if ((pagesByKey.get(`${band}:${furnitureKey(entry.paragraph.text)}`)?.size ?? 0) >= PAGE_FURNITURE_MIN_PAGES) {
        accepted.add(block);
      }
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
  // A one-page document has no recurrence to show a header or footer by, and a table page has no body text to compare its size with: the line
  // that prints the page's own number in a band is its counter whether or not it is furniture.
  const counters = pageCountersOf(pages.length === 1 ? candidates.keys() : accepted, candidates);
  const headerBareCounters = new Set([...counters].filter(([block, form]) => form === 'bare' && candidates.get(block) === 'header').map(([block]) => block));
  if (accepted.size === 0) return { body: blocks, header: [], footer: [], counters, headerBareCounters, headerPages: new Set(), footerPages: new Set() };
  const firstPageOf = (band: FurnitureBand): Paragraph[] => {
    const lines = [...accepted].filter((block) => candidates.get(block) === band).map((block) => (block as ParagraphEntry).paragraph);
    if (lines.length === 0) return [];
    const firstPage = Math.min(...lines.map((paragraph) => paragraph.pageNumber));
    return lines.filter((paragraph) => paragraph.pageNumber === firstPage).sort((a, b) => a.box.y0 - b.box.y0);
  };
  const pagesOf = (band: FurnitureBand): Set<number> => new Set([...accepted].filter((block) => candidates.get(block) === band).map((block) => (block as ParagraphEntry).paragraph.pageNumber));
  return {
    body: blocks.filter((block) => !accepted.has(block)),
    header: firstPageOf('header'),
    footer: firstPageOf('footer'),
    counters,
    headerBareCounters,
    headerPages: pagesOf('header'),
    footerPages: pagesOf('footer'),
  };
}

/** The lines of text one page holds in reading order, vertical and angled text included. */
export interface PdfPageText {
  pageNumber: number;
  /** Every line of the page, but its page counter (`pageCounterBlocks`). */
  lines: string[];
  /** Whether a page counter left out of `lines` is a bare number in the header band, the form that can be text (section numbers that run 1, 2, 3 on pages 1, 2, 3). */
  hasHeaderBareCounter: boolean;
}

export interface LayoutOptions {
  /**
   * Keep the pages: the paragraphs carry the spacing, indents and alignment of their page, every page starts on a new page, and no
   * paragraph or table is joined across a page (`ParagraphFormat`). The text of the document is the same.
   */
  pages?: boolean;
}

/** What one layout pass over the pages gives: the document, and the tables and lines of text that a spreadsheet takes from it. */
export interface LaidOutPdf {
  model: DocumentModel;
  /**
   * The tables of the document, a table that goes on in the same columns on a following page as one (`joinContinuations`), each on the
   * page it starts on. The running headers and footers are out of the flow, so a table whose next page begins with a header is joined.
   */
  tables: DetectedTable[];
  /** The lines of text of each page, for the text sheets of a workbook. */
  pageText: PdfPageText[];
}

/** What `bodyOf` needs to turn the page blocks into blocks of the model. */
interface BodyContext {
  bodySize: number;
  levels: Map<Paragraph, number>;
  ink: PageInk;
  /** Set when the document keeps the spacing, indents and page starts of its pages. */
  flow?: PageFlow;
  /** The pages whose columns are no equal columns: their paragraphs are frames at their places on the page. */
  framed?: ReadonlySet<number>;
}

/** Paragraphs of the page block `at` and the ones after it that stand on its page, up to the next table or picture. */
function runEndOf(blocks: PageBlock[], at: number, samePage: boolean): number {
  let end = at;
  const page = (block: PageBlock): number | undefined => (block.kind === 'paragraph' ? block.paragraph.pageNumber : undefined);
  while (end < blocks.length && blocks[end].kind === 'paragraph' && (!samePage || page(blocks[end]) === page(blocks[at]))) end++;
  return end;
}

/** The blocks of the model for the page blocks, in order, with the columns, origin and page of each. */
function bodyOf(blocks: PageBlock[], context: BodyContext): BodyBlocks {
  const { bodySize, levels, ink, flow, framed } = context;
  const body: BodyBlocks = { model: [], columnsOf: [], origins: [], pageOf: [] };
  // A framed page has its paragraphs where the page had them, so its flow is one column.
  const columnsAt = (page: number, columns: number): number => (framed?.has(page) ? 1 : columns);
  const formatOf = (paragraph: Paragraph, columns: number, marker = false): ParagraphFormat | undefined =>
    framed?.has(paragraph.pageNumber) && columns > 1 ? flow?.frameFormat(paragraph) : flow?.paragraph(paragraph, columns, marker);
  const push = (block: Block, columns: number, page: number, origin: BlockOrigin | null = null): void => {
    body.model.push(block);
    body.columnsOf.push(columns);
    body.origins.push(origin);
    body.pageOf.push(page);
  };
  let listId = 0;
  let at = 0;
  while (at < blocks.length) {
    const block = blocks[at];
    if (block.kind === 'table') {
      const { table } = block;
      if (ink.boxesInColours(table)) {
        // Rules in several colours box labels (a diagram), they are no grid: the text of the cells is paragraphs and the rules are shapes.
        for (const paragraph of table.rows.flatMap((row) => row.flatMap((cell) => cell.paragraphs))) {
          push(formatted(paragraphBlockOf(paragraph, bodySize, false, ink), formatOf(paragraph, block.columns)), columnsAt(paragraph.pageNumber, block.columns), paragraph.pageNumber, { pageNumber: paragraph.pageNumber, box: paragraph.box });
        }
      } else {
        const growth: RowGrowth = { total: 0 };
        const tableBlock = tableBlockOf(table, bodySize, ink, flow, growth);
        push({ ...tableBlock, ...flow?.table(table, growth.total) }, block.columns, table.pageNumber, { pageNumber: table.pageNumber, box: table.box });
      }
      at++;
      continue;
    }
    if (block.kind === 'image') {
      const position = flow ? { x: block.image.x, y: block.image.y } : undefined;
      push({ type: 'image', imageId: block.imageId, widthPt: block.image.width, heightPt: block.image.height, ...(position ? { position } : {}) }, block.columns, block.pageNumber);
      at++;
      continue;
    }
    // Lists are assembled over the run of consecutive paragraphs starting here.
    const runEnd = runEndOf(blocks, at, flow !== undefined);
    const run = blocks.slice(at, runEnd).map((entry) => entry as Extract<PageBlock, { kind: 'paragraph' }>);
    const runParagraphs = run.map((entry) => entry.paragraph);
    const listRuns = assembleLists(runParagraphs, (paragraph) => !levels.has(paragraph), () => ++listId);
    let cursor = 0;
    const emitParagraph = (index: number): void => {
      const entry = run[index];
      const { paragraph } = entry;
      const origin = { pageNumber: paragraph.pageNumber, box: paragraph.box };
      const level = levels.get(paragraph);
      if (level !== undefined) {
        const headingInk = inkOfParagraph(paragraph, plainWeight(inlineRuns(paragraph.runs), paragraph.lines.every((line) => line.bold)), ink);
        const heading: HeadingBlock = { type: 'heading', level, ...headingInk, rtl: paragraph.rtl };
        push(formatted(heading, formatOf(paragraph, entry.columns)), columnsAt(paragraph.pageNumber, entry.columns), paragraph.pageNumber, origin);
      } else {
        push(formatted(paragraphBlockOf(paragraph, bodySize, false, ink), formatOf(paragraph, entry.columns)), columnsAt(paragraph.pageNumber, entry.columns), paragraph.pageNumber, origin);
      }
    };
    for (const listRun of listRuns) {
      for (; cursor < listRun.from; cursor++) emitParagraph(cursor);
      const list: ListBlock = listRun.list;
      // A list item has no fill of its own, so the light text of one is left in the default colour.
      if (ink.active) for (const item of list.items) item.runs = readableRuns(item.runs, false);
      const columns = run[listRun.from].columns;
      list.items.forEach((item, index) => formatted(item, formatOf(runParagraphs[listRun.from + index], columns, true)));
      push(list, columnsAt(runParagraphs[listRun.from].pageNumber, columns), runParagraphs[listRun.from].pageNumber, originOfRun(runParagraphs.slice(listRun.from, listRun.to)));
      cursor = listRun.to;
    }
    for (; cursor < run.length; cursor++) emitParagraph(cursor);
    at = runEnd;
  }
  return body;
}

/** The sections of a document whose pages run on: a new one wherever the columns change. */
function sectionsOf(body: BodyBlocks): Section[] {
  const sections: Section[] = [];
  body.model.forEach((block, index) => {
    const columns = body.columnsOf[index];
    const last = sections[sections.length - 1];
    if (last && last.columns === columns) last.blocks.push(block);
    else sections.push({ columns, blocks: [block] });
  });
  return sections;
}

function pageTextOf(layout: PageLayout, counters: ReadonlyMap<PageBlock, CounterForm>, headerBareCounters: ReadonlySet<PageBlock>): PdfPageText {
  const { pageNumber } = layout.page;
  const lines: string[] = [];
  let hasHeaderBareCounter = false;
  for (const block of layout.blocks) {
    if (block.kind !== 'paragraph') continue;
    if (counters.has(block)) {
      hasHeaderBareCounter ||= headerBareCounters.has(block);
      continue;
    }
    for (const { text } of block.paragraph.lines) lines.push(text);
  }
  return { pageNumber, lines, hasHeaderBareCounter };
}

/**
 * Lays out the pages once: the document model, and the tables and lines of text of the pages for a spreadsheet.
 * @throws PdfLayoutLimitError when a page needs more than PDF_LAYOUT_MAX_STEPS_PER_PAGE steps.
 */
export function layoutPdf(pages: PdfPageContent[], fonts: PdfContentFont[], options: LayoutOptions = {}): LaidOutPdf {
  const flows = new Counter();
  const imageIds = new Counter();
  const ink = new PageInk(pages);
  const layouts = pages.map((page, index) => layoutPage(page, fonts, flows, index * COLUMN_FLOW_BASE * 1000));
  const documentImages: DocumentImage[] = [];
  // Placements of one picture share its bytes (pdf-text-images.ts), so they share one entry, as DocumentContext.addImage does by content
  // for the other readers: Word, ODF and EPUB then write the picture once however many times the pages paint it.
  const entryOfFile = new Map<Uint8Array, DocumentImage>();
  layouts.forEach((layout) => {
    // Images that came with their file become blocks; a placement without one (not asked for, too large) has nothing to write.
    const decoded = layout.page.images.map((image): DocumentImage | undefined => {
      if (!image.data || !image.format) return undefined;
      const known = entryOfFile.get(image.data);
      if (known) return known;
      const entry: DocumentImage = { id: imageIds.next(), format: image.format, data: image.data, pixelWidth: image.pixelWidth, pixelHeight: image.pixelHeight };
      documentImages.push(entry);
      entryOfFile.set(image.data, entry);
      return entry;
    });
    placeImages(layout, decoded);
  });
  const furniture = splitPageFurniture(joinContinuations(layouts.flatMap((layout) => layout.blocks), options.pages ? 'page' : 'all'), pages);
  const blocks = furniture.body;
  const tables = joinContinuations(blocks, 'tables').flatMap((block) => (block.kind === 'table' ? [block.table] : []));

  const paragraphs = blocks.flatMap((block) => (block.kind === 'paragraph' && !block.full ? [block.paragraph] : []));
  const bodySize = bodySizeOf(paragraphs.length > 0 ? paragraphs : blocks.flatMap((block) => (block.kind === 'paragraph' ? [block.paragraph] : [])));
  const levels = headingLevels(
    blocks.flatMap((block) => (block.kind === 'paragraph' ? [block.paragraph] : [])),
    bodySize
  );

  const keeping = options.pages ? pageKeepingOf(blocks, furniture, marginsOf(layouts), pages[0]?.width ?? 0) : undefined;
  const margins = keeping?.margins ?? marginsOf(layouts);
  const body = bodyOf(blocks, { bodySize, levels, ink, flow: keeping?.flow, framed: keeping?.framed });
  if (ink.active) hangShapes(body, pages, ink, gridBoxesOf(layouts, ink));
  if (keeping) absorbFigureSpacers(body.model);
  const sections = keeping ? pageSections(body.model, body.columnsOf, body.pageOf, pages.map((page) => page.pageNumber), furniture, keeping.tops.margins) : sectionsOf(body);
  const first = pages[0];
  const documentModel: DocumentModel = {
    sections,
    images: documentImages,
    pageWidthPt: first?.width ?? 0,
    pageHeightPt: first?.height ?? 0,
    margins,
    bodySize,
    bodyFont: dominantFont(paragraphs, fonts),
    headingSizes: headingSizesOf(levels),
    pageCount: pages.length,
    ...(options.pages ? { pageFlow: true as const, ...furnitureDistances(furniture, first?.height ?? 0) } : {}),
    ...(furniture.header.length > 0 ? { pageHeader: furniture.header.map((paragraph) => readableRuns(inlineRuns(paragraph.runs), false)) } : {}),
    ...(furniture.footer.length > 0 ? { pageFooter: furniture.footer.map((paragraph) => readableRuns(inlineRuns(paragraph.runs), false)) } : {}),
  };
  return { model: documentModel, tables, pageText: layouts.map((layout) => pageTextOf(layout, furniture.counters, furniture.headerBareCounters)) };
}

export type { DocumentModel, LayoutLine };
