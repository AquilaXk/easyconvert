import { describe, expect, it } from 'vitest';
import { convertOffice } from '../src/lib/conversions/office';
import { craftDocx, paragraph } from './helpers/docx-craft';
import { odtWords } from './helpers/document-words';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';
import { sofficeConvert } from './helpers/soffice-convert';
import JSZip from 'jszip';

/**
 * A Word document that draws a shape is read by the drawing-aware reader, whose blocks are paragraphs, tables, charts and
 * shapes in document order. The in-process ODT of it holds the same blocks as its plain-text export: the cells of a table
 * are a table of the ODT, not lost. These tests run the in-process writer (`convertOffice`); the worker sends a Word
 * document to LibreOffice for ODT, so this is the route of a host without the office suite.
 */

const CONVERSION_TIMEOUT_MS = 240_000;

const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${paragraph(text)}</w:tc>`;
const row = (...cells: string[]): string => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
const table = (...rows: string[]): string => `<w:tbl><w:tblPr/><w:tblGrid/>${rows.join('')}</w:tbl>`;

/** A drawing that is neither a picture nor a text box, which the document model leaves to the drawing-aware reader. */
const DRAWN_SHAPE =
  '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="100" cy="100"/></wp:inline></w:drawing></w:r></w:p>';

const toOdt = async (docx: Buffer): Promise<Buffer> => (await convertOffice(docx, 'docx', 'odt', {}, 'sample.docx')).buffer;

const wordsOf = (text: string): string[] => text.replace(/^﻿/, '').split(/\s+/).filter(Boolean);

describe('DOCX with a drawn shape to ODT', () => {
  it('writes the cells of a table between the paragraphs around it, in reading order', async () => {
    const docx = await craftDocx({ body: paragraph('Before') + DRAWN_SHAPE + table(row('Region', 'Revenue'), row('North', '120')) + paragraph('After') });
    const odt = await toOdt(docx);
    expect(await odtWords(odt)).toEqual(['Before', 'Region', 'Revenue', 'North', '120', 'After']);
    const content = await (await JSZip.loadAsync(odt)).file('content.xml')!.async('string');
    expect(content.match(/<table:table-row>/g)).toHaveLength(2);
    expect(content.match(/<table:table-cell /g)).toHaveLength(4);
  });

  it('holds no heading of its own: the words are those of the document', async () => {
    const docx = await craftDocx({ body: DRAWN_SHAPE + paragraph('Only words') });
    expect(await odtWords(await toOdt(docx))).toEqual(['Only', 'words']);
  });
});

/**
 * Real Apache POI documents that draw shapes and hold tables (bug65649: a 21-table contract, wordwithattachments). LibreOffice's
 * plain-text export of the document is the oracle, read as letter runs: its export joins or splits the words around list
 * labels, footnote marks and field results, which the reader states differently (22 of the 28,485 letter runs of the contract and
 * the word "Hyperlink" of the other differ), so the runs are counted, not compared in sequence. The paragraphs alone gave 28 % of
 * the letter runs of the contract and 92 % of the other.
 */
const DRAWN_WITH_TABLES = ['office-document-bug65649.docx', 'office-document-wordwithattachments.docx'];
const MIN_RECALL = 0.98;

const letterRuns = (words: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const run of words.join(' ').match(/\p{L}+/gu) ?? []) counts.set(run, (counts.get(run) ?? 0) + 1);
  return counts;
};

describe('Real documents with drawn shapes and tables to ODT', () => {
  for (const id of DRAWN_WITH_TABLES) {
    oracleTest(`${id} holds the words of LibreOffice's text export of the document`, ['soffice'], async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const expected = letterRuns(sofficeConvert(bytes, 'sample.docx', 'txt:Text', (output) => wordsOf(output.read().toString('utf-8'))));
      const odt = await toOdt(bytes);
      const actual = letterRuns(sofficeConvert(odt, 'sample.odt', 'txt:Text', (output) => wordsOf(output.read().toString('utf-8'))));
      let total = 0;
      let missing = 0;
      for (const [run, count] of expected) {
        total += count;
        missing += Math.max(0, count - (actual.get(run) ?? 0));
      }
      expect(total).toBeGreaterThan(0);
      expect(1 - missing / total).toBeGreaterThanOrEqual(MIN_RECALL);
    }, CONVERSION_TIMEOUT_MS);
  }
});
