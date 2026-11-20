import { describe, expect, it } from 'vitest';
import { readPdfDocument } from '../src/lib/conversions/pdf-text-document';
import { layoutPdfPages } from '../src/lib/conversions/pdf-layout/index';
import { TableFinder, type T_obj } from '../src/lib/conversions/pdfplumber-table';
import type { PdfContentRule } from '../src/lib/conversions/pdf-text-types';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * The ruled tables the layout pass finds, against the table finder of pdfplumber (translated in src/lib/conversions/pdfplumber-table.ts,
 * which tests/pdfplumber-table.test.ts holds equal to pdfplumber 0.11.10) fed the same rules. The pages are real pages of the real-world
 * corpus on which the two find tables of one size: the layout pass's rows and columns are pdfplumber's. (Where they differ, the layout pass
 * merges cells that no line separates and pdfplumber does not, and pdfplumber reads a table of ruled rows and unruled columns as one column.)
 */

const RULE_THICKNESS_LIMIT = 1.5;

function edgeOf(rule: PdfContentRule): T_obj {
  if (rule.y1 - rule.y0 <= RULE_THICKNESS_LIMIT) {
    const top = (rule.y0 + rule.y1) / 2;
    return { x0: rule.x0, x1: rule.x1, top, bottom: top, width: rule.x1 - rule.x0, orientation: 'h', object_type: 'line' };
  }
  const x = (rule.x0 + rule.x1) / 2;
  return { x0: x, x1: x, top: rule.y0, bottom: rule.y1, height: rule.y1 - rule.y0, orientation: 'v', object_type: 'line' };
}

const PAGES: [string, number, string][] = [
  ['govdocs1-001135.pdf', 2, '41x12'],
  ['govdocs1-000012.pdf', 1, '17x5'],
  ['govdocs1-000176.pdf', 1, '17x5'],
  ['govdocs1-001073.pdf', 1, '38x14'],
];

describe('the ruled tables of a page have the rows and columns pdfplumber finds', () => {
  for (const [id, pageNumber, size] of PAGES) {
    it(`${id} page ${pageNumber}: one table of ${size}`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const { extracted } = await readPdfDocument(bytes, { images: true, colour: true, pages: true });
      const page = extracted.pages[pageNumber - 1];
      const ours = layoutPdfPages(extracted.pages, extracted.fonts)[pageNumber - 1].blocks.flatMap((block) => (block.kind === 'table' && block.table.kind === 'lattice' ? [`${block.table.rows.length}x${block.table.columnWidths.length}`] : []));
      const finder = new TableFinder({ bbox: [0, 0, page.width, page.height], edges: page.rules.map(edgeOf) }, {});
      const theirs = finder.tables.map((table) => `${table.rows.length}x${table.columns.length}`);
      expect(ours).toEqual([size]);
      expect(theirs).toEqual([size]);
    });
  }
});
