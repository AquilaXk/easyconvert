import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { DOCX_MAX_TABLE_DEPTH } from '../src/lib/conversions/docx-model';
import { ConversionFailedError, PayloadLimitError } from '../src/lib/types';
import { craftDocx, paragraph } from './helpers/docx-craft';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';
import { sofficeConvert } from './helpers/soffice-convert';

/**
 * A Word document is put on slides as the text its plain-text export gives: body paragraphs, table cells, the text of
 * text boxes, in reading order. Headers and footers are not body text for LibreOffice's text filter (sw/source/filter/ascii),
 * and neither is a picture. A document that has none of it is refused with a typed answer.
 */

const CONVERSION_TIMEOUT_MS = 240_000;
const NO_TEXT_REFUSAL = 'There is no text to put on slides.';

const CONTINUATION_SUFFIX = ' (Cont.)';
const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/;

async function slideWords(pptx: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(pptx);
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, number: Number(SLIDE_PART.exec(name)?.[1]) }))
    .filter((slide) => !Number.isNaN(slide.number))
    .sort((a, b) => a.number - b.number);
  const words: string[] = [];
  for (const slide of slides) {
    const xml = await zip.file(slide.name)!.async('string');
    const lines = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]);
    // The title of a slide that carries on the text of the one before it repeats that slide's title; it is not document text.
    const body = lines[0]?.endsWith(CONTINUATION_SUFFIX) ? lines.slice(1) : lines;
    for (const line of body) words.push(...line.split(/\s+/).filter(Boolean));
  }
  return words;
}

const wordsOf = (text: string): string[] => text.replace(/^﻿/, '').split(/\s+/).filter(Boolean);

const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${paragraph(text)}</w:tc>`;
const row = (...cells: string[]): string => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
const table = (...rows: string[]): string => `<w:tbl><w:tblPr/><w:tblGrid/>${rows.join('')}</w:tbl>`;

function nestedTables(depth: number, text: string): string {
  let nested = table(row(text));
  for (let level = 0; level < depth; level += 1) nested = `<w:tbl><w:tblPr/><w:tblGrid/><w:tr><w:tc>${nested}<w:p/></w:tc></w:tr></w:tbl>`;
  return nested;
}

/** A drawing that is neither a picture nor a text box, which the document model leaves to the drawing-aware reader. */
const DRAWN_SHAPE =
  '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="100" cy="100"/></wp:inline></w:drawing></w:r></w:p>';

const toSlides = (docx: Buffer): Promise<Buffer> => dispatchConversion(docx, 'docx', 'pptx', {}, 'sample.docx').then((result) => result.buffer);

describe('DOCX to PPTX text', () => {
  it('puts the cells of a document that is only a table on slides, row after row', async () => {
    const docx = await craftDocx({ body: table(row('Region', 'Revenue'), row('North', '120'), row('South', '95')) });
    expect(await slideWords(await toSlides(docx))).toEqual(['Region', 'Revenue', 'North', '120', 'South', '95']);
  });

  it('keeps a table between the paragraphs around it in reading order', async () => {
    const docx = await craftDocx({ body: paragraph('Before') + table(row('Cell one', 'Cell two')) + paragraph('After') });
    expect(await slideWords(await toSlides(docx))).toEqual(['Before', 'Cell', 'one', 'Cell', 'two', 'After']);
  });

  it('puts the text of a text box on slides', async () => {
    const box = `<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent>${paragraph('Boxed words')}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`;
    const docx = await craftDocx({ body: paragraph('Body text') + box });
    expect(await slideWords(await toSlides(docx))).toEqual(['Body', 'text', 'Boxed', 'words']);
  });

  it('puts the cells of a table on slides when the document also draws a shape', async () => {
    const docx = await craftDocx({ body: DRAWN_SHAPE + table(row('Drawn', 'beside', 'table')) });
    expect(await slideWords(await toSlides(docx))).toEqual(['Drawn', 'beside', 'table']);
  });

  it('refuses a document with no body text, as the text export of the same document is empty', async () => {
    const docx = await craftDocx({ body: '<w:p/>' + table(row('', '')) });
    const failure = await toSlides(docx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toBe(NO_TEXT_REFUSAL);
  });

  it('flattens tables nested beyond the table depth limit and keeps their text', async () => {
    const docx = await craftDocx({ body: nestedTables(DOCX_MAX_TABLE_DEPTH * 2, 'Innermost') });
    expect(await slideWords(await toSlides(docx))).toContain('Innermost');
  });

  it('refuses tables nested past the XML depth limit with a typed answer', async () => {
    const docx = await craftDocx({ body: nestedTables(3000, 'Innermost') });
    const failure = await toSlides(docx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PayloadLimitError);
  });

  it('writes every row of a table with tens of thousands of rows', async () => {
    const rows = 30_000;
    const docx = await craftDocx({ body: table(...Array.from({ length: rows }, (_, index) => row(`r${index}`, `v${index}`))) });
    const words = await slideWords(await toSlides(docx));
    expect(words).toHaveLength(rows * 2);
    expect(words.slice(0, 4)).toEqual(['r0', 'v0', 'r1', 'v1']);
    expect(words.slice(-2)).toEqual([`r${rows - 1}`, `v${rows - 1}`]);
  }, CONVERSION_TIMEOUT_MS);
});

/**
 * Real Apache POI test documents (bench/realworld/manifest.json). LibreOffice's plain-text export of each is the oracle:
 * the slides hold its words in its order, or, where it has none, the conversion is refused.
 */
const WITH_TEXT = ['office-document-testtablecellalign.docx', 'office-document-table-indent.docx', 'office-document-bug66988.docx'];
const WITHOUT_BODY_TEXT = [
  'office-document-59378.docx',
  'office-document-bug62859.docx',
  'office-document-headerpic.docx',
  'office-document-issue_51265_3.docx',
  'office-document-emptydocumentwithheaderfooter.docx',
];

describe('Real documents on slides', () => {
  for (const id of WITH_TEXT) {
    oracleTest(`${id} holds the words LibreOffice's text export gives`, ['soffice'], async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const expected = sofficeConvert(bytes, 'sample.docx', 'txt:Text', (output) => wordsOf(output.read().toString('utf-8')));
      expect(expected.length).toBeGreaterThan(0);
      expect(await slideWords(await toSlides(bytes))).toEqual(expected);
    }, CONVERSION_TIMEOUT_MS);
  }

  for (const id of WITHOUT_BODY_TEXT) {
    oracleTest(`${id} has no words in LibreOffice's text export and is refused`, ['soffice'], async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const expected = sofficeConvert(bytes, 'sample.docx', 'txt:Text', (output) => wordsOf(output.read().toString('utf-8')));
      expect(expected).toEqual([]);
      const failure = await toSlides(bytes).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toBe(NO_TEXT_REFUSAL);
    }, CONVERSION_TIMEOUT_MS);
  }
});
