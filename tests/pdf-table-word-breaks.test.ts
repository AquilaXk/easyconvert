import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPdfTables, type PdfTableCell } from '../src/lib/conversions/pdf-table-layout';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * The table writer fits columns to a page without cutting a word: a table wider than a page continues in further column groups
 * and a column is never squeezed below its longest word (up to the widest a column grows). The expected words are the cell texts.
 */

const WORD = /[\p{L}\p{N}]+/gu;
const cell = (text: string): PdfTableCell => ({ text });

function pdfWords(pdf: Buffer): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-words-'));
  try {
    fs.writeFileSync(path.join(dir, 'out.pdf'), pdf);
    const text = execFileSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', path.join(dir, 'out.pdf'), '-'], { encoding: 'utf-8' });
    return (text.match(WORD) ?? []).sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('table writer', () => {
  const PARTS = ['063W', 'MAX6626PMUT', '08055A101JAT2A', 'Characterisation', 'Kyocera', 'MC7805ACD2T'];

  oracleTest('keeps every word whole in a table of twenty columns', ['pdftotext'], async () => {
    const rows = Array.from({ length: 5 }, (_, r) => Array.from({ length: 20 }, (_, c) => cell(`${PARTS[(r + c) % PARTS.length]}${c}`)));
    const pdf = await renderPdfTables([{ name: 'Parts', rows, headerRows: 1 }], { orientation: 'portrait' });
    expect(pdfWords(pdf)).toEqual(rows.flatMap((row) => row.map((c) => c.text)).sort());
  });

  oracleTest('keeps the words of a cell with several words whole, wrapping between them', ['pdftotext'], async () => {
    const sentence = 'Interdisciplinary reassessment of polychlorinated biphenyls and polybrominated biphenyls in commercial transformers';
    const rows = [Array.from({ length: 12 }, (_, c) => cell(`${sentence} ${c}`))];
    const pdf = await renderPdfTables([{ rows, headerRows: 1 }], { orientation: 'landscape' });
    expect(pdfWords(pdf)).toEqual(rows[0].flatMap((c) => c.text.match(WORD) ?? []).sort());
  });
});
