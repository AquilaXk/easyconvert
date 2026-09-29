import { describe, it, expect } from 'vitest';
import {
  sortTableBlocksReadingOrder,
  sortLineBlocksTopological,
  OcrLineBlock,
} from '../src/lib/conversions/ocr-pdf-combiner';

describe('OCR Table Reading Order & Cell Integrity', () => {
  describe('1. Explicit Table Cell Structure (tableCell: { rowIndex, colIndex })', () => {
    it('preserves multi-line cell text contiguity and orders cells row-by-row', () => {
      // 2x2 Table:
      // Row 0:
      //   Cell (0, 0): 2 lines: "Item Alpha Description", "Part Number: 1042"
      //   Cell (0, 1): 1 line:  "$150.00"
      // Row 1:
      //   Cell (1, 0): 2 lines: "Item Beta Description", "Part Number: 2084"
      //   Cell (1, 1): 1 line:  "$275.50"
      const blocks: OcrLineBlock[] = [
        // Intentionally scrambled / interleaved by Y coordinate
        {
          text: 'Item Alpha Description',
          bbox: { x: 50, y: 100, width: 200, height: 12, tableCell: { rowIndex: 0, colIndex: 0 } },
          words: [],
          tableId: 't1',
        },
        {
          text: '$150.00',
          bbox: { x: 300, y: 100, width: 60, height: 12, tableCell: { rowIndex: 0, colIndex: 1 } },
          words: [],
          tableId: 't1',
        },
        {
          text: 'Part Number: 1042',
          bbox: { x: 50, y: 118, width: 140, height: 12, tableCell: { rowIndex: 0, colIndex: 0 } },
          words: [],
          tableId: 't1',
        },
        {
          text: 'Item Beta Description',
          bbox: { x: 50, y: 150, width: 190, height: 12, tableCell: { rowIndex: 1, colIndex: 0 } },
          words: [],
          tableId: 't1',
        },
        {
          text: '$275.50',
          bbox: { x: 300, y: 150, width: 60, height: 12, tableCell: { rowIndex: 1, colIndex: 1 } },
          words: [],
          tableId: 't1',
        },
        {
          text: 'Part Number: 2084',
          bbox: { x: 50, y: 168, width: 140, height: 12, tableCell: { rowIndex: 1, colIndex: 0 } },
          words: [],
          tableId: 't1',
        },
      ];

      const sorted = sortTableBlocksReadingOrder(blocks);
      const texts = sorted.map((b) => b.text);

      expect(texts).toEqual([
        // Row 0 Col 0 (both lines together)
        'Item Alpha Description',
        'Part Number: 1042',
        // Row 0 Col 1
        '$150.00',
        // Row 1 Col 0 (both lines together)
        'Item Beta Description',
        'Part Number: 2084',
        // Row 1 Col 1
        '$275.50',
      ]);
    });
  });

  describe('2. Embedded Table in Document Stream', () => {
    it('places introductory paragraph -> table (row-by-row) -> concluding paragraph in topological sort', () => {
      const docBlocks: OcrLineBlock[] = [
        {
          text: '1. Introduction and Financial Summary',
          bbox: { x: 50, y: 30, width: 350, height: 16 },
          words: [],
        },
        {
          text: 'The quarterly financial performance is summarized below:',
          bbox: { x: 50, y: 55, width: 420, height: 14 },
          words: [],
        },
        // Table blocks (Y in [100, 160])
        {
          text: 'Revenue Q1',
          bbox: { x: 50, y: 100, width: 100, height: 12, tableCell: { rowIndex: 0, colIndex: 0 } },
          words: [],
          tableId: 'table-summary',
        },
        {
          text: '$1,000,000',
          bbox: { x: 250, y: 100, width: 80, height: 12, tableCell: { rowIndex: 0, colIndex: 1 } },
          words: [],
          tableId: 'table-summary',
        },
        {
          text: 'Net Profit Q1',
          bbox: { x: 50, y: 130, width: 100, height: 12, tableCell: { rowIndex: 1, colIndex: 0 } },
          words: [],
          tableId: 'table-summary',
        },
        {
          text: '$250,000',
          bbox: { x: 250, y: 130, width: 70, height: 12, tableCell: { rowIndex: 1, colIndex: 1 } },
          words: [],
          tableId: 'table-summary',
        },
        // Post-table paragraph
        {
          text: '2. Analysis and Future Outlook',
          bbox: { x: 50, y: 220, width: 300, height: 16 },
          words: [],
        },
        {
          text: 'Operating profit exceeded guidance for the current reporting period.',
          bbox: { x: 50, y: 245, width: 480, height: 14 },
          words: [],
        },
      ];

      const sorted = sortLineBlocksTopological(docBlocks);
      const texts = sorted.map((b) => b.text);

      expect(texts).toEqual([
        '1. Introduction and Financial Summary',
        'The quarterly financial performance is summarized below:',
        'Revenue Q1',
        '$1,000,000',
        'Net Profit Q1',
        '$250,000',
        '2. Analysis and Future Outlook',
        'Operating profit exceeded guidance for the current reporting period.',
      ]);
    });

    it('infers table grid columns and rows geometrically when explicit tableCell is omitted', () => {
      // 2x2 grid without tableCell annotations
      const gridBlocks: OcrLineBlock[] = [
        { text: 'Header Left', bbox: { x: 50, y: 100, width: 80, height: 12 }, words: [] },
        { text: 'Header Right', bbox: { x: 200, y: 100, width: 80, height: 12 }, words: [] },
        { text: 'Value Left', bbox: { x: 50, y: 140, width: 70, height: 12 }, words: [] },
        { text: 'Value Right', bbox: { x: 200, y: 140, width: 75, height: 12 }, words: [] },
      ];

      const sorted = sortTableBlocksReadingOrder(gridBlocks);
      const texts = sorted.map((b) => b.text);

      expect(texts).toEqual([
        'Header Left',
        'Header Right',
        'Value Left',
        'Value Right',
      ]);
    });
  });
});
