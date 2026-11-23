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
 * PDF to DOCX keeps the pages of the PDF. The files are real government documents of the real-world corpus (bench/realworld/manifest.json):
 * a four-page order with footnotes, two opinions of a court of appeals, a ten-page chronology with a letterhead picture, and a report.
 * The DOCX files are read without the writer's help: the sections and page sizes from `word/document.xml`, the page count and the
 * position of the first line of each page from LibreOffice's PDF of the DOCX read by Poppler (`pdfinfo`, `pdftotext -bbox`), and the
 * words against what `pdftotext` reads from the PDF itself.
 */

/** Files whose paragraphs wrap by the page's lines, and the share of the PDF's line ends (last two words) the render has at least (LibreOffice 24.2 reads 0.98, 0.88 and 0.88; the files read 0.75, 0.41 and 0.64 when each paragraph wraps at the page's right edge with a few points of slack). */
const WRAPPED = [
  { id: 'govdocs1-000022.pdf', min: 0.9 },
  { id: 'govdocs1-003947.pdf', min: 0.8 },
  { id: 'govdocs1-000562.pdf', min: 0.8 },
];
const LINE_END_PAGES = 4;

const SAMPLES = ['govdocs1-000010.pdf', 'govdocs1-000568.pdf', 'govdocs1-000569.pdf', 'govdocs1-001946.pdf', 'govdocs1-004472.pdf'];
const TWIPS_PER_POINT = 20;
const SOFFICE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 300_000;
/** Words of the PDF that the DOCX holds, as a multiset (the corpus files converted to the words below with these shares or better). */
const MIN_WORD_RECALL = 0.97;
/** Points the first line of a page may stand from where the PDF's first line does, at the median over the pages of a file (LibreOffice 24.2 on Ubuntu gives 1 to 2, the macOS build 5). */
const MAX_MEDIAN_TOP_OFFSET = 8;

const converted = new Map<string, Promise<{ source: Buffer; docx: Buffer }>>();

function convertedSample(ctx: { skip: () => never }, id: string): Promise<{ source: Buffer; docx: Buffer }> {
  let result = converted.get(id);
  if (!result) {
    result = requireRealworldSample(ctx, id).then(async ({ bytes }) => ({ source: bytes, docx: (await convertFile(bytes, 'pdf', 'docx', {}, id)).buffer }));
    converted.set(id, result);
  }
  return result;
}

function withFiles<T>(files: Record<string, Buffer>, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-docx-pages-'));
  try {
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pdfInfo(file: string): { pages: number; width: number; height: number } {
  const text = execFileSync(requireOracleTool('pdfinfo'), [file], { encoding: 'utf8' });
  const pages = Number(/^Pages:\s+(\d+)/m.exec(text)?.[1]);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(text);
  return { pages, width: Number(size?.[1]), height: Number(size?.[2]) };
}

/** The y of the top of the first word of each page, by Poppler's word boxes. */
function firstLineTops(file: string, pages: number): number[] {
  const tops: number[] = [];
  for (let page = 1; page <= pages; page++) {
    const boxes = execFileSync(requireOracleTool('pdftotext'), ['-bbox', '-f', String(page), '-l', String(page), file, '-'], { encoding: 'utf8' });
    const ys = [...boxes.matchAll(/yMin="([\d.]+)"/g)].map((match) => Number(match[1]));
    tops.push(ys.length > 0 ? Math.min(...ys) : Number.NaN);
  }
  return tops;
}

/** The last two words of every line of the first pages that has three words or more, as a multiset, by Poppler's line boxes. */
function lineEnds(file: string): Map<string, number> {
  const boxes = execFileSync(requireOracleTool('pdftotext'), ['-q', '-f', '1', '-l', String(LINE_END_PAGES), '-bbox-layout', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ends = new Map<string, number>();
  for (const line of boxes.matchAll(/<line [^>]*>(.*?)<\/line>/gs)) {
    const lineWords = [...line[1].matchAll(/<word [^>]*>([^<]*)<\/word>/g)].map((match) => match[1].toLowerCase().replace(/\W/g, '')).filter((word) => word !== '');
    if (lineWords.length >= 3) ends.set(lineWords.slice(-2).join(' '), (ends.get(lineWords.slice(-2).join(' ')) ?? 0) + 1);
  }
  return ends;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/\w+/g) ?? [];
}

function recall(expected: string[], actual: string[]): number {
  const counts = new Map<string, number>();
  for (const word of actual) counts.set(word, (counts.get(word) ?? 0) + 1);
  let found = 0;
  for (const word of expected) {
    const left = counts.get(word) ?? 0;
    if (left > 0) {
      found++;
      counts.set(word, left - 1);
    }
  }
  return found / expected.length;
}

async function documentXml(docx: Buffer): Promise<string> {
  return (await (await JSZip.loadAsync(docx)).file('word/document.xml')?.async('string')) ?? '';
}

describe('a section for every page of the PDF', () => {
  for (const id of SAMPLES) {
    oracleTest(`${id}: one section on a new page for each page, each with the size of the PDF's page`, ['pdfinfo'], async (ctx) => {
      const { source, docx } = await convertedSample(ctx, id);
      const info = withFiles({ 'in.pdf': source }, (dir) => pdfInfo(path.join(dir, 'in.pdf')));
      const xml = await documentXml(docx);
      const sections = xml.match(/<w:sectPr>.*?<\/w:sectPr>/g) ?? [];
      // The pages are the sections that start a page; a change of columns inside a page is a continuous section.
      expect(sections.filter((section) => section.includes('<w:type w:val="nextPage"/>'))).toHaveLength(info.pages - 1);
      for (const section of sections) {
        const size = /<w:pgSz w:w="(\d+)" w:h="(\d+)"/.exec(section);
        expect(Math.abs(Number(size?.[1]) - info.width * TWIPS_PER_POINT)).toBeLessThanOrEqual(TWIPS_PER_POINT);
        expect(Math.abs(Number(size?.[2]) - info.height * TWIPS_PER_POINT)).toBeLessThanOrEqual(TWIPS_PER_POINT);
      }
    });
  }
});

describe('LibreOffice lays the DOCX out on the pages of the PDF', () => {
  for (const id of SAMPLES) {
    oracleTest(
      `${id}: as many pages as the PDF, and the first line of each page where the PDF has it`,
      ['soffice', 'pdfinfo', 'pdftotext'],
      async (ctx) => {
        const { source, docx } = await convertedSample(ctx, id);
        withFiles({ 'in.pdf': source, 'out.docx': docx }, (dir) => {
          execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pdf', '--outdir', path.join(dir, 'render'), path.join(dir, 'out.docx')], {
            timeout: SOFFICE_TIMEOUT_MS,
            stdio: 'ignore',
          });
          const expected = pdfInfo(path.join(dir, 'in.pdf'));
          const rendered = pdfInfo(path.join(dir, 'render', 'out.pdf'));
          expect(rendered.pages).toBe(expected.pages);
          const wanted = firstLineTops(path.join(dir, 'in.pdf'), expected.pages);
          const got = firstLineTops(path.join(dir, 'render', 'out.pdf'), rendered.pages);
          const offsets = wanted.map((top, index) => Math.abs(top - got[index])).sort((a, b) => a - b);
          expect(offsets[offsets.length >> 1]).toBeLessThanOrEqual(MAX_MEDIAN_TOP_OFFSET);
        });
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('LibreOffice breaks the lines where the PDF did', () => {
  for (const { id, min } of WRAPPED) {
    oracleTest(
      `${id}: at least ${min} of the line ends of the PDF are line ends of the render`,
      ['soffice', 'pdftotext'],
      async (ctx) => {
        const { source, docx } = await convertedSample(ctx, id);
        withFiles({ 'in.pdf': source, 'out.docx': docx }, (dir) => {
          execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pdf', '--outdir', path.join(dir, 'render'), path.join(dir, 'out.docx')], {
            timeout: SOFFICE_TIMEOUT_MS,
            stdio: 'ignore',
          });
          const wanted = lineEnds(path.join(dir, 'in.pdf'));
          const got = lineEnds(path.join(dir, 'render', 'out.pdf'));
          let total = 0;
          let shared = 0;
          for (const [end, count] of wanted) {
            total += count;
            shared += Math.min(count, got.get(end) ?? 0);
          }
          expect(shared / total).toBeGreaterThanOrEqual(min);
        });
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('a page set in a narrower face than the writer\'s', () => {
  // The newsletter's runs are 0.96 of the width the writer's face gives the same text at their low quantile (the PDF sets its pairs tighter): at the writer's own widths its columns run onto a ninth page.
  oracleTest(
    'govdocs1-000135.pdf: the glyphs are set at their share of the writer\'s width, and the render has the pages of the PDF',
    ['soffice', 'pdfinfo'],
    async (ctx) => {
      const { source, docx } = await convertedSample(ctx, 'govdocs1-000135.pdf');
      expect(await documentXml(docx)).toMatch(/<w:w w:val="\d+"\/>/);
      withFiles({ 'in.pdf': source, 'out.docx': docx }, (dir) => {
        execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pdf', '--outdir', path.join(dir, 'render'), path.join(dir, 'out.docx')], {
          timeout: SOFFICE_TIMEOUT_MS,
          stdio: 'ignore',
        });
        expect(pdfInfo(path.join(dir, 'render', 'out.pdf')).pages).toBe(pdfInfo(path.join(dir, 'in.pdf')).pages);
      });
    },
    TEST_TIMEOUT_MS
  );
});

describe('the words stay', () => {
  for (const id of SAMPLES) {
    oracleTest(`${id}: at least ${MIN_WORD_RECALL} of the words pdftotext reads from the PDF are in the DOCX`, ['pdftotext'], async (ctx) => {
      const { source, docx } = await convertedSample(ctx, id);
      const read = withFiles({ 'in.pdf': source }, (dir) => execFileSync(requireOracleTool('pdftotext'), ['-q', '-enc', 'UTF-8', path.join(dir, 'in.pdf'), '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
      const xml = await documentXml(docx);
      const text = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')).join(' ');
      expect(recall(words(read), words(text))).toBeGreaterThanOrEqual(MIN_WORD_RECALL);
    });
  }
});

describe('what the pages need to be set as the page set them', () => {
  oracleTest('every part of the DOCX of each file is well-formed XML (xmllint), and a picture is set at its place on the page', ['xmllint'], async (ctx) => {
    for (const id of SAMPLES) {
      const { docx } = await convertedSample(ctx, id);
      const zip = await JSZip.loadAsync(docx);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-docx-pages-xml-'));
      try {
        for (const entry of Object.keys(zip.files).filter((name) => /\.(xml|rels)$/.test(name))) {
          const file = path.join(dir, entry.replace(/\//g, '_'));
          fs.writeFileSync(file, await (zip.file(entry) as JSZip.JSZipObject).async('nodebuffer'));
          execFileSync(requireOracleTool('xmllint'), ['--noout', file]);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    // The chronology's letterhead is a picture that stood beside the text of its page, so the DOCX sets it there and no text moves for it.
    const xml = await documentXml((await convertedSample(ctx, 'govdocs1-001946.pdf')).docx);
    const pictures = xml.split('<w:drawing>').filter((drawing) => drawing.includes('<pic:pic>'));
    expect(pictures.length).toBeGreaterThanOrEqual(1);
    expect(pictures.filter((drawing) => drawing.startsWith('<wp:anchor ')).length).toBe(pictures.length);
  });

  oracleTest(
    'govdocs1-000353.pdf and govdocs1-000618.pdf: footnote superscripts and page-anchored figures keep the PDF page count',
    ['soffice', 'pdfinfo'],
    async (ctx) => {
      const opinion = await convertedSample(ctx, 'govdocs1-000353.pdf');
      expect(await documentXml(opinion.docx)).toContain('<w:vertAlign w:val="superscript"/>');
      const review = await convertedSample(ctx, 'govdocs1-000618.pdf');
      for (const [id, sample] of [['opinion', opinion], ['review', review]] as const) {
        withFiles({ 'in.pdf': sample.source, 'out.docx': sample.docx }, (dir) => {
          execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pdf', '--outdir', path.join(dir, 'render'), path.join(dir, 'out.docx')], {
            timeout: SOFFICE_TIMEOUT_MS,
            stdio: 'ignore',
          });
          expect(pdfInfo(path.join(dir, 'render', 'out.pdf')).pages, id).toBe(pdfInfo(path.join(dir, 'in.pdf')).pages);
        });
      }
    },
    TEST_TIMEOUT_MS
  );
});
