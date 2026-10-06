import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performOcr } from '../src/lib/conversions/ocr';
import { exportAlto, exportHocr } from '../src/lib/conversions/ocr-export';
import { recognizeWithCli } from '../src/lib/conversions/ocr-cli';
import { ocrSegmentationFor } from '../src/lib/conversions/ocr-config';
import type { OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { validateAlto44, xmlWellFormed, xpathAttributes, xpathCount } from './helpers/xml-oracle';

/**
 * hOCR 1.2 and ALTO 4.4 exports against the reference `tesseract` CLI's own hOCR for the same
 * page, language, page segmentation and engine mode as the pipeline uses (ocr-config.ts). Counts and
 * baselines are read from the reference output with xmllint, never from the exporter.
 */
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const PAGE_TIMEOUT_MS = 180_000;
const MAX_BASELINE_DELTA_PX = 2;
const LINE_BOX_TOLERANCE_PX = 5;
/** A 3 degree skew over a ~900 px line rises about 47 px; half of that proves the slope is exercised. */
const MIN_SKEW_RISE_PX = 20;
const LANGUAGE = 'eng';
/**
 * Pages read by the WebAssembly engine the pipeline uses first. The borderless table is left out: that
 * engine segments it differently from the native CLI build (13 blocks against 14), so the CLI cannot
 * be the oracle for it. It is covered through the native adapter below, which runs the same build.
 */
const GOLDEN_PAGES = ['twocol__clean300.png', 'twocol__skew3.png', 'twocol__dpi150.png'] as const;
const NATIVE_PAGES = [...GOLDEN_PAGES, 'table_borderless.png'] as const;

const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  process.cwd(),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
];

function tessdataDir(): string {
  const dir = TESSDATA_DIRS.find(
    (candidate) =>
      fs.existsSync(path.join(candidate, `${LANGUAGE}.traineddata`)) ||
      fs.existsSync(path.join(candidate, `${LANGUAGE}.traineddata.gz`))
  );
  if (!dir) throw new OracleToolMissingError(`${LANGUAGE}.traineddata`, `${LANGUAGE}.traineddata is not installed`);
  return dir;
}

function referenceHocr(file: string): string {
  const cli = getOracleToolPath('tesseract');
  if (!cli) throw new OracleToolMissingError('tesseract', 'tesseract is not installed');
  const { pageSegMode, engineMode } = ocrSegmentationFor(LANGUAGE);
  return execFileSync(
    cli,
    [path.join(FIXTURE_DIR, file), 'stdout', '--tessdata-dir', tessdataDir(), '-l', LANGUAGE, '--psm', pageSegMode, '--oem', String(engineMode), '-c', 'tessedit_create_hocr=1'],
    { encoding: 'utf-8', timeout: PAGE_TIMEOUT_MS, env: { ...process.env, OMP_THREAD_LIMIT: '1' } }
  );
}

const referenceCache = new Map<string, string>();
function reference(file: string): string {
  const cached = referenceCache.get(file);
  if (cached) return cached;
  const hocr = referenceHocr(file);
  referenceCache.set(file, hocr);
  return hocr;
}

const pipelineCache = new Map<string, Promise<OcrResult>>();
function pipeline(file: string): Promise<OcrResult> {
  const cached = pipelineCache.get(file);
  if (cached) return cached;
  const result = performOcr(fs.readFileSync(path.join(FIXTURE_DIR, file)), LANGUAGE);
  pipelineCache.set(file, result);
  return result;
}

interface ReferenceLine {
  bbox: string;
  left: number;
  top: number;
  /** Baseline height at the line's left and right edges, in image coordinates (y down). */
  baselineStart: number;
  baselineEnd: number;
  xSize: number;
  xDescenders: number;
  xAscenders: number;
}

/** A hOCR baseline is `slope offset` relative to the bottom-left corner of the line box. */
function readLine(title: string): ReferenceLine {
  const bbox = /bbox (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(title);
  const baseline = /baseline (-?[\d.]+) (-?[\d.]+)/.exec(title);
  const xSize = /x_size (-?[\d.]+)/.exec(title);
  const xDescenders = /x_descenders (-?[\d.]+)/.exec(title);
  const xAscenders = /x_ascenders (-?[\d.]+)/.exec(title);
  if (!bbox || !baseline || !xSize || !xDescenders || !xAscenders) {
    throw new Error(`hOCR line without bbox, baseline, x_size, x_descenders or x_ascenders: ${title}`);
  }
  const [left, bottom, right] = [Number(bbox[1]), Number(bbox[4]), Number(bbox[3])];
  const slope = Number(baseline[1]);
  const offset = Number(baseline[2]);
  return {
    bbox: `${bbox[1]} ${bbox[2]} ${bbox[3]} ${bbox[4]}`,
    left,
    top: Number(bbox[2]),
    baselineStart: bottom + offset,
    baselineEnd: bottom + offset + slope * (right - left),
    xSize: Number(xSize[1]),
    xDescenders: Number(xDescenders[1]),
    xAscenders: Number(xAscenders[1]),
  };
}

function hocrLines(hocr: string): ReferenceLine[] {
  return xpathAttributes(hocr, "//*[@class='ocr_line']/@title").map(readLine);
}

/** Lines ordered by their top-left corner, so two outputs of one page can be paired without relying on element order. */
function readingOrderless(lines: ReferenceLine[]): ReferenceLine[] {
  return [...lines].sort((a, b) => a.top - b.top || a.left - b.left);
}

/** The reference writes heading, caption and float lines under their own classes; they are lines too. */
const LINE_CLASS = "//*[@class='ocr_line' or @class='ocr_header' or @class='ocr_caption' or @class='ocr_textfloat']";
const PAR_CLASS = "//*[@class='ocr_par']";
const AREA_CLASS = "//*[@class='ocr_carea']";
const WORD_CLASS = "//*[@class='ocrx_word']";

/** The oracle's own reader, checked against hand-worked values so a wrong reading cannot hide a wrong export. */
describe('reading a reference hOCR line', () => {
  it('turns bbox and baseline into the baseline heights at the left and right edges', () => {
    // Bottom edge at y = 40, baseline 5 px below it at the left edge, falling 0.01 px per px over 100 px.
    const line = readLine('bbox 10 20 110 40; baseline 0.01 5; x_size 12; x_descenders 3; x_ascenders 4');
    expect(line.bbox).toBe('10 20 110 40');
    expect(line.left).toBe(10);
    expect(line.top).toBe(20);
    expect(line.baselineStart).toBe(45);
    expect(line.baselineEnd).toBeCloseTo(46, 10);
    expect([line.xSize, line.xDescenders, line.xAscenders]).toEqual([12, 3, 4]);
  });

  it('reads negative offsets and slopes', () => {
    const line = readLine('bbox 0 0 200 50; baseline -0.02 -6; x_size 10.5; x_descenders 2.5; x_ascenders 3.5');
    expect(line.baselineStart).toBe(44);
    expect(line.baselineEnd).toBeCloseTo(40, 10);
    expect(line.xSize).toBe(10.5);
  });

  it('refuses a line title without a baseline instead of inventing one', () => {
    expect(() => readLine('bbox 0 0 10 10; x_size 5; x_descenders 1; x_ascenders 1')).toThrow(/without bbox, baseline/);
  });
});

describe('hOCR export matches the reference hierarchy and baselines', () => {
  for (const file of GOLDEN_PAGES) {
    oracleTest(
      `${file}: block, paragraph, line and word counts equal the reference output`,
      ['tesseract', 'xmllint'],
      async () => {
        const ref = reference(file);
        const mine = exportHocr(await pipeline(file), { filename: file });
        expect(xpathCount(ref, AREA_CLASS)).toBeGreaterThan(0);
        expect(xpathCount(mine, AREA_CLASS)).toBe(xpathCount(ref, AREA_CLASS));
        expect(xpathCount(mine, PAR_CLASS)).toBe(xpathCount(ref, PAR_CLASS));
        expect(xpathCount(mine, LINE_CLASS)).toBe(xpathCount(ref, LINE_CLASS));
        expect(xpathCount(mine, WORD_CLASS)).toBe(xpathCount(ref, WORD_CLASS));
      },
      PAGE_TIMEOUT_MS
    );

    oracleTest(
      `${file}: line baselines are within ${MAX_BASELINE_DELTA_PX} px of the reference and x_size, x_descenders and x_ascenders match`,
      ['tesseract', 'xmllint'],
      async () => {
        const mine = exportHocr(await pipeline(file), { filename: file });
        const mineLines = readingOrderless(hocrLines(mine));
        const referenceLines = readingOrderless(hocrLines(reference(file)));
        expect(referenceLines.length).toBeGreaterThan(0);
        expect(mineLines).toHaveLength(referenceLines.length);
        referenceLines.forEach((expected, index) => {
          const actual = mineLines[index];
          // The engine builds can differ by a few pixels in a line box, so lines are paired by position.
          expect(Math.abs(actual.left - expected.left), `line ${expected.bbox}`).toBeLessThanOrEqual(LINE_BOX_TOLERANCE_PX);
          expect(Math.abs(actual.top - expected.top), `line ${expected.bbox}`).toBeLessThanOrEqual(LINE_BOX_TOLERANCE_PX);
          expect(Math.abs(actual.baselineStart - expected.baselineStart), `line ${expected.bbox}`).toBeLessThanOrEqual(MAX_BASELINE_DELTA_PX);
          expect(Math.abs(actual.baselineEnd - expected.baselineEnd), `line ${expected.bbox}`).toBeLessThanOrEqual(MAX_BASELINE_DELTA_PX);
          expect(actual.xSize).toBe(expected.xSize);
          expect(actual.xDescenders).toBe(expected.xDescenders);
          expect(actual.xAscenders).toBe(expected.xAscenders);
        });
      },
      PAGE_TIMEOUT_MS
    );
  }

  oracleTest(
    'the skewed page has strongly sloped baselines in the reference, so the slope is really compared',
    ['tesseract', 'xmllint'],
    () => {
      const rise = hocrLines(reference('twocol__skew3.png')).map((line) => Math.abs(line.baselineEnd - line.baselineStart));
      expect(Math.max(...rise)).toBeGreaterThanOrEqual(MIN_SKEW_RISE_PX);
    },
    PAGE_TIMEOUT_MS
  );

  oracleTest(
    'output is well-formed XHTML declaring its language and the hOCR meta fields',
    ['tesseract', 'xmllint'],
    async () => {
      const mine = exportHocr(await pipeline('twocol__clean300.png'), { filename: 'twocol__clean300.png' });
      const checked = xmlWellFormed(mine);
      expect(checked.stderr).toBe('');
      expect(checked.ok).toBe(true);
      expect(xpathAttributes(mine, '/*/@lang')).toEqual(['en']);
      expect(xpathAttributes(mine, '/*/@xml:lang')).toEqual(['en']);
      expect(xpathAttributes(mine, "//*[@name='ocr-capabilities']/@content")).toEqual([
        'ocr_page ocr_carea ocr_par ocr_line ocrx_word ocrp_wconf',
      ]);
      expect(xpathAttributes(mine, "//*[@name='ocr-system']/@content")).toHaveLength(1);
      expect(xpathAttributes(mine, `${PAR_CLASS}/@lang`)).toEqual(Array(xpathCount(mine, PAR_CLASS)).fill('en'));
    },
    PAGE_TIMEOUT_MS
  );
});

describe('ALTO 4.4 export validates and matches the reference hierarchy', () => {
  for (const file of GOLDEN_PAGES) {
    oracleTest(
      `${file}: validates against the ALTO 4.4 schema with matching block, paragraph, line and word counts`,
      ['tesseract', 'xmllint'],
      async () => {
        const ref = reference(file);
        const alto = exportAlto(await pipeline(file), { filename: file });
        const validation = validateAlto44(alto);
        expect(validation.stderr.trim()).toBe('- validates');
        expect(validation.ok).toBe(true);
        expect(xpathCount(alto, "//*[local-name()='ComposedBlock']")).toBe(xpathCount(ref, AREA_CLASS));
        expect(xpathCount(alto, "//*[local-name()='TextBlock']")).toBe(xpathCount(ref, PAR_CLASS));
        expect(xpathCount(alto, "//*[local-name()='TextLine']")).toBe(xpathCount(ref, LINE_CLASS));
        expect(xpathCount(alto, "//*[local-name()='String']")).toBe(xpathCount(ref, WORD_CLASS));
      },
      PAGE_TIMEOUT_MS
    );

    oracleTest(
      `${file}: TextLine BASELINE is within ${MAX_BASELINE_DELTA_PX} px of the reference baseline`,
      ['tesseract', 'xmllint'],
      async () => {
        const alto = exportAlto(await pipeline(file), { filename: file });
        const lines = xpathAttributes(alto, "//*[local-name()='TextLine']/@BASELINE");
        const boxes = xpathAttributes(alto, "//*[local-name()='TextLine']/@HPOS");
        expect(lines).toHaveLength(boxes.length);
        const referenceLines = hocrLines(reference(file));
        expect(lines).toHaveLength(referenceLines.length);
        const referenceByLeft = new Map<string, ReferenceLine[]>();
        for (const line of referenceLines) {
          const left = line.bbox.split(' ')[0];
          referenceByLeft.set(left, [...(referenceByLeft.get(left) ?? []), line]);
        }
        let compared = 0;
        for (const baseline of lines) {
          const points = baseline.split(' ').map((pair) => pair.split(',').map(Number));
          expect(points).toHaveLength(2);
          const [[x0, y0], [x1, y1]] = points;
          const candidates = referenceByLeft.get(String(x0)) ?? [];
          const best = candidates.find(
            (line) =>
              Math.abs(line.baselineStart - y0) <= MAX_BASELINE_DELTA_PX &&
              Math.abs(line.baselineEnd - y1) <= MAX_BASELINE_DELTA_PX &&
              Math.abs(Number(line.bbox.split(' ')[2]) - x1) <= MAX_BASELINE_DELTA_PX
          );
          expect(best, `BASELINE ${baseline}`).toBeDefined();
          compared++;
        }
        expect(compared).toBe(referenceLines.length);
      },
      PAGE_TIMEOUT_MS
    );
  }

  oracleTest(
    'describes the source image and the processing step, and keeps word confidence within 0..1',
    ['tesseract', 'xmllint'],
    async () => {
      const alto = exportAlto(await pipeline('twocol__clean300.png'), { filename: 'twocol__clean300.png' });
      expect(xpathAttributes(alto, '/*/@SCHEMAVERSION')).toEqual(['4.4']);
      expect(xpathCount(alto, "//*[local-name()='MeasurementUnit' and text()='pixel']")).toBe(1);
      expect(xpathCount(alto, "//*[local-name()='fileName' and text()='twocol__clean300.png']")).toBe(1);
      expect(xpathCount(alto, "//*[local-name()='softwareName' and text()='EasyConvert OCR']")).toBe(1);
      expect(xpathCount(alto, "//*[local-name()='String'][@WC < 0 or @WC > 1]")).toBe(0);
      const ref = reference('twocol__clean300.png');
      expect(xpathCount(alto, "//*[local-name()='TextBlock'][@LANG='en']")).toBe(xpathCount(ref, PAR_CLASS));
    },
    PAGE_TIMEOUT_MS
  );
});

describe('native engine path (TSV) keeps the hierarchy', () => {
  for (const file of NATIVE_PAGES) {
    oracleTest(
      `${file} through the CLI adapter has the reference block, paragraph, line and word counts`,
      ['tesseract', 'xmllint'],
      async () => {
        const cliPath = getOracleToolPath('tesseract')!;
        const result = await recognizeWithCli({
          cliPath,
          tessdataDir: tessdataDir(),
          tesseractLang: LANGUAGE,
          image: fs.readFileSync(path.join(FIXTURE_DIR, file)),
        });
        const ref = reference(file);
        const hocr = exportHocr(result, { filename: file });
        expect(xpathCount(ref, AREA_CLASS)).toBeGreaterThan(0);
        expect(xpathCount(hocr, AREA_CLASS)).toBe(xpathCount(ref, AREA_CLASS));
        expect(xpathCount(hocr, PAR_CLASS)).toBe(xpathCount(ref, PAR_CLASS));
        expect(xpathCount(hocr, LINE_CLASS)).toBe(xpathCount(ref, LINE_CLASS));
        expect(xpathCount(hocr, WORD_CLASS)).toBe(xpathCount(ref, WORD_CLASS));
        // The TSV rows carry no baseline, so none is written rather than a constant one.
        expect(xpathAttributes(hocr, `${LINE_CLASS}/@title`).filter((title) => title.includes('baseline'))).toEqual([]);
        const alto = exportAlto(result, { filename: file });
        expect(validateAlto44(alto).ok).toBe(true);
        expect(xpathCount(alto, "//*[local-name()='ComposedBlock']")).toBe(xpathCount(ref, AREA_CLASS));
        expect(xpathCount(alto, "//*[local-name()='TextBlock']")).toBe(xpathCount(ref, PAR_CLASS));
        expect(xpathCount(alto, "//*[local-name()='TextLine']")).toBe(xpathCount(ref, LINE_CLASS));
      },
      PAGE_TIMEOUT_MS
    );
  }
});
