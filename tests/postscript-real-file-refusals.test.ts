import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { knownRefusal, readKnownRefusals } from '../bench/realworld/report';
import { defaultResolver, EZDXF_PSEUDO_TOOL } from '../bench/tools';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { extractFontsWithExternalPdffonts, extractTextWithExternalPdftotext, getOracleToolPath } from './helpers/differential-oracle';
import { readDxf, withoutGeometry, type DxfDocument } from './helpers/dxf-reader';
import { oracleTest } from './helpers/oracle-test';
import { pdfWords, type PdfWord } from './helpers/pdftotext-bbox';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The PostScript files of the real-world corpus (#783) that the nightly run refused, in two groups.
 *
 * Bitmap fonts. Twelve files are dvips or word-processor output whose text is a Type 3 font of 1-bit pictures. Poppler draws a
 * character of such a font as a rectangle painted through a mask that holds the glyph picture, and a DXF holds no bitmaps. The
 * DXF writer puts the characters back as TEXT in a stock font, as pstoedit does by default, from the PDF's text layer, and
 * reads the pen attributes a DXF cannot hold (dash arrays become line types, strokes under a skew are their centre lines,
 * opacity is dropped): every page of seven files converts, and the other five are refused for something else their pages
 * draw (clip paths, pages past the SVG size limit, a text layer without text), each listed in known-refusals.json. A picture on a
 * page is not one of those: a DXF holds none, the exporters leave it out, and so does the writer (with a warning).
 *
 * Ghostscript. Two files stop the only open-source PostScript interpreter on a value that is legal in an interpreter that is
 * not Ghostscript, in every release from 10.02.1 to the development branch; no argument changes it, and safe mode is not involved.
 */

const BITMAP_GLYPH_REFUSAL = /SVG bitmap glyph|bitmap font/;
const MIN_TEXT_CHARACTERS = 100;
const SAMPLE_TIMEOUT_MS = 180_000;
/**
 * Lowest share of Poppler's words of a page set only in Type 3 fonts that the TEXT entities on their baseline hold, and lowest
 * share of TEXT entities on any page whose characters Poppler reads there (both measured at 1.0 on the three files).
 */
const MIN_WORD_RECALL = 0.95;
const MIN_TEXT_AGREEMENT = 0.95;

/** Every page converts: the bitmap-font text is TEXT and the rest of the page is geometry DXF holds. */
const TEXT_CONVERTED_FILES = [
  'govdocs1-000097.ps',
  'govdocs1-000730.ps',
  'govdocs1-000773.ps',
  'govdocs1-002433.ps',
  'govdocs1-005434.ps',
  'govdocs1-006007.ps',
  'govdocs1-006955.ps',
] as const;

/** The pages (from 1) of each converted file that draw dashed lines, which the writer draws with a line type of the dash array. */
const DASHED_PAGES: Readonly<Record<string, readonly number[]>> = {
  'govdocs1-002433.ps': [3],
  'govdocs1-005434.ps': [12, 13, 14, 15],
  'govdocs1-006955.ps': [2, 3, 5, 7, 8],
};

/** The bitmap-font text is written, but a page also draws something DXF does not hold (known-refusals.json says what). */
const REFUSED_FOR_OTHER_CONTENT = ['govdocs1-002956.ps', 'govdocs1-003229.ps'] as const;

/**
 * Files whose pages draw pictures (Poppler's SVG holds an `<image>`): 004087 also sets pages 1 and 4 in bitmap fonts, 006990 has
 * one picture page of 36 and 000766 is one page of a map. Every page converts and the conversion says the pictures were left out.
 */
const PICTURE_FILES = ['govdocs1-004087.ps', 'govdocs1-006990.ps', 'govdocs1-000766.ps'] as const;
const picturesLeftOutWarning = (pages: readonly number[]): string =>
  `Left out the pictures of ${pages.length === 1 ? 'page' : 'pages'} ${pages.join(', ')}: a DXF holds lines and text and no bitmaps.`;

/**
 * Files whose pages clip their drawing to a rectangle that is not the page. A clip that hides at most a point is dropped
 * (policy 79) and one that hides more cuts the drawing at its edges: page 11 of `001048` reaches 13.2 points past its clip,
 * and pages 20, 43, 50 and 60 of `006137` reach 1.15 to 19.4 points with Poppler 26 (0.86 to 14.6 with Poppler 24), and
 * all were refused before the cut. The pages with a clip are listed; every other page has none.
 */
const CLIPPED_FILES: Readonly<Record<string, readonly number[]>> = {
  'govdocs1-001048.ps': [11],
  'govdocs1-006137.ps': [20, 21, 30, 32, 35, 36, 43, 46, 49, 50, 52, 53, 56, 57, 60, 62],
};

const BITMAP_FONT_FILES = [...TEXT_CONVERTED_FILES, ...REFUSED_FOR_OTHER_CONTENT, 'govdocs1-004087.ps', ...Object.keys(CLIPPED_FILES)];

function describeRefusal(error: unknown): string {
  return `${(error as Error).name}: ${(error as Error).message}`;
}

/** The DXF pages of a conversion: one file, or the ZIP of per-page files in page order. */
async function dxfPages(result: { buffer: Buffer; filename: string }): Promise<string[]> {
  if (!result.filename.endsWith('.zip')) return [result.buffer.toString('utf-8')];
  const zip = await JSZip.loadAsync(result.buffer);
  const names = Object.keys(zip.files).filter((name) => name.endsWith('.dxf')).sort((a, b) => a.localeCompare(b));
  return Promise.all(names.map((name) => zip.files[name].async('string')));
}

/** A TEXT string as a DXF reader shows it: `%%%` is a percent sign, `^ ` a caret, `\U+XXXX` a character (ezdxf tools/text.py, lldxf/encoding.py). */
function decodeTextValue(value: string): string {
  return value
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/%%%/g, '%')
    .replace(/\^ /g, '^');
}

/** Characters a reader writes for a glyph without a Unicode value; the DXF writer writes `#` for such a glyph. */
// eslint-disable-next-line no-control-regex
const UNMAPPED_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD\uE000-\uF8FF]/gu;
/**
 * Where Poppler's word box puts the baseline of a Type 3 font, which has no metrics: Poppler gives such a font an ascent of
 * 0.95 em and a descent of 0.35 em, so the baseline is 0.95 / 1.3 of the way down the box (on govdocs1-000097.ps, page 1,
 * "Status" spans 62.4802 to 91.6002 and its baseline is 83.7602).
 */
const TYPE3_BASELINE_FRACTION = 0.95 / 1.3;
/** A TEXT entity stands on a word's baseline when it is this share of the word's box height away from it, or nearer. */
const BASELINE_MATCH_FRACTION = 0.1;

interface PlacedTextOnPage {
  value: string;
  x0: number;
  x1: number;
  baseline: number;
}

/** The TEXT entities of a DXF page (in points, from the bottom left) in points from the top left, as Poppler gives its words. */
function textsOnPage(dxf: DxfDocument, pageHeight: number): PlacedTextOnPage[] {
  return dxf.texts.map((text) => ({
    value: decodeTextValue(text.value),
    x0: text.insert.x,
    x1: text.alignment?.x ?? text.insert.x,
    baseline: pageHeight - text.insert.y,
  }));
}

function onBaselineOf(word: PdfWord, text: PlacedTextOnPage): boolean {
  const height = word.yMax - word.yMin;
  const baseline = word.yMin + TYPE3_BASELINE_FRACTION * height;
  return Math.abs(text.baseline - baseline) <= BASELINE_MATCH_FRACTION * height && text.x1 > word.xMin && text.x0 < word.xMax;
}

const squeezed = (text: string): string => text.replace(/\s/g, '');

/** The share of Poppler's words that the TEXT entities on the word's baseline, read left to right, hold. */
function wordRecall(texts: readonly PlacedTextOnPage[], words: readonly PdfWord[]): number {
  const found = words.filter((word) => {
    const under = texts.filter((text) => onBaselineOf(word, text)).sort((a, b) => a.x0 - b.x0);
    return squeezed(under.map((text) => text.value).join('')).includes(squeezed(word.text.replace(UNMAPPED_CHARACTERS, '#')));
  });
  return words.length === 0 ? 1 : found.length / words.length;
}

/** The share of TEXT entities whose characters (but the `#` marks) Poppler reads in the words on their baseline. */
function textAgreement(texts: readonly PlacedTextOnPage[], words: readonly PdfWord[]): number {
  const checked = texts.filter((text) => squeezed(text.value.replaceAll('#', '')) !== '');
  const agreeing = checked.filter((text) => {
    const over = words.filter((word) => onBaselineOf(word, text)).sort((a, b) => a.xMin - b.xMin);
    return squeezed(over.map((word) => word.text).join('').replace(UNMAPPED_CHARACTERS, '')).includes(squeezed(text.value.replaceAll('#', '')));
  });
  return checked.length === 0 ? 1 : agreeing.length / checked.length;
}

/** Whether every font of the page is a Type 3 font, so that every word of it is bitmap-font text. */
function setOnlyInType3Fonts(pdfPath: string, page: number): boolean {
  const listing = execFileSync(getOracleToolPath('pdffonts') as string, ['-f', String(page), '-l', String(page), pdfPath], { encoding: 'utf-8' });
  const types = listing
    .split(/\r?\n/)
    .slice(2)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return parts.slice(1, parts.length - 6).join(' ');
    });
  return types.length > 0 && types.every((type) => type === 'Type 3');
}

/**
 * What ezdxf reads from DXF files, all in one interpreter: per file, the audit's errors and the TEXT entities it finds. ezdxf
 * parses every vertex of a file into entity objects (1.5 s for an 8 MB page, 7,000 polylines of glyph outlines), so a
 * document of such pages is audited from `withoutGeometry` copies.
 */
const EZDXF_AUDIT = `
import json, sys, ezdxf
reports = []
for path in sys.argv[1:]:
    document = ezdxf.readfile(path)
    auditor = document.audit()
    modelspace = document.modelspace()
    unknown = sum(1 for entity in modelspace if entity.dxf.hasattr("linetype") and entity.dxf.linetype not in document.linetypes)
    reports.append({"errors": len(auditor.errors), "texts": len(modelspace.query("TEXT")), "unknownLinetypes": unknown})
print(json.dumps(reports))
`;

/** A page of at most this many characters is audited whole; a larger one (outline-font text is polylines) without its geometry. */
const AUDIT_WHOLE_PAGE_CHARACTERS = 1 << 20;

interface EzdxfReport {
  errors: number;
  texts: number;
  unknownLinetypes: number;
}

function ezdxfAudit(python: string, pages: readonly string[]): EzdxfReport[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-dxf-text-'));
  try {
    const files = pages.map((dxf, index) => {
      const file = path.join(directory, `page-${index}.dxf`);
      fs.writeFileSync(file, dxf);
      return file;
    });
    return JSON.parse(execFileSync(python, ['-I', '-c', EZDXF_AUDIT, ...files], { encoding: 'utf-8' })) as EzdxfReport[];
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const PYTHON_WITH_EZDXF = defaultResolver()(EZDXF_PSEUDO_TOOL);

describe('PostScript files that draw their text with bitmap fonts', () => {
  describe.each(TEXT_CONVERTED_FILES)('%s', (id) => {
    oracleTest(
      'converts every page to DXF, with the bitmap-font text as TEXT entities where Poppler reads the words',
      ['ps2pdf', 'pdftocairo', 'pdftotext', 'pdffonts'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const pdf = (await dispatchConversion(bytes, 'ps', 'pdf', {}, id)).buffer;
        const pages = await dxfPages(await dispatchConversion(bytes, 'ps', 'dxf', {}, id));
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-dxf-words-'));
        try {
          const pdfPath = path.join(directory, 'doc.pdf');
          fs.writeFileSync(pdfPath, pdf);
          const popplerPages = pdfWords(pdfPath);
          expect(pages).toHaveLength(popplerPages.length);
          pages.forEach((page, index) => {
            const dxf = readDxf(page);
            const { height, words } = popplerPages[index];
            const texts = textsOnPage(dxf, height);
            expect(dxf.texts.length, `page ${index + 1}`).toBeGreaterThan(0);
            expect(dxf.styles, `page ${index + 1}`).toEqual([{ name: 'STANDARD', font: 'txt' }]);
            expect(textAgreement(texts, words), `page ${index + 1}`).toBeGreaterThanOrEqual(MIN_TEXT_AGREEMENT);
            if (setOnlyInType3Fonts(pdfPath, index + 1)) {
              expect(wordRecall(texts, words), `page ${index + 1}`).toBeGreaterThanOrEqual(MIN_WORD_RECALL);
            }
          });
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      },
      SAMPLE_TIMEOUT_MS
    );

    it.skipIf(skipUnless('python3 and ezdxf', PYTHON_WITH_EZDXF !== null))(
      'writes pages that ezdxf audits without errors',
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const pages = await dxfPages(await dispatchConversion(bytes, 'ps', 'dxf', {}, id));
        const audited = pages.map((page) => (page.length <= AUDIT_WHOLE_PAGE_CHARACTERS ? page : withoutGeometry(page)));
        expect(audited.every((page) => page.length <= AUDIT_WHOLE_PAGE_CHARACTERS)).toBe(true);
        const reports = ezdxfAudit(PYTHON_WITH_EZDXF as string, audited);
        expect(reports.map((report) => report.errors)).toEqual(pages.map(() => 0));
        expect(reports.map((report) => report.texts)).toEqual(pages.map((page) => readDxf(page).texts.length));
        expect(reports.map((report) => report.unknownLinetypes)).toEqual(pages.map(() => 0));
      },
      SAMPLE_TIMEOUT_MS
    );

    oracleTest(
      'draws dash arrays as line types: the pages that have dashed lines name a defined line type, the others none',
      ['ps2pdf', 'pdftocairo'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const pages = (await dxfPages(await dispatchConversion(bytes, 'ps', 'dxf', {}, id))).map(readDxf);
        const dashedPages = pages.flatMap((dxf, index) => (dxf.entities.some((entity) => entity.linetype !== 'BYLAYER') ? [index + 1] : []));
        expect(dashedPages).toEqual(DASHED_PAGES[id] ?? []);
        for (const dxf of pages) {
          const defined = new Set(dxf.linetypes.map((type) => type.name));
          expect(dxf.entities.every((entity) => entity.linetype === 'BYLAYER' || defined.has(entity.linetype))).toBe(true);
          expect(dxf.linetypes.every((type) => type.name === 'CONTINUOUS' || (type.elements.length >= 2 && type.elements.length % 2 === 0 && type.elements[0] >= 0))).toBe(true);
        }
      },
      SAMPLE_TIMEOUT_MS
    );
  });

  describe.each(REFUSED_FOR_OTHER_CONTENT)('%s', (id) => {
    oracleTest(
      'is refused for DXF for what else its pages draw, not for the bitmap-font text',
      ['ps2pdf', 'pdftocairo'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const refusal = await dispatchConversion(bytes, 'ps', 'dxf', {}, id).then(
          () => 'converted',
          (error: unknown) => describeRefusal(error)
        );
        expect(refusal).not.toMatch(BITMAP_GLYPH_REFUSAL);
        const job = { file: id, source: 'ps', target: 'dxf', verdict: 'refused', ms: 0, detail: refusal } as const;
        expect(knownRefusal(job, readKnownRefusals()), refusal).not.toBeNull();
      },
      SAMPLE_TIMEOUT_MS
    );
  });

  describe.each(PICTURE_FILES)('%s', (id) => {
    oracleTest(
      'converts every page to DXF, leaves the pictures out and says so, and keeps the geometry of the pages that hold them',
      ['ps2pdf', 'pdftocairo'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const pdf = (await dispatchConversion(bytes, 'ps', 'pdf', {}, id)).buffer;
        const result = await dispatchConversion(bytes, 'ps', 'dxf', {}, id);
        const pages = await dxfPages(result);
        expect(pages).toHaveLength(pageCount(pdf));
        const withPictures = picturePages(pdf);
        expect(withPictures.length, 'pages Poppler draws a picture on').toBeGreaterThan(0);
        expect(result.metadata?.warnings).toEqual([picturesLeftOutWarning(withPictures)]);
        for (const page of withPictures) expect(readDxf(pages[page - 1]).entities.length, `page ${page} keeps its geometry`).toBeGreaterThan(0);
        if (PYTHON_WITH_EZDXF !== null) {
          const audited = pages.map((page) => (page.length <= AUDIT_WHOLE_PAGE_CHARACTERS ? page : withoutGeometry(page)));
          expect(ezdxfAudit(PYTHON_WITH_EZDXF, audited).map((report) => report.errors)).toEqual(pages.map(() => 0));
        }
      },
      SAMPLE_TIMEOUT_MS
    );
  });

  describe.each(Object.entries(CLIPPED_FILES))('%s', (id, clippedPages) => {
    oracleTest(
      'converts every page, the pages with a clip among them, to a DXF that ezdxf audits without errors',
      ['ps2pdf', 'pdftocairo'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const pdf = (await dispatchConversion(bytes, 'ps', 'pdf', {}, id)).buffer;
        const pages = await dxfPages(await dispatchConversion(bytes, 'ps', 'dxf', {}, id));
        expect(pages).toHaveLength(pageCount(pdf));
        expect(clippedPages.filter((page) => readDxf(pages[page - 1]).entities.length === 0)).toEqual([]);
        if (PYTHON_WITH_EZDXF !== null) {
          const audited = pages.map((page) => (page.length <= AUDIT_WHOLE_PAGE_CHARACTERS ? page : withoutGeometry(page)));
          expect(ezdxfAudit(PYTHON_WITH_EZDXF, audited).map((report) => report.errors)).toEqual(pages.map(() => 0));
        }
      },
      SAMPLE_TIMEOUT_MS
    );
  });

  describe.each(BITMAP_FONT_FILES)('%s', (id) => {
    oracleTest(
      'converts to PDF, whose Type 3 fonts hold the text the DXF writes as TEXT',
      ['ps2pdf', 'pdffonts', 'pdftotext'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const pdf = (await dispatchConversion(bytes, 'ps', 'pdf', {}, id)).buffer;
        expect(extractFontsWithExternalPdffonts(pdf).some((font) => font.type === 'Type 3')).toBe(true);
        expect(extractTextWithExternalPdftotext(pdf)?.replace(/\s/g, '').length).toBeGreaterThan(MIN_TEXT_CHARACTERS);
      },
      SAMPLE_TIMEOUT_MS
    );
  });
});

/** The first Ghostscript `Error:` line the real-world files print: what the converter quotes in its refusal. */
const INTERPRETER_REFUSAL = (name: string, operator: string): RegExp =>
  new RegExp(`^ConversionFailedError: The PostScript interpreter rejected the \\.ps file: Error: /${name} in --${operator}--`);

function pageCount(pdf: Buffer): number {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-refusal-pdf-'));
  try {
    const file = path.join(directory, 'out.pdf');
    fs.writeFileSync(file, pdf);
    return Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf-8' }))?.[1]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The pages (from 1) on which Poppler's own SVG for the page draws an `<image>`: one that the page places outside the definitions and the
 * masks (a `<use>` of it), which a DXF cannot hold. The images inside a mask are the characters of a bitmap font, which the DXF writes as text.
 */
function picturePages(pdf: Buffer): number[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-picture-pages-'));
  try {
    const file = path.join(directory, 'out.pdf');
    fs.writeFileSync(file, pdf);
    const pages: number[] = [];
    for (let page = 1; page <= pageCount(pdf); page += 1) {
      const svg = path.join(directory, `page-${page}.svg`);
      execFileSync('pdftocairo', ['-svg', '-f', String(page), '-l', String(page), file, svg]);
      const text = fs.readFileSync(svg, 'utf-8');
      const imageIds = [...text.matchAll(/<image\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
      const placed = text.replace(/<mask\b[\s\S]*?<\/mask>/g, '').replace(/<defs>[\s\S]*?<\/defs>/g, '');
      if (imageIds.some((id) => placed.includes(`href="#${id}"`))) pages.push(page);
    }
    return pages;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function replaceExactly(source: Buffer, pattern: RegExp, replacement: string, times: number): Buffer {
  const text = source.toString('latin1');
  expect([...text.matchAll(pattern)]).toHaveLength(times);
  return Buffer.from(text.replace(pattern, replacement), 'latin1');
}

describe('PostScript files that Ghostscript stops on', () => {
  describe('govdocs1-002500.ps (WordPerfect 6.1)', () => {
    const id = 'govdocs1-002500.ps';
    /** The font programs fill `Encoding` with integers where `Widths` was meant (Type 3 `Encoding` holds names). */
    const FILLS_ENCODING_WITH_ZEROS = /0 1 255\{Encoding exch 0 put\}for/g;

    oracleTest(
      'is refused by the interpreter at the first glyph added to a font after definefont, in every target',
      ['ps2pdf'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        for (const target of ['pdf', 'dxf']) {
          const refusal = await dispatchConversion(bytes, 'ps', target, {}, id).catch((error: unknown) => describeRefusal(error));
          expect(refusal, target).toMatch(INTERPRETER_REFUSAL('invalidaccess', 'put'));
        }
      },
      SAMPLE_TIMEOUT_MS
    );

    oracleTest(
      'converts all 27 pages once the one line that fills Encoding with integers fills Widths: that line is the cause',
      ['ps2pdf', 'pdfinfo'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const repaired = replaceExactly(bytes, FILLS_ENCODING_WITH_ZEROS, '0 1 255{Widths exch 0 put}for', 1);
        expect(pageCount((await dispatchConversion(repaired, 'ps', 'pdf', {}, id)).buffer)).toBe(27);
      },
      SAMPLE_TIMEOUT_MS
    );
  });

  describe('govdocs1-006458.ps (QuickDraw GX printer driver)', () => {
    const id = 'govdocs1-006458.ps';
    /** `MakeCalibratedRGBSpace` declares CIE ranges of 0 to 65535; Ghostscript accepts a CIE parameter of at most 10000. */
    const CIE_RANGES = /\/Range(ABC|LMN) \[0 65535 0 65535 0 65535\]/g;

    oracleTest(
      'is refused by the interpreter at the first CIE colour space, in every target',
      ['ps2pdf'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        for (const target of ['pdf', 'dxf']) {
          const refusal = await dispatchConversion(bytes, 'ps', target, {}, id).catch((error: unknown) => describeRefusal(error));
          expect(refusal, target).toMatch(INTERPRETER_REFUSAL('limitcheck', 'setcolorspace'));
        }
      },
      SAMPLE_TIMEOUT_MS
    );

    oracleTest(
      'converts all 24 pages once the two CIE ranges are inside 10000: the range is the cause',
      ['ps2pdf', 'pdfinfo'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const repaired = replaceExactly(bytes, CIE_RANGES, '/Range$1 [0 9999 0 9999 0 9999]', 2);
        expect(pageCount((await dispatchConversion(repaired, 'ps', 'pdf', {}, id)).buffer)).toBe(24);
      },
      SAMPLE_TIMEOUT_MS
    );
  });
});

describe('the nightly gate lists these refusals as explained', () => {
  const explained = readKnownRefusals();
  const refusals: Record<string, string[]> = {
    'govdocs1-002500.ps': ['ConversionFailedError: The PostScript interpreter rejected the .ps file: Error: /invalidaccess in --put--\nOperand stack:'],
    'govdocs1-006458.ps': ['ConversionFailedError: The PostScript interpreter rejected the .ps file: Error: /limitcheck in --setcolorspace--\nOperand stack:'],
  };

  it.each(Object.entries(refusals))('%s', (file, details) => {
    for (const detail of details) {
      const job = { file, source: 'ps', target: 'pdf', verdict: 'refused', ms: 0, detail } as const;
      expect(knownRefusal(job, explained), `${file} has a known refusal that matches its error`).not.toBeNull();
    }
  });
});
