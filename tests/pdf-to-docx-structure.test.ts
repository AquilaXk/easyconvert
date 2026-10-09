import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions/index';
import { documentToDocx } from '../src/lib/conversions/document-model/docx';
import { plainTextModel } from '../src/lib/conversions/document-model/plain';
import { InvalidXmlCharacterError } from '../src/lib/conversions/document-model/xml-text';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { captureError } from './helpers/capture-error';
import { cer } from './helpers/pdf-text-metrics';
import { readDocxStructure, type DocxStructure } from './helpers/docx-structure';
import { aggregate, scoreStructure, type StructureTruth } from './helpers/structure-metrics';
import { teds } from './helpers/teds';

/**
 * PDF to DOCX keeps the document's structure. The corpus is 24 documents rendered by LibreOffice from sources written for
 * this repository (tests/fixtures/pdf-structure/PROVENANCE.md); what each contains is known from the sources, not read back
 * from the PDFs. The DOCX files are read with an independent reader (tests/helpers/docx-structure.ts), by their XML, and by
 * LibreOffice itself (a DOCX -> PDF round trip read with pdftotext).
 */

const CORPUS = path.join(__dirname, 'fixtures', 'pdf-structure');
const TEXT_FIXTURES = path.join(__dirname, 'fixtures', 'pdf-text');
const DOCUMENTS = 24;
/** Index of the first two-column document of the corpus (the generator writes 18 single-column ones first). */
const TWO_COLUMN_FIRST = 18;
const NAME_WIDTH = 2;
const MIN_HEADING_F1 = 0.95;
const MIN_LIST_F1 = 0.95;
const MIN_TEDS = 0.9;
const MAX_PARAGRAPH_COUNT_ERROR = 0.05;
const MIN_READING_ORDER_TAU = 0.95;
const MAX_ROUND_TRIP_CER = 0.02;
const TWO_COLUMN_PARAGRAPHS = 40;
const PARAGRAPH_TOLERANCE = 0.05;
const SOFFICE_TIMEOUT_MS = 240_000;
const ROUND_TRIP_TEST_TIMEOUT_MS = 300_000;

const names = Array.from({ length: DOCUMENTS }, (_, index) => `doc-${String(index + 1).padStart(NAME_WIDTH, '0')}`);
const pdfOf = (name: string, dir = CORPUS): Buffer => fs.readFileSync(path.join(dir, `${name}.pdf`));
const truthOf = (name: string): StructureTruth => JSON.parse(fs.readFileSync(path.join(CORPUS, `${name}.truth.json`), 'utf8')) as StructureTruth;

async function docxOf(name: string, dir = CORPUS): Promise<Buffer> {
  return (await convertFile(pdfOf(name, dir), 'pdf', 'docx', {}, `${name}.pdf`)).buffer;
}

const converted = new Map<string, Promise<Buffer>>();
function cachedDocx(name: string): Promise<Buffer> {
  if (!converted.has(name)) converted.set(name, docxOf(name));
  return converted.get(name) as Promise<Buffer>;
}

async function part(docx: Buffer, entry: string): Promise<string> {
  const file = (await JSZip.loadAsync(docx)).file(entry);
  if (!file) throw new Error(`${entry} is not in the package`);
  return file.async('string');
}

describe('two columns', () => {
  it('a two-column page of 40 paragraphs becomes about 40 paragraphs in two section columns, not 4', async () => {
    const docx = await docxOf('two-column', TEXT_FIXTURES);
    const structure = await readDocxStructure(docx);
    const body = structure.paragraphs.filter((paragraph) => !paragraph.inTable && paragraph.text.trim() !== '');
    expect(Math.abs(body.length - TWO_COLUMN_PARAGRAPHS) / TWO_COLUMN_PARAGRAPHS).toBeLessThanOrEqual(PARAGRAPH_TOLERANCE);
    expect(structure.maxColumns).toBe(2);
    expect(await part(docx, 'word/document.xml')).toMatch(/<w:cols w:num="2" w:space="\d+"\/>/);
  });
});

describe('structure of the corpus, against what the documents were written from', () => {
  it('finds headings, lists, tables, columns, paragraphs and reading order', async () => {
    const scores = [];
    for (const name of names) scores.push(scoreStructure(truthOf(name), await readDocxStructure(await cachedDocx(name))));
    const corpus = aggregate(scores);
    expect(corpus.heading.f1).toBeGreaterThanOrEqual(MIN_HEADING_F1);
    expect(corpus.headingLevelAccuracy).toBeGreaterThanOrEqual(MIN_HEADING_F1);
    expect(corpus.list.f1).toBeGreaterThanOrEqual(MIN_LIST_F1);
    expect(corpus.tableTeds).toBeGreaterThanOrEqual(MIN_TEDS);
    expect(corpus.columnAccuracy).toBe(1);
    expect(corpus.paragraphCountError).toBeLessThanOrEqual(MAX_PARAGRAPH_COUNT_ERROR);
    expect(corpus.readingOrderTau).toBeGreaterThanOrEqual(MIN_READING_ORDER_TAU);
  }, 120_000);

  it('writes real structures: heading styles, numbering definitions, w:tbl and section columns', async () => {
    const withTables = names.findIndex((name, index) => truthOf(name).blocks.some((block) => block.type === 'table') && index < TWO_COLUMN_FIRST);
    const docx = await cachedDocx(names[withTables]);
    const document = await part(docx, 'word/document.xml');
    expect(document).toMatch(/<w:pStyle w:val="Heading1"\/>/);
    expect(document).toMatch(/<w:pStyle w:val="Heading2"\/>/);
    expect(document).toContain('<w:tbl>');
    expect(document).toContain('<w:tblGrid>');
    expect(document).toMatch(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="\d+"\/><\/w:numPr>/);
    const numbering = await part(await cachedDocx('doc-01'), 'word/numbering.xml');
    expect(numbering).toMatch(/<w:numFmt w:val="bullet"\/>/);
    expect(numbering).toMatch(/<w:numFmt w:val="decimal"\/>/);
    const twoColumns = await part(await cachedDocx(names[TWO_COLUMN_FIRST]), 'word/document.xml');
    expect(twoColumns).toMatch(/<w:cols w:num="2"/);
    expect(twoColumns).toMatch(/<w:type w:val="continuous"\/>/);
  });

  it('tells bullet lists from numbered ones', async () => {
    let bullets = 0;
    let numbered = 0;
    for (const name of names) {
      const truth = truthOf(name);
      const structure = await readDocxStructure(await cachedDocx(name));
      const expectedBullets = truth.blocks.filter((block) => block.type === 'list' && !block.ordered).flatMap((block) => (block.type === 'list' ? block.items : [])).length;
      const expectedNumbered = truth.blocks.filter((block) => block.type === 'list' && block.ordered).flatMap((block) => (block.type === 'list' ? block.items : [])).length;
      bullets += structure.paragraphs.filter((paragraph) => paragraph.list === 'bullet').length - expectedBullets;
      numbered += structure.paragraphs.filter((paragraph) => paragraph.list === 'ordered').length - expectedNumbered;
    }
    expect({ bullets, numbered }).toEqual({ bullets: 0, numbered: 0 });
  }, 60_000);
});

describe('merged cells', () => {
  it('writes gridSpan and vMerge and keeps the text of every cell', async () => {
    const docx = await docxOf('merged-table');
    const document = await part(docx, 'word/document.xml');
    expect(document).toContain('<w:gridSpan w:val="2"/>');
    expect(document).toContain('<w:vMerge w:val="restart"/>');
    expect(document).toContain('<w:vMerge/>');
    const structure: DocxStructure = await readDocxStructure(docx);
    expect(structure.tables).toHaveLength(1);
    const expected = (JSON.parse(fs.readFileSync(path.join(CORPUS, 'merged-table.truth.json'), 'utf8')) as { rows: { text: string }[][] }).rows;
    // The reader lists a merged cell once, so the expected rows are the cells that start in each row.
    expect(teds(expected.map((row) => row.map((cell) => cell.text)), structure.tables[0])).toBeGreaterThanOrEqual(MIN_TEDS);
  });
});

describe('images', () => {
  for (const name of ['doc-04', 'doc-13']) {
    oracleTest(`${name}: the JPEG of the PDF is in word/media byte for byte`, ['pdfimages'], async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-docx-image-'));
      try {
        execFileSync(requireOracleTool('pdfimages'), ['-j', path.join(CORPUS, `${name}.pdf`), path.join(dir, 'img')]);
        const embedded = fs.readFileSync(path.join(dir, 'img-000.jpg'));
        const zip = await JSZip.loadAsync(await cachedDocx(name));
        const media = Object.keys(zip.files).filter((entry) => entry.startsWith('word/media/') && !zip.files[entry].dir);
        expect(media).toEqual(['word/media/image1.jpeg']);
        const written = await (zip.file(media[0]) as JSZip.JSZipObject).async('nodebuffer');
        expect(written.equals(embedded)).toBe(true);
        const document = await part(await cachedDocx(name), 'word/document.xml');
        // 240 x 140 pixels drawn at 180 x 105 points.
        expect(document).toContain(`<wp:extent cx="${180 * 12700}" cy="${105 * 12700}"/>`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('LibreOffice reads the result', () => {
  oracleTest(
    'every DOCX of the corpus renders to PDF with the same text (character error rate at most 0.02)',
    ['soffice', 'pdftotext'],
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-docx-roundtrip-'));
      try {
        for (const name of names) fs.writeFileSync(path.join(dir, `${name}.docx`), await cachedDocx(name));
        execFileSync(
          requireOracleTool('soffice'),
          ['--headless', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pdf', '--outdir', dir, ...names.map((name) => path.join(dir, `${name}.docx`))],
          { timeout: SOFFICE_TIMEOUT_MS, stdio: 'ignore' }
        );
        const errors: Record<string, number> = {};
        for (const name of names) {
          const rendered = execFileSync(requireOracleTool('pdftotext'), ['-raw', '-enc', 'UTF-8', path.join(dir, `${name}.pdf`), '-'], { encoding: 'utf8' });
          let expected = '';
          for (const block of truthOf(name).blocks) {
            if (block.type === 'list') expected += ` ${block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '•'} ${item}`).join(' ')}`;
            else if (block.type === 'table') expected += ` ${block.rows.flat().join(' ')}`;
            else if (block.type !== 'image') expected += ` ${block.text}`;
          }
          errors[name] = Math.round(cer(expected, rendered) * 1000) / 1000;
        }
        const worst = Math.max(...Object.values(errors));
        expect({ worst: worst <= MAX_ROUND_TRIP_CER, errors: worst <= MAX_ROUND_TRIP_CER ? undefined : errors }).toEqual({ worst: true, errors: undefined });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ROUND_TRIP_TEST_TIMEOUT_MS
  );

  oracleTest('every part is well-formed XML 1.0 (xmllint)', ['xmllint'], async () => {
    const docx = await cachedDocx('doc-04');
    const zip = await JSZip.loadAsync(docx);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-docx-xml-'));
    try {
      const parts = Object.keys(zip.files).filter((entry) => /\.(xml|rels)$/.test(entry));
      expect([...parts].sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/numbering.xml', 'word/styles.xml']);
      for (const entry of parts) {
        const file = path.join(dir, entry.replace(/\//g, '_'));
        fs.writeFileSync(file, await (zip.file(entry) as JSZip.JSZipObject).async('nodebuffer'));
        execFileSync(requireOracleTool('xmllint'), ['--noout', file]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('XML safety', () => {
  for (const [label, text] of [
    ['a control character', 'broken\u0001text'],
    ['a lone surrogate', 'broken\ud800text'],
    ['U+FFFE', 'broken￾text'],
  ] as const) {
    it(`refuses ${label} instead of writing it`, async () => {
      const error = await captureError(() => documentToDocx(plainTextModel(text)));
      expect(error).toBeInstanceOf(InvalidXmlCharacterError);
      expect((error as InvalidXmlCharacterError).status).toBe(400);
    });
  }

  it('writes tab, line feed and supplementary-plane characters', async () => {
    const docx = await documentToDocx(plainTextModel('tab\tand astral \u{1f600} and \u{20000}'));
    const document = await part(docx, 'word/document.xml');
    expect(/<w:r>(.*?)<\/w:r>/.exec(document)?.[1]).toBe(
      '<w:t xml:space="preserve">tab</w:t><w:tab/><w:t xml:space="preserve">and astral \u{1f600} and \u{20000}</w:t>'
    );
  });

  it('writes every tab of a run, not only the first', async () => {
    const docx = await documentToDocx(plainTextModel('a\tb\t\tc'));
    const document = await part(docx, 'word/document.xml');
    expect(/<w:r>(.*?)<\/w:r>/.exec(document)?.[1]).toBe(
      '<w:t xml:space="preserve">a</w:t><w:tab/><w:t xml:space="preserve">b</w:t><w:tab/><w:tab/><w:t xml:space="preserve">c</w:t>'
    );
  });
});

describe('other writers of the same structure', () => {
  it('writes HTML with headings, lists and tables', async () => {
    const html = (await convertFile(pdfOf('doc-02'), 'pdf', 'html', {}, 'doc-02.pdf')).buffer.toString('utf8');
    expect(html).toMatch(/<h1>[^<]+<\/h1>/);
    expect(html).toMatch(/<h2>[^<]+<\/h2>/);
    expect(html).toMatch(/<(ul|ol)[^>]*><li>/);
    expect(html).toContain('<table');
    expect(html).toContain('<th>');
  });

  it('writes Markdown with headings, list items and a pipe table', async () => {
    const markdown = (await convertFile(pdfOf('doc-02'), 'pdf', 'md', {}, 'doc-02.pdf')).buffer.toString('utf8');
    expect(markdown).toMatch(/^# \S/m);
    expect(markdown).toMatch(/^## \S/m);
    expect(markdown).toMatch(/^(- |\d+\. )\S/m);
    expect(markdown).toMatch(/^\| .* \|\n\| --- /m);
  });
});
