import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions/index';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * Ruled tables of real PDFs written to DOCX. The file is a real government document of the real-world corpus (bench/realworld/manifest.json):
 * a ten-page schedule of landscape pages, each a ruled grid of 41 rows and 12 columns with a blank row between the rows of data. The
 * words of the PDF are read by Poppler (`pdftotext -bbox`); nothing of the writer is used to judge the cells.
 */

const SCHEDULE = 'govdocs1-001135.pdf';

interface Word {
  text: string;
  x: number;
  y: number;
}

function withFiles<T>(files: Record<string, Buffer>, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-docx-tables-'));
  try {
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The words of one page with the top left of their boxes, as Poppler reads them. */
function wordsOfPage(file: string, page: number): Word[] {
  const boxes = execFileSync(requireOracleTool('pdftotext'), ['-bbox', '-f', String(page), '-l', String(page), file, '-'], { encoding: 'utf8' });
  return [...boxes.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>([^<]*)<\/word>/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]), text: match[3] }));
}

const converted = new Map<string, Promise<{ source: Buffer; docx: Buffer }>>();

function convertedSample(ctx: { skip: () => never }, id: string): Promise<{ source: Buffer; docx: Buffer }> {
  let result = converted.get(id);
  if (!result) {
    result = requireRealworldSample(ctx, id).then(async ({ bytes }) => ({ source: bytes, docx: (await convertFile(bytes, 'pdf', 'docx', {}, id)).buffer }));
    converted.set(id, result);
  }
  return result;
}

/** The text of each cell of each row of the first table of the page XML. */
function firstTableCells(xml: string): string[][] {
  const table = /<w:tbl>.*?<\/w:tbl>/s.exec(xml)?.[0] ?? '';
  return (table.match(/<w:tr>.*?<\/w:tr>/gs) ?? []).map((row) =>
    (row.match(/<w:tc>.*?<\/w:tc>/gs) ?? []).map((cell) => [...cell.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join(' ').replace(/&amp;/g, '&'))
  );
}

describe('the text of a ruled table goes to the cell the PDF has it in', () => {
  oracleTest(
    `${SCHEDULE}: the headings drawn one to a column are one to a cell, and a name cut off by its neighbour stays in its cell`,
    ['pdftotext'],
    async (ctx) => {
      const { source, docx } = await convertedSample(ctx, SCHEDULE);
      const xml = (await (await JSZip.loadAsync(docx)).file('word/document.xml')?.async('string')) ?? '';
      const rows = firstTableCells(xml);
      const words = withFiles({ 'in.pdf': source }, (dir) => wordsOfPage(path.join(dir, 'in.pdf'), 1));
      // Poppler reads the headings of the first row as the pairs "1 Bedroom", ... in the order of the columns.
      const headingY = (words.find((word) => word.text === 'Bedroom') as Word).y;
      const headings = words.filter((word) => Math.abs(word.y - headingY) < 2).sort((a, b) => a.x - b.x);
      const expected: string[] = [];
      for (let i = 0; i + 1 < headings.length; i += 2) expected.push(`${headings[i].text} ${headings[i + 1].text}`);
      expect(expected).toHaveLength(10);
      expect(rows[0].filter((cell) => cell !== '')).toEqual(expected);
      const named = rows.find((row) => row[0].startsWith('Aroostook')) as string[];
      expect(named[0]).not.toContain('Maine');
      expect(named[1]).toBe('Maine');
    }
  );
});
