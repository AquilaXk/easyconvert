import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { convertData } from '../src/lib/conversions/data';
import { convertDocument } from '../src/lib/conversions/document';
import { convertOffice } from '../src/lib/conversions/office';
import { FontCoverageError, PayloadLimitError, ShapingLimitError } from '../src/lib/types';
import { itemizeParagraph, visualOrder } from '../src/lib/conversions/text-shaping/itemize';
import { breakOpportunities } from '../src/lib/conversions/text-shaping/linebreak';
import { SHAPE_MAX_CODEPOINTS, SHAPE_MAX_GLYPHS_PER_DOCUMENT, SHAPE_MAX_PARAGRAPH_CODEPOINTS, ShapingBudget } from '../src/lib/conversions/text-shaping/limits';
import { loadTextShaper, shapeRun } from '../src/lib/conversions/text-shaping/shape';
import { fontRangesForShaping, loadFontCoverageIndex } from '../src/lib/conversions/pdf-fonts';
import { oracleTest } from './helpers/oracle-test';
import { extractFontsWithExternalPdffonts, requireOracleTool } from './helpers/differential-oracle';
import { cer } from './helpers/pdf-text-metrics';
import { computeSsim } from './helpers/vrt-engine';
import { skipUnless } from './helpers/strict-skip';
import { expectNoHang } from './helpers/timing';
import { pdfWords } from './helpers/pdftotext-bbox';

/**
 * In-process shaping, bidi reordering and line breaking for Arabic, Hebrew, Hindi, Thai, Korean and Japanese text.
 * Independent readers: Poppler (pdftotext, pdffonts, pdftoppm), a LibreOffice rendering of the same text for the
 * image comparison, and hand-written expectations for the Unicode algorithms. The paragraphs below were written for
 * this repository.
 */

interface Sample {
  readonly name: string;
  readonly text: string;
  /** Right-to-left paragraph. */
  readonly rtl: boolean;
  /** Family the LibreOffice reference rendering sets the text in. */
  readonly referenceFamily: string;
}

/** Six paragraphs written for this repository; see the PROVENANCE.md next to the file. */
const SAMPLES: readonly Sample[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'complex-script', 'samples.json'), 'utf-8')
) as Sample[];

/** Hand-segmented Thai text: each element is one word, so the line breaks must fall between them. */
const THAI_WORDS: readonly string[] = [
  'สวัสดี', 'ชาว', 'โลก', 'ยินดี', 'ต้อนรับ', 'สู่', 'ระบบ', 'แปลง', 'ไฟล์', 'ที่', 'ทำงาน', 'ได้', 'โดย', 'ไม่', 'ต้อง', 'พึ่ง', 'โปรแกรม', 'ภายนอก',
  'และ', 'ตัด', 'บรรทัด', 'ตาม', 'พจนานุกรม', 'คำ', 'ไทย', 'ได้', 'อย่าง', 'ถูกต้อง', 'ข้อความ', 'นี้', 'ยาว', 'พอ', 'ที่จะ', 'ขึ้น', 'บรรทัด', 'ใหม่',
  'หลาย', 'ครั้ง', 'เพื่อ', 'ทดสอบ', 'การ', 'แบ่ง', 'คำ',
];

const TEST_TIMEOUT_MS = 180_000;
const SOFFICE_TIMEOUT_MS = 120_000;
const RENDER_DPI = '100';
const MIN_SSIM = 0.95;
const MAX_CER = 0.02;
const RGBA_CHANNELS = 4;
/** Font size and line pitch the in-process writer uses for plain text, in points. */
const REFERENCE_FONT_SIZE_PT = 10;
const REFERENCE_PAGE_MARGIN_PT = 50;
const REFERENCE_LINE_HEIGHT = 1.5;
const HANG_GUARD_MS = 30_000;

/** Bidi marks and embedding controls that text extraction adds around right-to-left lines. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

function normalized(text: string): string {
  return text.normalize('NFC').replace(FORMAT_CHARACTERS, '').replace(/\s+/g, ' ').trim();
}

function withoutSpaces(text: string): string {
  return normalized(text).replace(/ /g, '');
}

let work = '';
beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-shaping-'));
  await loadFontCoverageIndex();
});
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function pdftotext(pdf: Buffer, args: string[] = []): string {
  const file = path.join(work, `extract-${process.hrtime.bigint()}.pdf`);
  fs.writeFileSync(file, pdf);
  return execFileSync(requireOracleTool('pdftotext'), ['-q', ...args, file, '-'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

async function textToPdf(text: string, source: 'txt' | 'md' = 'txt'): Promise<Buffer> {
  return (await convertDocument(Buffer.from(text, 'utf-8'), source, 'pdf', {}, `sample.${source}`)).buffer;
}

/** A minimal WordprocessingML package, written here with JSZip and no production code. */
async function docxOf(paragraphs: readonly string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe.each(SAMPLES)('$name paragraph to PDF', (sample) => {
  oracleTest(
    'comes back from pdftotext in logical order with every font embedded',
    ['pdftotext', 'pdffonts'],
    async () => {
      const pdf = await textToPdf(sample.text);
      const extracted = pdftotext(pdf);
      expect(cer(withoutSpaces(sample.text), withoutSpaces(extracted))).toBeLessThanOrEqual(MAX_CER);
      const fonts = extractFontsWithExternalPdffonts(pdf);
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts.map((font) => ({ emb: font.emb, sub: font.sub, uni: font.uni }))).toEqual(
        fonts.map(() => ({ emb: true, sub: true, uni: true }))
      );
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'matches the same text set by LibreOffice: SSIM 0.95 and no more extraction errors than the reference',
    ['soffice', 'pdftoppm', 'pdftotext', 'pdffonts', 'fc-list'],
    async () => {
      const pdf = await textToPdf(sample.text);
      const fonts = extractFontsWithExternalPdffonts(pdf);
      const family = scriptFamilyOf(fonts.map((font) => font.name), sample.text);
      const reference = referencePdf(sample, family);
      const ours = await rasterize(pdf, `${sample.name}-ours`);
      const theirs = await rasterize(reference, `${sample.name}-reference`);
      expect(ours.width).toBe(theirs.width);
      expect(ours.height).toBe(theirs.height);
      expect(computeSsim(ours.data, theirs.data, ours.width, ours.height, RGBA_CHANNELS)).toBeGreaterThanOrEqual(MIN_SSIM);
      // The same extraction tool reads both files; ours is at least as faithful to the source text.
      const ourCer = cer(withoutSpaces(sample.text), withoutSpaces(pdftotext(pdf)));
      const referenceCer = cer(withoutSpaces(sample.text), withoutSpaces(pdftotext(reference)));
      expect(ourCer).toBeLessThanOrEqual(referenceCer);
    },
    TEST_TIMEOUT_MS
  );
});

/** The family of the embedded font that has the first non-Latin letter of the text: the font of the script itself. */
function scriptFamilyOf(embeddedNames: readonly string[], text: string): string {
  const letter = /[^\x00-\x7F]/u.exec(text)?.[0];
  if (letter === undefined) throw new Error('the sample has no non-ASCII letter');
  const embedded = new Set(embeddedNames.map((name) => name.replace(/^[A-Z]{6}\+/, '')));
  const codePoint = (letter.codePointAt(0) as number).toString(16);
  const listing = execFileSync(requireOracleTool('fc-list'), [`:charset=${codePoint}`, '--format', '%{postscriptname}|%{family[0]}\n'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of listing.split('\n')) {
    const [postScript, family] = line.split('|');
    if (postScript && family && embedded.has(postScript)) return family;
  }
  throw new Error(`fontconfig lists none of the embedded fonts ${[...embedded].join(', ')} for U+${codePoint}`);
}

function referencePdf(sample: Sample, family: string): Buffer {
  const dir = fs.mkdtempSync(path.join(work, 'ref-'));
  const direction = sample.rtl ? ' dir="rtl"' : '';
  const html = `<!DOCTYPE html><html${direction}><head><meta charset="utf-8"><style>@page{size:210mm 297mm;margin:${REFERENCE_PAGE_MARGIN_PT}pt}body{margin:0;font-family:'${family}';font-size:${REFERENCE_FONT_SIZE_PT}pt}p{margin:0;line-height:${REFERENCE_LINE_HEIGHT}}</style></head><body><p>${sample.text}</p></body></html>`;
  const source = path.join(dir, 'reference.html');
  fs.writeFileSync(source, html, 'utf-8');
  execFileSync(
    requireOracleTool('soffice'),
    ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', dir, source],
    { timeout: SOFFICE_TIMEOUT_MS, stdio: 'ignore' }
  );
  return fs.readFileSync(path.join(dir, 'reference.pdf'));
}

async function rasterize(pdf: Buffer, name: string): Promise<{ data: Buffer; width: number; height: number }> {
  const file = path.join(work, `${name}.pdf`);
  fs.writeFileSync(file, pdf);
  const root = path.join(work, name);
  execFileSync(requireOracleTool('pdftoppm'), ['-r', RENDER_DPI, '-png', '-singlefile', file, root]);
  const { data, info } = await sharp(`${root}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

describe('line layout', () => {
  /** Margin of the in-process page, and the tolerance Poppler's word boxes need. */
  const PAGE_MARGIN = 50;
  const BOX_TOLERANCE_PT = 1;

  for (const sample of SAMPLES) {
    oracleTest(`${sample.name} lines stay inside the margins and start at the paragraph's own side`, ['pdftotext'], async () => {
      const file = path.join(work, `${sample.name}-layout.pdf`);
      fs.writeFileSync(file, await textToPdf(sample.text));
      const [page] = pdfWords(file);
      const words = page.words;
      expect(words.length).toBeGreaterThan(0);
      const left = Math.min(...words.map((word) => word.xMin));
      const right = Math.max(...words.map((word) => word.xMax));
      expect(left).toBeGreaterThanOrEqual(PAGE_MARGIN - BOX_TOLERANCE_PT);
      expect(right).toBeLessThanOrEqual(page.width - PAGE_MARGIN + BOX_TOLERANCE_PT);
      // The first line fills the width, so it touches the side the paragraph starts on.
      if (sample.rtl) expect(right).toBeGreaterThanOrEqual(page.width - PAGE_MARGIN - BOX_TOLERANCE_PT);
      else expect(left).toBeLessThanOrEqual(PAGE_MARGIN + BOX_TOLERANCE_PT);
    });
  }

  oracleTest('keeps a hyperlink on shaped text', ['pdftotext'], async () => {
    const pdf = await textToPdf(`[${SAMPLES[0].text.split('.')[0]}](https://example.com/shaped)\n`, 'md');
    expect(/\/URI \(([^)]*)\)/.exec(pdf.toString('latin1'))?.[1]).toBe('https://example.com/shaped');
  });
});

describe('the other in-process writers shape too', () => {
  const arabic = SAMPLES[0].text;
  const hindi = SAMPLES[2].text;

  oracleTest('Markdown to PDF', ['pdftotext'], async () => {
    const pdf = await textToPdf(`# ${hindi.split('।')[0]}\n\n${arabic}\n`, 'md');
    const extracted = withoutSpaces(pdftotext(pdf));
    expect(extracted).toContain(withoutSpaces(arabic));
    expect(extracted).toContain(withoutSpaces(hindi.split('।')[0]));
  }, TEST_TIMEOUT_MS);

  oracleTest('DOCX to PDF', ['pdftotext'], async () => {
    for (const text of [arabic, hindi]) {
      const converted = await convertOffice(await docxOf([text]), 'docx', 'pdf', {}, 'shaped.docx');
      expect(cer(withoutSpaces(text), withoutSpaces(pdftotext(converted.buffer)))).toBeLessThanOrEqual(MAX_CER);
    }
  }, TEST_TIMEOUT_MS);

  oracleTest('CSV to PDF', ['pdftotext'], async () => {
    const csv = Buffer.from(`id,text\n1,${hindi.split('।')[0]}\n2,${arabic.split('.')[0]}\n`, 'utf-8');
    const converted = await convertData(csv, 'csv', 'pdf', {}, 'shaped.csv');
    const extracted = withoutSpaces(pdftotext(converted.buffer));
    expect(extracted).toContain(withoutSpaces(hindi.split('।')[0]));
    expect(extracted).toContain(withoutSpaces(arabic.split('.')[0]));
  }, TEST_TIMEOUT_MS);
});

describe('Thai line breaking', () => {
  oracleTest('breaks lines only between words of the hand-segmented text', ['pdftotext'], async () => {
    const text = THAI_WORDS.join('');
    const pdf = await textToPdf(text);
    const lines = pdftotext(pdf, ['-raw']).split('\n').map((line) => line.normalize('NFC').replace(FORMAT_CHARACTERS, '').replace(/\s+/g, '')).filter((line) => line !== '');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(text.normalize('NFC').replace(/\s+/g, ''));
    const boundaries = new Set<number>();
    let offset = 0;
    for (const word of THAI_WORDS) {
      offset += word.length;
      boundaries.add(offset);
    }
    let cut = 0;
    const breaks: number[] = [];
    for (const line of lines.slice(0, -1)) {
      cut += line.length;
      breaks.push(cut);
    }
    expect(breaks.filter((position) => !boundaries.has(position))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('finds the dictionary word boundaries of a hand-segmented phrase', () => {
    const words = ['สวัสดี', 'ชาว', 'โลก', 'ยินดี', 'ต้อนรับ'];
    const expected: number[] = [];
    let offset = 0;
    for (const word of words.slice(0, -1)) {
      offset += word.length;
      expected.push(offset);
    }
    expect(breakOpportunities(words.join('')).map((opportunity) => opportunity.offset)).toEqual(expected);
  });
});

describe('Unicode algorithms against hand-worked cases', () => {
  it('itemizes mixed text by bidi level and script (UAX #9 and #24)', () => {
    // "abc " is left to right; the Arabic word and the space after it are level 1; the digits after right-to-left
    // text are European numbers at level 2 (rule I1), and take the script of the text before them.
    const { runs, baseLevel } = itemizeParagraph('abc مرحبا 123');
    expect(baseLevel).toBe(0);
    expect(runs).toEqual([
      { start: 0, end: 4, level: 0, script: 'Latn' },
      { start: 4, end: 10, level: 1, script: 'Arab' },
      { start: 10, end: 13, level: 2, script: 'Arab' },
    ]);
  });

  it('takes a right-to-left paragraph level from the first strong character', () => {
    expect(itemizeParagraph('שלום world').baseLevel).toBe(1);
    expect(itemizeParagraph('hello עולם').baseLevel).toBe(0);
  });

  it('reorders the pieces of a line by rule L2 of UAX #9', () => {
    expect(visualOrder([0, 0, 1, 1, 0])).toEqual([0, 1, 3, 2, 4]);
    expect(visualOrder([0, 1, 2, 2, 1, 0])).toEqual([0, 4, 2, 3, 1, 5]);
    expect(visualOrder([1, 1, 1])).toEqual([2, 1, 0]);
    expect(visualOrder([0, 0])).toEqual([0, 1]);
  });

  it('finds the break opportunities of UAX #14 after spaces and hyphens', () => {
    expect(breakOpportunities('foo bar-baz qux').map((opportunity) => opportunity.offset)).toEqual([4, 8, 12]);
  });
});

describe('hostile input', () => {
  it('refuses a paragraph past the paragraph cap with a 413', () => {
    const error = (() => {
      try {
        itemizeParagraph('ا'.repeat(SHAPE_MAX_PARAGRAPH_CODEPOINTS + 1));
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(ShapingLimitError);
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect((error as ShapingLimitError).status).toBe(413);
  });

  it('cuts a long run so that no shaping call passes the cap, without losing a character', () => {
    const length = SHAPE_MAX_CODEPOINTS * 2 + 123;
    const { runs } = itemizeParagraph('ب'.repeat(length));
    expect(runs.map((run) => run.end - run.start).every((size) => size <= SHAPE_MAX_CODEPOINTS)).toBe(true);
    expect(runs.reduce((sum, run) => sum + (run.end - run.start), 0)).toBe(length);
    expect(runs[0].start).toBe(0);
    expect(runs.slice(1).map((run, index) => run.start === runs[index].end)).toEqual(runs.slice(1).map(() => true));
  });

  it('counts glyphs against the document budget and answers 413 past it', () => {
    const budget = new ShapingBudget();
    budget.spend(SHAPE_MAX_GLYPHS_PER_DOCUMENT);
    expect(budget.spent).toBe(SHAPE_MAX_GLYPHS_PER_DOCUMENT);
    expect(() => budget.spend(1)).toThrow(ShapingLimitError);
  });

  oracleTest('lays out a long unbroken Arabic token without hanging and keeps every character', ['pdftotext'], async () => {
    const token = 'كتاب'.repeat(2500);
    const pdf = await expectNoHang('long Arabic token', () => textToPdf(token), HANG_GUARD_MS);
    expect(withoutSpaces(pdftotext(pdf))).toBe(token);
  }, TEST_TIMEOUT_MS);

  oracleTest('lays out a paragraph of many short Devanagari words without hanging', ['pdftotext'], async () => {
    const paragraph = Array.from({ length: 3000 }, (_, index) => `शब्द${index}`).join(' ');
    const pdf = await expectNoHang('many words', () => textToPdf(paragraph), HANG_GUARD_MS);
    // Content-stream order: Poppler's default reading order regroups blocks of a dense page by its own heuristics.
    expect(withoutSpaces(pdftotext(pdf, ['-raw']))).toBe(withoutSpaces(paragraph));
  }, TEST_TIMEOUT_MS);
});

describe('fonts that do not cover the text', () => {
  const DEVANAGARI_KA = 0x0915;

  it('answers FontCoverageError (400) when the font draws a missing-glyph box for a character', async (ctx) => {
    await loadTextShaper();
    const latinFace = fontRangesForShaping('abc')[0]?.face;
    ctx.skip(skipUnless('an installed Latin font without Devanagari glyphs', latinFace !== undefined && !latinFace.font.hasGlyphForCodePoint(DEVANAGARI_KA)));
    if (!latinFace) throw new Error('no installed font covers Latin text');
    let error: unknown = null;
    try {
      shapeRun(latinFace, String.fromCodePoint(DEVANAGARI_KA), 0, 'Deva', new ShapingBudget());
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(FontCoverageError);
    expect((error as FontCoverageError).status).toBe(400);
    expect((error as FontCoverageError).codePoint).toBe(DEVANAGARI_KA);
  });
});
