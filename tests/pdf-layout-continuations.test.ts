import { describe, expect, it } from 'vitest';
import { joinContinuations, type PageBlock } from '../src/lib/conversions/pdf-layout';
import { continuesInNextFlow } from '../src/lib/conversions/pdf-layout/paragraphs';
import type { DetectedTable, TableCell } from '../src/lib/conversions/pdf-layout/types';
import { generateProseLine, openParagraph, paragraphOf, seeded } from './pdf-layout-reference';

/**
 * Tables that continue on the following page and paragraphs that continue into the next flow are gathered into one block when
 * the run ends. The blocks must be the ones that merging at every step makes, the way `joinContinuations` did before #930: a
 * table by copying the rows of both, a paragraph by joining the lines of both again.
 */

const SEED = 0x7ab1e5;
const CASES = 500;
const TABLE_WIDTH_TOLERANCE = 4;

type ParagraphEntry = Extract<PageBlock, { kind: 'paragraph' }>;
type TableEntry = Extract<PageBlock, { kind: 'table' }>;

function continuesTable(last: DetectedTable, next: DetectedTable): boolean {
  if (next.pageNumber <= last.pageNumber || last.kind !== next.kind) return false;
  if (last.columnWidths.length !== next.columnWidths.length) return false;
  return last.columnWidths.every((width, index) => Math.abs(width - next.columnWidths[index]) <= TABLE_WIDTH_TOLERANCE);
}

function rowText(row: DetectedTable['rows'][number]): string {
  return row.map((cell) => cell.paragraphs.map((paragraph) => paragraph.text).join(' ')).join('|');
}

function joinTables(last: DetectedTable, next: DetectedTable): DetectedTable {
  const repeated = next.rows.length > 0 && last.rows.length > 0 && rowText(next.rows[0]) === rowText(last.rows[0]);
  return { ...last, rows: [...last.rows, ...(repeated ? next.rows.slice(1) : next.rows)], box: { ...last.box, y1: Math.max(last.box.y1, next.box.y1) } };
}

/** `joinContinuations` as it was before #930. */
function joinAtEveryStep(blocks: PageBlock[], join: 'all' | 'tables'): PageBlock[] {
  const flowRight = new Map<number, number>();
  for (const block of blocks) {
    if (join === 'all' && block.kind === 'paragraph') {
      flowRight.set(block.paragraph.flow, Math.max(flowRight.get(block.paragraph.flow) ?? 0, block.paragraph.box.x1));
    }
  }
  const joined: PageBlock[] = [];
  for (const block of blocks) {
    const last = joined[joined.length - 1];
    if (block.kind === 'table' && last?.kind === 'table' && continuesTable(last.table, block.table)) {
      joined[joined.length - 1] = { ...last, table: joinTables(last.table, block.table) };
      continue;
    }
    if (
      join === 'all' &&
      block.kind === 'paragraph' &&
      last?.kind === 'paragraph' &&
      last.paragraph.flow !== block.paragraph.flow &&
      continuesInNextFlow(openParagraph(last.paragraph), block.paragraph, flowRight.get(last.paragraph.flow) ?? last.paragraph.box.x1)
    ) {
      const { paragraph } = last;
      joined[joined.length - 1] = { ...last, paragraph: paragraphOf([...paragraph.lines, ...block.paragraph.lines], paragraph.flow, paragraph.pageNumber, paragraph.full) };
    } else {
      joined.push(block);
    }
  }
  return joined;
}

function generateBlocks(random: () => number): PageBlock[] {
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const count = 2 + Math.floor(random() * 16);
  const blocks: PageBlock[] = [];
  let flow = 0;
  let page = 0;
  let line = 0;
  let previousTable: DetectedTable | undefined;
  for (let i = 0; i < count; i++) {
    const meta = { columns: 1, band: -1 };
    const kind = random();
    if (kind < 0.7) {
      flow += random() < 0.8 ? 1 : 0;
      page += random() < 0.7 ? 1 : 0;
      const lines = Array.from({ length: 1 + Math.floor(random() * 4) }, () => generateProseLine(random, line++));
      const full = random() < 0.08;
      blocks.push({ kind: 'paragraph', paragraph: paragraphOf(lines, flow, page, full), full, ...meta });
    } else if (kind < 0.93) {
      page += random() < 0.9 ? 1 : 0;
      const table = generateTable(random, page, previousTable);
      previousTable = table;
      blocks.push({ kind: 'table', table, ...meta });
    } else {
      blocks.push({ kind: 'image', image: { x: 0, y: 0, width: pick([10, 20]), height: 10, pixelWidth: 1, pixelHeight: 1 }, imageId: i, ...meta });
    }
  }
  return blocks;
}

function generateTable(random: () => number, pageNumber: number, previous: DetectedTable | undefined): DetectedTable {
  const cell = (text: string): TableCell => ({ paragraphs: [{ ...paragraphOf([generateProseLine(random, 0)], 0, pageNumber, false), text }], colSpan: 1, rowSpan: 1, continuation: false, header: false });
  const rowCount = Math.floor(random() * 5);
  const rows = Array.from({ length: rowCount }, (_, index) => [cell(`r${pageNumber}.${index}`), cell(`c${index}`)]);
  if (previous && previous.rows.length > 0 && random() < 0.4) rows.unshift(previous.rows[0]);
  const widths = random() < 0.85 ? [100, 100] : random() < 0.5 ? [100, 103] : [100, 120];
  return {
    rows,
    columnWidths: widths,
    box: { x0: 0, y0: 0, x1: 200, y1: Math.floor(random() * 700) },
    pageNumber,
    kind: random() < 0.95 ? 'lattice' : 'stream',
  };
}

describe(`joinContinuations over ${CASES} generated block lists (seed ${SEED.toString(16)})`, () => {
  const random = seeded(SEED);
  const lists = Array.from({ length: CASES }, () => generateBlocks(random));

  for (const join of ['all', 'tables'] as const) {
    it(`gives the blocks that merging at every step gives, for ${join}`, () => {
      let merged = 0;
      for (const [caseIndex, blocks] of lists.entries()) {
        const input = structuredClone(blocks);
        const joined = joinContinuations(blocks, join);
        expect(joined, `case ${caseIndex}`).toEqual(joinAtEveryStep(input, join));
        expect(blocks, `case ${caseIndex} left its input as it was`).toEqual(input);
        merged += blocks.length - joined.length;
      }
      expect(merged).toBeGreaterThan(CASES / 4);
    });
  }

  it('covers runs of several tables and of several paragraphs, a repeated header, and a table without rows that goes on', () => {
    const joinedLists = lists.map((blocks) => ({ blocks, joined: joinContinuations(blocks, 'all') }));
    const growth = (kind: 'paragraph' | 'table'): number =>
      Math.max(...joinedLists.map(({ blocks, joined }) => blocks.filter((block) => block.kind === kind).length - joined.filter((block) => block.kind === kind).length));
    expect(growth('table')).toBeGreaterThanOrEqual(3);
    expect(growth('paragraph')).toBeGreaterThanOrEqual(3);
    const tablesOf = (blocks: PageBlock[]): DetectedTable[] => blocks.flatMap((block) => (block.kind === 'table' ? [(block as TableEntry).table] : []));
    expect(lists.some((blocks) => tablesOf(blocks).some((table, index, all) => index > 0 && table.rows.length > 0 && all[index - 1].rows[0] === table.rows[0]))).toBe(true);
    expect(lists.some((blocks) => tablesOf(blocks).some((table) => table.rows.length === 0))).toBe(true);
    expect(joinedLists.some(({ joined }) => joined.some((block) => block.kind === 'paragraph' && (block as ParagraphEntry).paragraph.lines.length > 8))).toBe(true);
  });
});
