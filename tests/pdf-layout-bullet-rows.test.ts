import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { requireOracleTool } from './helpers/differential-oracle';
import { rawPdf } from './helpers/raw-pdf';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A list whose bullets sit apart from their text: the bullet and the text are two segments of one row, which the stream-table
 * detector read as two cells (`detectStreamTables` in src/lib/conversions/pdf-layout/tables.ts). A run of such rows, or such rows next to a
 * header row of two pieces, became a table of bullets and texts: `•\tPrecise definitions ...`, with the lines that carry an item on
 * not joined to it and the running header or footer next to them swallowed into the table, so that it was not taken out as
 * page furniture. The row is a list item: one line, "• text". The oracle is `pdftotext` (Poppler, 26.09), which reads the same
 * bytes: it prints the same words, and no tab, for the list.
 *
 * Wingdings bullets that print nothing (entry 104 of the policy record) were control characters before, which made the same
 * tables; with no glyph the rows are single segments and never were cells.
 */

const toolsMissing = skipWithoutTools('pdftotext');
/** A real file of 100 pages reads in seconds on a loaded runner, past the default test timeout. */
const REAL_FILE_TIMEOUT_MS = 120_000;

/** WinAnsi 0x95, the bullet. */
const BULLET = '\\225';

interface Run {
  x: number;
  y: number;
  text: string;
}

function pageOf(runs: Run[]): Buffer {
  const content = runs.map(({ x, y, text }) => `BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`).join('\n');
  return rawPdf([{ width: 612, height: 792, content }]);
}

/** The header, a list of three items whose second wraps with a hanging indent, and two lines of prose below the list. */
function listPage(): Buffer {
  return pageOf([
    { x: 36, y: 750, text: 'Executive Summary' },
    { x: 427, y: 750, text: 'Why Do We Need Signals' },
    { x: 180, y: 700, text: BULLET },
    { x: 198, y: 700, text: 'A concept of operations under which the data definitions are used.' },
    { x: 180, y: 679, text: BULLET },
    { x: 198, y: 679, text: 'Precise definitions of the sequences in which certain data are to be' },
    { x: 198, y: 664, text: 'exchanged (dialogs) are being added. Examples of these dialogs include:' },
    { x: 180, y: 643, text: BULLET },
    { x: 198, y: 643, text: 'Standardized data elements pertaining to the definition of a phase.' },
    { x: 144, y: 600, text: 'The prose below the list starts at the body edge.' },
  ]);
}

async function textOf(pdf: Buffer): Promise<string> {
  return (await convertFile(pdf, 'pdf', 'txt', {}, 'bullets.pdf')).buffer.toString('utf8');
}

function pdftotext(bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-bullets-oracle-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, bytes);
    return execFileSync(requireOracleTool('pdftotext'), ['-q', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const words = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).sort();

describe.skipIf(toolsMissing)('a list whose bullets sit apart from their text', () => {
  it('is a line for each item, "• text", and the item that wraps is one line, not cells of a table', async () => {
    const text = await textOf(listPage());
    expect(text).not.toContain('\t');
    expect(text).toContain('• A concept of operations under which the data definitions are used.');
    expect(text).toContain('• Precise definitions of the sequences in which certain data are to be exchanged (dialogs) are being added. Examples of these dialogs include:');
    expect(text).toContain('• Standardized data elements pertaining to the definition of a phase.');
    expect(text.split('\n').filter((line) => line.startsWith('•'))).toEqual([
      '• A concept of operations under which the data definitions are used.',
      '• Precise definitions of the sequences in which certain data are to be exchanged (dialogs) are being added. Examples of these dialogs include:',
      '• Standardized data elements pertaining to the definition of a phase.',
    ]);
  });

  it('keeps the header apart from the list and says the words pdftotext prints', async () => {
    const pdf = listPage();
    const text = await textOf(pdf);
    expect(text.split('\n')[0]).toBe('Executive Summary Why Do We Need Signals');
    expect(words(text)).toEqual(words(pdftotext(pdf)));
  });

  it('keeps the prose below the list a paragraph of its own', async () => {
    const lines = (await textOf(listPage())).split('\n');
    expect(lines[lines.length - 1]).toBe('The prose below the list starts at the body edge.');
    expect(lines[lines.length - 2]).toBe('');
  });

  it('leaves a table whose first column holds a dash, which is a cell and not a bullet, as a table', async () => {
    const rows = [
      ['-', 'Alpha'],
      ['Name', 'Beta'],
      ['Other', 'Gamma'],
      ['More', 'Delta'],
    ];
    const pdf = pageOf(rows.flatMap(([first, second], index) => [{ x: 72, y: 700 - index * 18, text: first }, { x: 300, y: 700 - index * 18, text: second }]));
    const text = await textOf(pdf);
    expect(text).toBe('-\tAlpha\nName\tBeta\nOther\tGamma\nMore\tDelta');
  });
});

describe.skipIf(toolsMissing)('the real files whose Wingdings bullets print nothing', () => {
  it('gd-499819.pdf: the bullets that print are items of a list, "• text", with no tab and no cell around the page header', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'gd-499819.pdf');
    const text = (await convertFile(bytes, 'pdf', 'txt', {}, 'gd-499819.pdf')).buffer.toString('utf8');
    expect(text).not.toMatch(/•\t/);
    expect(text).not.toContain('Executive Summary\tWhy Do We Need NTCIP?');
    expect(text).toContain('• Precise definitions of the sequences in which certain data definitions are to be exchanged (dialogs) are being added. Examples of these dialogs include:');
    expect(text).toContain('• A traffic signal management system communicating with traffic signal controllers at intersections;');
  }, REAL_FILE_TIMEOUT_MS);

  it('gd-326174.pdf: the section heading, its sentence and each item of the list that has no bullet to print are lines of their own', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'gd-326174.pdf');
    const lines = (await convertFile(bytes, 'pdf', 'txt', {}, 'gd-326174.pdf')).buffer.toString('utf8').split('\n');
    const at = lines.indexOf('The following sections provide the details of the study:');
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 2]).toBe('2.2 ORGANIZATION OF REPORT');
    const items = lines.slice(at + 1, at + 15).filter((line) => line !== '');
    expect(items.slice(0, 3)).toEqual(['Methane Sources – Overview', 'Markets for Methane – Overview', 'Methane Sources and Markets in Target Countries']);
    expect(lines.slice(at - 2, at + 15).some((line) => line.includes('\t'))).toBe(false);
  }, REAL_FILE_TIMEOUT_MS);

  it('gd-070040.pdf: the names under a state are lines of their own, not cells next to the state names of another column', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'gd-070040.pdf');
    const lines = (await convertFile(bytes, 'pdf', 'txt', {}, 'gd-070040.pdf')).buffer.toString('utf8').split('\n');
    const at = lines.findIndex((line) => line.startsWith('Kelly Brodie, David Shaw'));
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 2]).toBe('California');
    expect(lines.slice(at - 2, at + 12).some((line) => line.includes('\t'))).toBe(false);
  }, REAL_FILE_TIMEOUT_MS);
});
