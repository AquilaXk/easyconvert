import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { PDF_TABLE_MAX_CELLS, renderPdfTables } from '../src/lib/conversions/pdf-table-layout';
import { PayloadLimitError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { buildPptBinary } from './helpers/ppt-binary-builder';
import { requireOracleTool } from './helpers/differential-oracle';

const DECORATION_PATTERN = /Structured Data Export|Sheet:|No records found|Epub content|EasyConvert/i;
const FIXTURE_XLSX = path.resolve(__dirname, 'fixtures', 'golden', 'office', 'multi-sheet-enterprise.xlsx');
const ROWS = 300;
const COLUMNS = 12;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const LARGE_ROWS = 10_000;
const LARGE_COLUMNS = 50;
const LARGE_TIMEOUT_MS = 900_000;
const LONG_CELL_WORDS = 70;

/** Token of cell (row, column): unique across the table so that a set or count comparison is exact. */
function token(row: number, column: number): string {
  return `r${row}c${column}`;
}

function csvOf(rows: number, columns: number): { csv: string; headers: string[]; bodyTokens: string[] } {
  const headers = Array.from({ length: columns }, (_, c) => `col${c}`);
  const lines = [headers.join(',')];
  const bodyTokens: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells = Array.from({ length: columns }, (_, c) => token(r, c));
    bodyTokens.push(...cells);
    lines.push(cells.join(','));
  }
  return { csv: lines.join('\n') + '\n', headers, bodyTokens };
}

/** Text of the PDF in content-stream order (`pdftotext -raw`), split into whitespace tokens. */
function pdfTokens(pdf: Buffer): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-tokens-'));
  try {
    fs.writeFileSync(path.join(dir, 'doc.pdf'), pdf);
    const text = execFileSync(requireOracleTool('pdftotext'), ['-raw', '-enc', 'UTF-8', path.join(dir, 'doc.pdf'), '-'], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 1024,
    });
    return text.split(/\s+/).filter((t) => t.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pdfInfo(pdf: Buffer): { title: string; pages: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-info-'));
  try {
    fs.writeFileSync(path.join(dir, 'doc.pdf'), pdf);
    const info = execFileSync(requireOracleTool('pdfinfo'), [path.join(dir, 'doc.pdf')], { encoding: 'utf-8' });
    return { title: /^Title:\s*(.*)$/m.exec(info)?.[1] ?? '', pages: Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function outlineTitles(pdf: Buffer): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-outline-'));
  try {
    fs.writeFileSync(path.join(dir, 'doc.pdf'), pdf);
    const json = execFileSync(requireOracleTool('qpdf'), ['--json', path.join(dir, 'doc.pdf')], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
    const outlines = (JSON.parse(json) as { outlines?: { title: string }[] }).outlines ?? [];
    return outlines.map((entry) => entry.title);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function countOf(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

describe('data to PDF draws only the cells', () => {
  oracleTest('a 300-row, 12-column CSV shows every cell once and nothing else', ['pdftotext', 'pdfinfo'], async () => {
    const { csv, headers, bodyTokens } = csvOf(ROWS, COLUMNS);
    const result = await convertFile(Buffer.from(csv, 'utf-8'), 'csv', 'pdf', {}, 'records.csv');
    const tokens = pdfTokens(result.buffer);
    const counts = countOf(tokens);
    // Every body cell is drawn exactly once; the header row repeats on each page.
    expect(bodyTokens.filter((t) => counts.get(t) !== 1)).toEqual([]);
    expect(new Set(tokens)).toEqual(new Set([...headers, ...bodyTokens]));
    expect(headers.filter((h) => (counts.get(h) ?? 0) < pdfInfo(result.buffer).pages)).toEqual([]);
    expect(tokens.join(' ')).not.toMatch(DECORATION_PATTERN);
    expect(pdfInfo(result.buffer).title).toBe('records');
  }, 300_000);

  oracleTest('a 500-character cell is wrapped, not cut', ['pdftotext'], async () => {
    const words = Array.from({ length: LONG_CELL_WORDS }, (_, i) => `word${i}`);
    const longCell = words.join(' ');
    expect(longCell.length).toBeGreaterThan(450);
    const csv = `id,note\nrow1,${longCell}\nrow2,short\n`;
    const result = await convertFile(Buffer.from(csv, 'utf-8'), 'csv', 'pdf', {}, 'notes.csv');
    const tokens = pdfTokens(result.buffer);
    const start = tokens.indexOf('word0');
    expect(tokens.slice(start, start + LONG_CELL_WORDS)).toEqual(words);
    expect(tokens).toContain('short');
  }, 120_000);

  oracleTest('a 10,000-row, 50-column CSV draws all 500,000 cells', ['pdftotext'], async () => {
    const { csv, bodyTokens } = csvOf(LARGE_ROWS, LARGE_COLUMNS);
    const result = await convertFile(Buffer.from(csv, 'utf-8'), 'csv', 'pdf', {}, 'large.csv');
    const tokens = pdfTokens(result.buffer);
    const bodyOnly = new Set(bodyTokens);
    expect(tokens.filter((t) => bodyOnly.has(t))).toHaveLength(LARGE_ROWS * LARGE_COLUMNS);
    expect(new Set(tokens.filter((t) => bodyOnly.has(t))).size).toBe(LARGE_ROWS * LARGE_COLUMNS);
  }, LARGE_TIMEOUT_MS);

  it('refuses a table above the cell limit with a typed 413 error before drawing anything', async () => {
    const rows = [Array.from({ length: PDF_TABLE_MAX_CELLS + 1 }, () => ({ text: 'x' }))];
    const run = renderPdfTables([{ rows, headerRows: 1 }], { orientation: 'landscape' });
    await expect(run).rejects.toBeInstanceOf(PayloadLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE });
  });

  it('refuses an empty dataset instead of drawing a placeholder sentence', async () => {
    const run = convertFile(Buffer.from('[]', 'utf-8'), 'json', 'pdf', {}, 'empty.json');
    await expect(run).rejects.toThrow(/no rows|no records|empty/i);
  });
});

describe('spreadsheet to PDF draws only the cells', () => {
  oracleTest('a workbook shows its cells without a title, sheet label or accent, and lists the sheets in the outline', ['pdftotext', 'qpdf', 'pdfinfo'], async () => {
    const xlsx = fs.readFileSync(FIXTURE_XLSX);
    const zip = await JSZip.loadAsync(xlsx);
    const workbook = await zip.file('xl/workbook.xml')!.async('text');
    const sheetNames = [...workbook.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1]);
    expect(sheetNames.length).toBeGreaterThan(1);

    const result = await convertFile(xlsx, 'xlsx', 'pdf', {}, 'workbook.xlsx');
    const text = pdfTokens(result.buffer).join(' ');
    expect(text).not.toMatch(DECORATION_PATTERN);
    for (const name of sheetNames) expect(text).not.toContain(`Sheet: ${name}`);
    expect(outlineTitles(result.buffer)).toEqual(sheetNames);
    expect(pdfInfo(result.buffer).title).toBe('workbook');
  }, 120_000);

  oracleTest('every text cell of every sheet is drawn, as listed in the shared strings of the package', ['pdftotext'], async () => {
    const xlsx = fs.readFileSync(FIXTURE_XLSX);
    const zip = await JSZip.loadAsync(xlsx);
    const sharedStrings = await zip.file('xl/sharedStrings.xml')!.async('text');
    const expected = [...sharedStrings.matchAll(/<t[^>]*>([^<]*)<\/t>/g)]
      .flatMap((match) => match[1].split(/\s+/))
      .filter((word) => word.length > 0);
    expect(expected.length).toBeGreaterThan(10);
    const result = await convertFile(xlsx, 'xlsx', 'pdf', {}, 'workbook.xlsx');
    const drawn = new Set(pdfTokens(result.buffer));
    expect(expected.filter((word) => !drawn.has(word))).toEqual([]);
  }, 120_000);
});

const PARAGRAPHS = ['Alpha paragraph unique1 token', 'Bravo paragraph unique2 token', '한국어 문단 unique3'];

async function docxOf(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('office document writers draw only the document', () => {
  oracleTest('DOCX to PDF shows its paragraphs and no file-name title or accent', ['pdftotext', 'pdfinfo'], async () => {
    const result = await convertFile(await docxOf(PARAGRAPHS), 'docx', 'pdf', {}, 'quarterly-report-final.docx');
    const tokens = pdfTokens(result.buffer);
    expect(new Set(tokens)).toEqual(new Set(PARAGRAPHS.flatMap((p) => p.split(' '))));
    expect(pdfInfo(result.buffer).title).toBe('quarterly-report-final');
  });

  oracleTest('a text-only PPT slide deck shows its text without a "Slide N" label, bullet or accent', ['pdftotext', 'pdfinfo'], async () => {
    const ppt = buildPptBinary({
      slides: [
        { shapes: [{ chars: 'Deck title' }, { chars: 'First point' }] },
        { shapes: [{ chars: 'Second slide point' }] },
      ],
    });
    const result = await convertFile(ppt, 'ppt', 'pdf', {}, 'board-deck.ppt');
    const tokens = pdfTokens(result.buffer);
    expect(tokens).toEqual(['Deck', 'title', 'First', 'point', 'Second', 'slide', 'point']);
    expect(pdfInfo(result.buffer).title).toBe('board-deck');
    expect(pdfInfo(result.buffer).pages).toBe(2);
  });

  it('refuses an EPUB without text instead of drawing a placeholder', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('OEBPS/empty.xhtml', '<html><body></body></html>');
    const run = convertFile(await zip.generateAsync({ type: 'nodebuffer' }), 'epub', 'pdf', {}, 'empty.epub');
    await expect(run).rejects.toThrow('The EPUB holds no text to draw in a PDF.');
  });

  it('refuses an FB2 book without text instead of drawing a placeholder', async () => {
    const fb2 = '<?xml version="1.0"?><FictionBook><description><title-info><book-title>T</book-title></title-info></description><body></body></FictionBook>';
    const run = convertFile(Buffer.from(fb2, 'utf-8'), 'fb2', 'pdf', {}, 'empty.fb2');
    await expect(run).rejects.toThrow('The FB2 book holds no text to draw in a PDF.');
  });
});

describe('the writers no longer carry fixed truncations or decorations', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', 'src', 'lib', 'conversions', rel), 'utf-8');

  it.each([
    ['data.ts', /slice\(0, 10\)|slice\(0, 200\)|Structured Data Export|ellipsis: true/],
    ['office.ts', /Epub content|FB2 text content|ellipsis: true|Sheet: \$\{sheet\.name\}`, hasUnicodeFont/],
  ])('%s has none of the removed literals', (file, pattern) => {
    expect(read(file as string)).not.toMatch(pattern as RegExp);
  });
});
