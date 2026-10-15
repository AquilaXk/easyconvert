import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { convertHwpDocument, type HwpDocument } from '../src/lib/conversions/hwp';
import { renderHwpToSvg } from '../src/lib/conversions/hwp-render';
import { MAX_RENDER_PIXELS } from '../src/lib/conversions/image-limits';
import { PayloadLimitError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';

/**
 * HWP to image draws every paragraph and table row. Counts are read from the SVG with xmllint's XPath engine
 * (an XML parser that shares nothing with the renderer), and the PNG is read back with Tesseract.
 */

const PARAGRAPH_COUNT = 60;
const TABLE_ROWS = 30;
const TABLE_COLUMNS = 3;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const OCR_SCALE = 3;
const TOP_REGION = 300;
const BOTTOM_REGION = 120;
/** Height of the band above a baseline that holds the text, and the grey level below which a pixel counts as ink. */
const INK_BAND = 9;
const INK_LEVEL = 100;

function documentOf(paragraphs: string[], rows: string[][] = []): HwpDocument {
  return {
    version: '5.0.3.0',
    isCompressed: false,
    isEncrypted: false,
    isDistributed: false,
    paragraphs: paragraphs.map((text, i) => ({ text, isHeading: i % 20 === 0, isBold: false, isItalic: false })),
    tables: rows.length > 0 ? [{ rowCount: rows.length, colCount: rows[0].length, rows }] : [],
    metadata: {},
  };
}

const PARAGRAPHS = Array.from({ length: PARAGRAPH_COUNT }, (_, i) => `Paragraph ${i + 1} of the sample 한국어 text`);
const ROWS = Array.from({ length: TABLE_ROWS }, (_, r) => Array.from({ length: TABLE_COLUMNS }, (_, c) => `r${r + 1}c${c + 1}`));

function xpathCount(svg: string, expression: string): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-svg-'));
  try {
    fs.writeFileSync(path.join(dir, 'page.svg'), svg);
    const out = execFileSync(requireOracleTool('xmllint'), ['--xpath', `count(${expression})`, path.join(dir, 'page.svg')], { encoding: 'utf-8' });
    return Number(out.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('HWP to SVG', () => {
  oracleTest('draws 60 paragraphs and a 30-row table, each once', ['xmllint'], async () => {
    const svg = await renderHwpToSvg(documentOf(PARAGRAPHS, ROWS));
    expect(xpathCount(svg, "//*[local-name()='text'][@class='paragraph']")).toBe(PARAGRAPH_COUNT);
    expect(xpathCount(svg, "//*[local-name()='g'][@class='row']")).toBe(TABLE_ROWS);
    expect(xpathCount(svg, "//*[local-name()='text'][@class='cell']")).toBe(TABLE_ROWS * TABLE_COLUMNS);
  });

  oracleTest('wraps a paragraph wider than the page over several lines without losing a character', ['xmllint'], async () => {
    const paragraph = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
    const svg = await renderHwpToSvg(documentOf([paragraph]));
    expect(xpathCount(svg, "//*[local-name()='text'][@class='paragraph']")).toBe(1);
    const lines = [...svg.matchAll(/<tspan[^>]*class="line"[^>]*>(.*?)<\/tspan>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(' ')).toBe(paragraph);
  });

  it('draws no title bar, accent or fixed truncation', async () => {
    const svg = await renderHwpToSvg(documentOf(['Only paragraph']));
    expect(svg).not.toContain('#5C6BC0');
    expect((svg.match(/<text\b/g) ?? []).length).toBe(1);
  });

  it('refuses a document whose drawing would pass MAX_RENDER_PIXELS with a typed 413 error', async () => {
    const huge = documentOf(Array.from({ length: 4000 }, (_, i) => `Line ${i}`.padEnd(40, 'x').repeat(30)));
    const run = convertHwpDocument(huge, 'png', {}, 'huge');
    await expect(run).rejects.toBeInstanceOf(PayloadLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE });
    expect(MAX_RENDER_PIXELS).toBeGreaterThan(0);
  }, 120_000);
});

describe('HWP to PNG', () => {
  /** Text OCR reads from a region of the PNG, upscaled so that the small text is within what Tesseract reads. */
  async function ocr(png: Buffer, region: { left: number; top: number; width: number; height: number }, extra: string[]): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-png-'));
    try {
      const file = path.join(dir, 'region.png');
      fs.writeFileSync(file, await sharp(png).extract(region).resize({ width: region.width * OCR_SCALE }).png().toBuffer());
      return execFileSync(requireOracleTool('tesseract'), [file, '-', '-l', 'eng', ...extra], { encoding: 'utf-8' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  oracleTest('shows the first paragraph (read back with OCR) and ink in the band of the last table row', ['tesseract'], async () => {
    const doc = documentOf(PARAGRAPHS, ROWS);
    const result = await convertHwpDocument(doc, 'png', {}, 'sample');
    expect(result.mimeType).toBe('image/png');
    const { width, height } = await sharp(result.buffer).metadata();
    expect(height).toBeGreaterThan(width! * 2);
    const top = await ocr(result.buffer, { left: 0, top: 0, width: width!, height: TOP_REGION }, ['--psm', '4']);
    expect(top).toContain('Paragraph 1 of');
    // The last cell text of the SVG page sits at y; the PNG has dark pixels in the band just above that baseline.
    const svg = await renderHwpToSvg(doc);
    const cellLines = [...svg.matchAll(/<text class="cell"[^>]*><tspan class="line" x="[\d.]+" y="([\d.]+)"/g)];
    const lastBaseline = Math.round(Number(cellLines[cellLines.length - 1][1]));
    expect(lastBaseline).toBeLessThan(height!);
    const band = await sharp(result.buffer).extract({ left: 0, top: lastBaseline - INK_BAND, width: width!, height: INK_BAND }).greyscale().raw().toBuffer();
    expect(Math.min(...band)).toBeLessThan(INK_LEVEL);
  }, 240_000);

  oracleTest('shows the last paragraph at the bottom of a page without a table', ['tesseract'], async () => {
    const withoutTable = documentOf(PARAGRAPHS);
    const result = await convertHwpDocument(withoutTable, 'png', {}, 'sample');
    const { width, height } = await sharp(result.buffer).metadata();
    const bottom = await ocr(result.buffer, { left: 0, top: height! - BOTTOM_REGION, width: width!, height: BOTTOM_REGION }, ['--psm', '6']);
    expect(bottom.trim().split('\n').pop()).toMatch(/^Paragraph 60 of the sample/);
  }, 240_000);
});
