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
 * DOCX is laid out by LibreOffice and read back by Poppler (`pdfinfo`, `pdftotext -bbox`); nothing of the writer is used to judge it.
 */

const SCHEDULE = 'govdocs1-001135.pdf';
const SOFFICE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 300_000;
/** Points a row of data may stand from where the PDF has it: LibreOffice and Poppler round the rows of a page differently. */
const MAX_ROW_OFFSET = 4;

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

function pageCount(file: string): number {
  return Number(/^Pages:\s+(\d+)/m.exec(execFileSync(requireOracleTool('pdfinfo'), [file], { encoding: 'utf8' }))?.[1]);
}

/** The words of one page with the top left of their boxes, as Poppler reads them. */
function wordsOfPage(file: string, page: number): Word[] {
  const boxes = execFileSync(requireOracleTool('pdftotext'), ['-bbox', '-f', String(page), '-l', String(page), file, '-'], { encoding: 'utf8' });
  return [...boxes.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>([^<]*)<\/word>/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]), text: match[3] }));
}

function renderedBy(dir: string): string {
  execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pdf', '--outdir', path.join(dir, 'render'), path.join(dir, 'out.docx')], {
    timeout: SOFFICE_TIMEOUT_MS,
    stdio: 'ignore',
  });
  return path.join(dir, 'render', 'out.pdf');
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

describe('the rows of a ruled table keep the height the page gave them', () => {
  oracleTest(
    `${SCHEDULE}: the empty cells of the blank rows hold no height, so the rows of data stand where the PDF has them`,
    ['pdfinfo', 'pdftotext', 'soffice'],
    async (ctx) => {
      const { source, docx } = await convertedSample(ctx, SCHEDULE);
      const xml = (await (await JSZip.loadAsync(docx)).file('word/document.xml')?.async('string')) ?? '';
      // Structure: a paragraph of an empty cell at the default size is taller than the 11.5 point rows.
      expect(xml).not.toContain('</w:tcPr><w:p/></w:tc>');
      withFiles({ 'in.pdf': source, 'out.docx': docx }, (dir) => {
        const rendered = renderedBy(dir);
        const first = wordsOfPage(path.join(dir, 'in.pdf'), 1);
        const got = wordsOfPage(rendered, 1);
        // The names that end the first page of the PDF are on the first page of the DOCX, and the rows above them are where the PDF puts them.
        for (const name of ['Penobscot', 'Houlton', 'Maliseet', 'Aroostook']) expect(got.map((word) => word.text)).toContain(name);
        for (const name of ['Alabama', 'Mowa', 'Schaghticoke', 'Seminole,']) {
          const wanted = first.find((word) => word.text === name);
          const found = got.find((word) => word.text === name);
          expect(found, name).toBeDefined();
          expect(Math.abs((found as Word).y - (wanted as Word).y)).toBeLessThanOrEqual(MAX_ROW_OFFSET);
        }
        expect(pageCount(rendered)).toBeLessThanOrEqual(pageCount(path.join(dir, 'in.pdf')) + 1);
      });
    },
    TEST_TIMEOUT_MS
  );
});

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

describe('a table written without a page of its own', () => {
  it('keeps the paragraph of an empty cell as it was', async () => {
    const { buffer } = await convertFile(Buffer.from('<table><tr><td>a</td><td></td></tr></table>'), 'html', 'docx', {}, 'plain.html');
    const xml = (await (await JSZip.loadAsync(buffer)).file('word/document.xml')?.async('string')) ?? '';
    const cells = [...xml.matchAll(/<w:tc><w:tcPr>.*?<\/w:tcPr>(.*?)<\/w:tc>/gs)].map((match) => match[1]);
    expect(cells[1]).toBe('<w:p/>');
  });
});
