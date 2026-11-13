import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions/index';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { cer } from './helpers/pdf-text-metrics';
import { rawPdf, type RawPage } from './helpers/raw-pdf';

/**
 * PDF to PPTX keeps the pages: one slide for each page, as large as the page, with the lines of text, the tables and the pictures where
 * the page has them. The documents are the ones whose content is known from the sources they were set from (tests/fixtures/pdf-structure,
 * tests/fixtures/pdf-text). The package is read by its XML, by LibreOffice (a PPTX -> PDF round trip read with pdftotext) and by the
 * presentation reader of this project.
 */

const STRUCTURE = path.join(__dirname, 'fixtures', 'pdf-structure');
const TEXT = path.join(__dirname, 'fixtures', 'pdf-text');
const EMU_PER_POINT = 12_700;
const MAX_ROUND_TRIP_CER = 0.03;
const SOFFICE_TIMEOUT_MS = 240_000;
const ROUND_TRIP_TEST_TIMEOUT_MS = 300_000;
/** The slides may stand this far (EMU) outside the page: a line box is the line's, and the last line of a page ends at its edge. */
const BOUNDS_SLACK_EMU = 2 * EMU_PER_POINT;

interface Truth {
  blocks: { type: string; text?: string; rows?: string[][]; items?: string[] }[];
}

const truthOf = (name: string): Truth => JSON.parse(fs.readFileSync(path.join(STRUCTURE, `${name}.truth.json`), 'utf8')) as Truth;

const converted = new Map<string, Promise<Buffer>>();
function pptxOf(directory: string, name: string): Promise<Buffer> {
  const key = `${directory}/${name}`;
  let result = converted.get(key);
  if (!result) {
    result = convertFile(fs.readFileSync(path.join(directory, `${name}.pdf`)), 'pdf', 'pptx', {}, `${name}.pdf`).then((out) => out.buffer);
    converted.set(key, result);
  }
  return result;
}

async function partOf(pptx: Buffer, entry: string): Promise<string> {
  const zip = await JSZip.loadAsync(pptx);
  const file = zip.file(entry);
  if (!file) throw new Error(`the package has no ${entry}`);
  return file.async('string');
}

async function slidesOf(pptx: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(pptx);
  const names = Object.keys(zip.files)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  return Promise.all(names.map((entry) => (zip.file(entry) as JSZip.JSZipObject).async('string')));
}

const textsOf = (slide: string): string[] => [...slide.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function truthText(truth: Truth): string {
  return truth.blocks
    .map((block) => (block.type === 'table' ? (block.rows ?? []).flat().join(' ') : block.type === 'list' ? (block.items ?? []).join(' ') : (block.text ?? '')))
    .join(' ');
}

describe('the pages become slides', () => {
  it('writes one slide for each page, as large as the page', async () => {
    const multipage = await pptxOf(TEXT, 'multipage');
    expect(await slidesOf(multipage)).toHaveLength(3);
    const presentation = await partOf(multipage, 'ppt/presentation.xml');
    // A Letter or A4 page in points, times 12,700 EMU a point.
    const size = /<p:sldSz cx="(\d+)" cy="(\d+)"\/>/.exec(presentation);
    expect(size).not.toBeNull();
    const [cx, cy] = [Number(size?.[1]), Number(size?.[2])];
    expect(cx / EMU_PER_POINT).toBeGreaterThan(590);
    expect(cx / EMU_PER_POINT).toBeLessThan(600);
    expect(cy / EMU_PER_POINT).toBeGreaterThan(838);
    expect(cy / EMU_PER_POINT).toBeLessThan(845);
  });

  it('does not cut a page into chunks of five lines or leave Markdown marks in the text', async () => {
    const slides = await slidesOf(await pptxOf(STRUCTURE, 'doc-03'));
    expect(slides).toHaveLength(1);
    const texts = slides.flatMap(textsOf);
    expect(texts.filter((text) => /^\s*(#{1,6}\s|\|.*\||---)/.test(text))).toEqual([]);
  });

  it('puts every shape inside its slide', async () => {
    for (const name of ['doc-03', 'doc-04', 'doc-09']) {
      const pptx = await pptxOf(STRUCTURE, name);
      const presentation = await partOf(pptx, 'ppt/presentation.xml');
      const size = /<p:sldSz cx="(\d+)" cy="(\d+)"\/>/.exec(presentation) as RegExpExecArray;
      const [cx, cy] = [Number(size[1]), Number(size[2])];
      for (const slide of await slidesOf(pptx)) {
        for (const match of slide.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)) {
          const [x, y, width, height] = match.slice(1).map(Number);
          if (width === 0 && height === 0) continue;
          expect(x, `${name} x`).toBeGreaterThanOrEqual(-BOUNDS_SLACK_EMU);
          expect(y, `${name} y`).toBeGreaterThanOrEqual(-BOUNDS_SLACK_EMU);
          expect(x + width, `${name} right edge`).toBeLessThanOrEqual(cx + BOUNDS_SLACK_EMU * 8);
          expect(y + height, `${name} bottom edge`).toBeLessThanOrEqual(cy + BOUNDS_SLACK_EMU);
        }
      }
    }
  });

  it('writes the words of the source, each once, in the document of known text', async () => {
    for (const name of ['doc-01', 'doc-03', 'doc-07']) {
      const slideWords = (await slidesOf(await pptxOf(STRUCTURE, name))).flatMap(textsOf).flatMap(words);
      const expected = words(truthText(truthOf(name)));
      const count = (list: string[]): Map<string, number> => list.reduce((map, word) => map.set(word, (map.get(word) ?? 0) + 1), new Map<string, number>());
      const got = count(slideWords);
      const missing = [...count(expected)].filter(([word, times]) => (got.get(word) ?? 0) < times).map(([word]) => word);
      expect({ name, missing }).toEqual({ name, missing: [] });
    }
  });

  it('keeps a hyphenated word as the page breaks it', async () => {
    const lines = (await slidesOf(await pptxOf(TEXT, 'hyphenated'))).flatMap(textsOf);
    // The words of the page are written as set: a line that ends in a hyphen stays a line that ends in a hyphen.
    expect(lines.some((line) => line.trimEnd().endsWith('-'))).toBe(true);
  });
});

describe('what is on the page stays an object of the slide', () => {
  it('writes a table of the page as a table', async () => {
    const slide = (await slidesOf(await pptxOf(STRUCTURE, 'doc-03')))[0];
    const table = /<a:tbl>.*?<\/a:tbl>/s.exec(slide)?.[0] ?? '';
    expect(table).not.toBe('');
    const truth = truthOf('doc-03').blocks.find((block) => block.type === 'table');
    expect(table.match(/<a:tr /g)?.length).toBe(truth?.rows?.length);
    expect(table.match(/<a:gridCol /g)?.length).toBe(truth?.rows?.[0].length);
    expect(textsOf(table).join(' ')).toContain('gamma');
  });

  it('places a picture of the page with its file in the package', async () => {
    const pptx = await pptxOf(STRUCTURE, 'doc-04');
    const zip = await JSZip.loadAsync(pptx);
    const slides = await slidesOf(pptx);
    const pictures = slides.flatMap((slide) => [...slide.matchAll(/<p:pic>.*?<a:blip r:embed="(rId\d+)"\/>/gs)].map((match) => match[1]));
    expect(pictures.length).toBeGreaterThanOrEqual(1);
    const media = Object.keys(zip.files).filter((entry) => entry.startsWith('ppt/media/'));
    expect(media.length).toBeGreaterThanOrEqual(1);
    const slideNumber = slides.findIndex((slide) => slide.includes('<p:pic>')) + 1;
    const relationships = await partOf(pptx, `ppt/slides/_rels/slide${slideNumber}.xml.rels`);
    expect(relationships).toContain(`Id="${pictures[0]}"`);
    expect(relationships).toMatch(/Target="\.\.\/media\/image\d+\.(png|jpeg)"/);
  });

  it('writes the lines of a right-to-left page right to left, and only those', async () => {
    const slide = (await slidesOf(await pptxOf(TEXT, 'rtl')))[0];
    const shapes = [...slide.matchAll(/<p:sp>.*?<\/p:sp>/gs)].map((match) => match[0]);
    const rightToLeft = shapes.filter((shape) => shape.includes('rtl="1"') && shape.includes('algn="r"')).flatMap(textsOf);
    const rightToLeftScript = shapes.flatMap(textsOf).filter((text) => /[\u0590-\u08FF]/.test(text));
    expect(rightToLeft.length).toBeGreaterThan(0);
    expect(rightToLeft).toEqual(rightToLeftScript);
  });
});

describe('the package is one PowerPoint opens', () => {
  it('has the parts a presentation needs and every relationship points at a part that exists', async () => {
    const pptx = await pptxOf(STRUCTURE, 'doc-04');
    const zip = await JSZip.loadAsync(pptx);
    const entries = new Set(Object.keys(zip.files));
    for (const required of ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml']) {
      expect(entries.has(required), required).toBe(true);
    }
    expect(await partOf(pptx, 'ppt/presentation.xml')).toContain('<p:sldMasterIdLst>');
    const contentTypes = await partOf(pptx, '[Content_Types].xml');
    for (const entry of entries) {
      if (/^ppt\/(slides|slideMasters|slideLayouts|theme)\/[^/]+\.xml$/.test(entry)) expect(contentTypes, entry).toContain(`PartName="/${entry}"`);
    }
    for (const entry of entries) {
      if (!entry.endsWith('.rels')) continue;
      const base = path.posix.dirname(path.posix.dirname(entry));
      for (const match of (await partOf(pptx, entry)).matchAll(/Target="([^"]+)"/g)) {
        const target = path.posix.normalize(path.posix.join(base === '.' ? '' : base, match[1]));
        expect(entries.has(target), `${entry} -> ${target}`).toBe(true);
      }
    }
    // Every slide names its layout, as the specification requires of a slide part.
    for (const entry of entries) {
      if (/^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(entry)) expect(await partOf(pptx, entry)).toContain('slideLayout');
    }
  });

  oracleTest('every part is well-formed XML 1.0 (xmllint)', ['xmllint'], async () => {
    const zip = await JSZip.loadAsync(await pptxOf(STRUCTURE, 'doc-04'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-pptx-xml-'));
    try {
      for (const entry of Object.keys(zip.files).filter((name) => /\.(xml|rels)$/.test(name))) {
        const file = path.join(dir, entry.replace(/\//g, '_'));
        fs.writeFileSync(file, await (zip.file(entry) as JSZip.JSZipObject).async('nodebuffer'));
        execFileSync(requireOracleTool('xmllint'), ['--noout', file]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is read by the presentation reader of this project with the words of the page', async () => {
    const pptx = await pptxOf(TEXT, 'latin');
    const text = (await convertFile(pptx, 'pptx', 'txt', {}, 'latin.pptx')).buffer.toString('utf8');
    const expected = fs.readFileSync(path.join(TEXT, 'latin.truth.txt'), 'utf8');
    const got = new Set(words(text));
    expect(words(expected).filter((word) => !got.has(word))).toEqual([]);
  });
});

describe('LibreOffice reads the result', () => {
  oracleTest(
    'the slides render to PDF pages with the text of the source (character error rate at most 0.03)',
    ['soffice', 'pdftotext'],
    async () => {
      const names = ['doc-01', 'doc-03', 'doc-04', 'doc-07'];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-pptx-roundtrip-'));
      try {
        for (const name of names) fs.writeFileSync(path.join(dir, `${name}.pptx`), await pptxOf(STRUCTURE, name));
        execFileSync(
          requireOracleTool('soffice'),
          ['--headless', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pdf', '--outdir', dir, ...names.map((name) => path.join(dir, `${name}.pptx`))],
          { timeout: SOFFICE_TIMEOUT_MS, stdio: 'ignore' }
        );
        const errors: Record<string, number> = {};
        for (const name of names) {
          const rendered = execFileSync(requireOracleTool('pdftotext'), ['-raw', '-enc', 'UTF-8', path.join(dir, `${name}.pdf`), '-'], { encoding: 'utf8' });
          errors[name] = Math.round(cer(truthText(truthOf(name)), rendered) * 1000) / 1000;
        }
        const worst = Math.max(...Object.values(errors));
        expect({ worst: worst <= MAX_ROUND_TRIP_CER, errors: worst <= MAX_ROUND_TRIP_CER ? undefined : errors }).toEqual({ worst: true, errors: undefined });
        // One page of the source is one page of the rendering.
        for (const name of names) {
          const pages = /Pages:\s+(\d+)/.exec(execFileSync(requireOracleTool('pdfinfo'), [path.join(dir, `${name}.pdf`)], { encoding: 'utf8' }))?.[1];
          const sourcePages = /Pages:\s+(\d+)/.exec(execFileSync(requireOracleTool('pdfinfo'), [path.join(STRUCTURE, `${name}.pdf`)], { encoding: 'utf8' }))?.[1];
          expect({ name, pages }).toEqual({ name, pages: sourcePages });
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ROUND_TRIP_TEST_TIMEOUT_MS
  );
});

describe('pages of unusual sizes and text that XML cannot carry', () => {
  const textPage = (width: number, height: number, shown: string, size = 14): RawPage => ({ width, height, content: `BT /F1 ${size} Tf 20 ${Math.round(height / 2)} Td (${shown}) Tj ET` });
  const slideSizeOf = async (pptx: Buffer): Promise<{ cx: number; cy: number }> => {
    const match = /<p:sldSz cx="(\d+)" cy="(\d+)"\/>/.exec(await partOf(pptx, 'ppt/presentation.xml')) as RegExpExecArray;
    return { cx: Number(match[1]), cy: Number(match[2]) };
  };
  const convert = async (pages: RawPage[]): Promise<Buffer> => (await convertFile(rawPdf(pages), 'pdf', 'pptx', {}, 'sized.pdf')).buffer;
  const MIN_SLIDE_EMU = 914_400;
  const MAX_SLIDE_EMU = 51_206_400;

  it('keeps the slide inside the sizes PowerPoint accepts for a page smaller than an inch or larger than 56 inches', async () => {
    const tiny = await slideSizeOf(await convert([textPage(40, 30, 'tiny', 6)]));
    expect(Math.min(tiny.cx, tiny.cy)).toBeGreaterThanOrEqual(MIN_SLIDE_EMU);
    const huge = await slideSizeOf(await convert([textPage(20_000, 10_000, 'huge', 400)]));
    expect(Math.max(huge.cx, huge.cy)).toBeLessThanOrEqual(MAX_SLIDE_EMU);
    // The proportions of the page are the proportions of the slide.
    expect(huge.cx / huge.cy).toBeCloseTo(2, 2);
    expect(tiny.cx / tiny.cy).toBeCloseTo(40 / 30, 2);
  });

  it('scales a page of another size than the first onto the first slide size and keeps its text inside', async () => {
    const pptx = await convert([textPage(400, 200, 'wide page'), textPage(200, 400, 'tall page')]);
    const { cx, cy } = await slideSizeOf(pptx);
    expect(cx / cy).toBeCloseTo(2, 2);
    const [, second] = await slidesOf(pptx);
    const [x, y, width, height] = (/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(second.slice(second.indexOf('<p:sp>'))) as RegExpExecArray).slice(1).map(Number);
    expect(x).toBeGreaterThan(0);
    expect(x + width).toBeLessThanOrEqual(cx);
    expect(y + height).toBeLessThanOrEqual(cy);
    expect(textsOf(second).join(' ')).toBe('tall page');
  });

  it('writes the characters of the markup as text and leaves no control character in a part', async () => {
    const pptx = await convert([textPage(400, 200, 'Fish \\& Chips <b> \\(A\\)')]);
    const slide = (await slidesOf(pptx))[0];
    expect(slide).toContain('Fish &amp; Chips &lt;b&gt; (A)');
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(slide)).toBe(false);
  });
});
