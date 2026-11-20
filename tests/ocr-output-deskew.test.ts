import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { levelPageToText, measureTextSkewRadians, type PlacedWord } from '../src/lib/conversions/ocr-output-deskew';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { fixtureImage, groundTruth, requireTessdata } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';

/**
 * `ocrDeskew` levels a skewed scan in the searchable PDF it writes (the behaviour of `ocrmypdf --deskew`): the page
 * content turns by the measured skew, so the text layer runs along the rows of the page and a text extractor that
 * regroups words by position (Poppler's `pdftotext`) reads the lines in order. The oracle is `pdftotext` and `pdfinfo`,
 * which share no code with this project, scored against the text the page was drawn from.
 */

const ANGLES_DEGREES = [-10, -5, -3, -1, 1, 3, 5, 10] as const;
const PAGES = [
  { page: 'en_a', language: 'eng', tessdata: 'eng', maxCerPercent: 2 },
  { page: 'ko_a', language: 'ko', tessdata: 'kor', maxCerPercent: 3 },
] as const;
const PAGE_TIMEOUT_MS = 180_000;
const SCAN_DPI = 300;
const POINTS_PER_INCH = 72;
const DEGREES_TO_RADIANS = Math.PI / 180;

function tool(name: 'pdftotext' | 'pdfinfo'): string {
  const found = getOracleToolPath(name);
  if (!found) throw new OracleToolMissingError(name, `${name} is not installed`);
  return found;
}

/** The clean page turned by `degrees` (clockwise) on a white sheet, written at 300 dpi. */
async function turnedPage(page: string, degrees: number): Promise<Buffer> {
  return sharp(fixtureImage(page, 'clean300'))
    .rotate(degrees, { background: '#ffffff' })
    .withMetadata({ density: SCAN_DPI })
    .png()
    .toBuffer();
}

/** A scanned PDF of one image, the way a scanner writes it: no text, the page as large as the scan. */
async function scannedPdf(png: Buffer): Promise<Buffer> {
  const { width, height } = await sharp(png).metadata();
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  const page = doc.addPage([(width! * POINTS_PER_INCH) / SCAN_DPI, (height! * POINTS_PER_INCH) / SCAN_DPI]);
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  return Buffer.from(await doc.save());
}

describe('output deskew', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-deskew-'));
  afterAll(async () => {
    await shutdownOcrWorkerPool();
    fs.rmSync(work, { recursive: true, force: true });
  });

  function extractedText(pdf: Buffer, name: string): string {
    const file = path.join(work, `${name}.pdf`);
    fs.writeFileSync(file, pdf);
    return execFileSync(tool('pdftotext'), ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
  }

  function pageSizePoints(pdf: Buffer, name: string): [number, number] {
    const file = path.join(work, `${name}-size.pdf`);
    fs.writeFileSync(file, pdf);
    const size = /Page size:\s+(\S+) x (\S+) pts/.exec(execFileSync(tool('pdfinfo'), [file], { encoding: 'utf8' }));
    return [Number(size![1]), Number(size![2])];
  }

  function comparable(text: string, language: string): string {
    return language === 'ko' ? text.replace(/\s+/g, '') : text;
  }

  describe('measuring the skew of a text layer', () => {
    function word(angleDegrees: number, x: number, advanceUnits = 1000): PlacedWord {
      return { text: 'a'.repeat(advanceUnits / 500), spaceAfter: true, x, y: 100, angle: angleDegrees * DEGREES_TO_RADIANS, fontSize: 10, horizontalScaling: 100 };
    }

    it('reads the skew of lines that agree, and signs it as the angle the text runs at', () => {
      const words = Array.from({ length: 12 }, (_, i) => word(3.2, 40 + i * 30));
      expect(measureTextSkewRadians(words)! / DEGREES_TO_RADIANS).toBeCloseTo(3.2, 6);
    });

    it('reads a page turned by a quarter as its residual skew', () => {
      const words = Array.from({ length: 12 }, (_, i) => word(90 - 4, 40 + i * 30));
      expect(measureTextSkewRadians(words)! / DEGREES_TO_RADIANS).toBeCloseTo(-4, 6);
    });

    it('trusts nothing when the lines disagree (a curved page) or there are too few words', () => {
      const curved = Array.from({ length: 12 }, (_, i) => word(i * 1.5 - 8, 40 + i * 30));
      expect(measureTextSkewRadians(curved)).toBeNull();
      expect(measureTextSkewRadians([word(3, 10), word(3, 50)])).toBeNull();
      expect(measureTextSkewRadians([])).toBeNull();
    });

    it('leaves a level page and a skew beyond the limit alone', () => {
      expect(measureTextSkewRadians(Array.from({ length: 12 }, (_, i) => word(0.1, 40 + i * 30)))).toBeNull();
      expect(measureTextSkewRadians(Array.from({ length: 12 }, (_, i) => word(25, 40 + i * 30)))).toBeNull();
    });
  });

  describe('turning a page', () => {
    /** Ten words of a line on a baseline from (x, y) at `degrees` counterclockwise, 40 pt wide, 10 pt high. */
    function line(x: number, y: number, degrees: number): PlacedWord[] {
      const angle = degrees * DEGREES_TO_RADIANS;
      return Array.from({ length: 10 }, (_, i) => ({
        text: 'abcdefgh', spaceAfter: true, x: x + i * 45 * Math.cos(angle), y: y + i * 45 * Math.sin(angle), angle, fontSize: 10, horizontalScaling: 100,
      }));
    }

    async function blankPage(width: number, height: number) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([width, height]);
      page.drawRectangle({ x: 0, y: 0, width: 10, height: 10 });
      return { doc, page };
    }

    it('wraps the content in one turn by minus the skew and leaves a box that already holds the words', async () => {
      const { page } = await blankPage(600, 300);
      const words = line(60, 120, 4);
      const before = page.node.Contents() as unknown as { size(): number };
      const streamsBefore = before.size?.() ?? 1;
      const turned = levelPageToText(page, words);
      expect(turned! / DEGREES_TO_RADIANS).toBeCloseTo(-4, 6);
      expect((page.node.Contents() as unknown as { size(): number }).size()).toBe(streamsBefore + 2);
      expect(page.getMediaBox()).toEqual({ x: 0, y: 0, width: 600, height: 300 });
    });

    it('grows the box to hold a word that the turn carries past its edge', async () => {
      const { page } = await blankPage(600, 300);
      // A line near the top edge, tilted 8 degrees: the turn about the centre (300, 150) levels it at about y = 301, with
      // its tops at about 309, above the page.
      const words = line(10, 262, 8);
      levelPageToText(page, words);
      const box = page.getMediaBox();
      const turn = -8 * DEGREES_TO_RADIANS;
      const rotated = (px: number, py: number) => ({
        x: 300 + (px - 300) * Math.cos(turn) - (py - 150) * Math.sin(turn),
        y: 150 + (px - 300) * Math.sin(turn) + (py - 150) * Math.cos(turn),
      });
      for (const word of words) {
        const start = rotated(word.x, word.y);
        const top = rotated(word.x - Math.sin(word.angle) * 7.7, word.y + Math.cos(word.angle) * 7.7);
        for (const point of [start, top]) {
          expect(point.x).toBeGreaterThanOrEqual(box.x - 1e-6);
          expect(point.y).toBeGreaterThanOrEqual(box.y - 1e-6);
          expect(point.x).toBeLessThanOrEqual(box.x + box.width + 1e-6);
          expect(point.y).toBeLessThanOrEqual(box.y + box.height + 1e-6);
        }
      }
      expect(box.height).toBeGreaterThan(300);
    });

    it('leaves a page with annotations and a page without a trusted skew as they are', async () => {
      const { doc, page } = await blankPage(600, 300);
      expect(levelPageToText(page, line(60, 120, 0.1))).toBeNull();
      expect(page.getMediaBox()).toEqual({ x: 0, y: 0, width: 600, height: 300 });
      const annotated = doc.addPage([600, 300]);
      annotated.drawRectangle({ x: 0, y: 0, width: 10, height: 10 });
      const link = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 50, 30] });
      annotated.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]));
      expect(levelPageToText(annotated, line(60, 120, 4))).toBeNull();
    });
  });

  for (const { page, language, tessdata, maxCerPercent } of PAGES) {
    describe(`${page} (${language})`, () => {
      const truth = groundTruth(page);

      for (const degrees of ANGLES_DEGREES) {
        oracleTest(
          `reads an image turned by ${degrees} degrees in order with CER <= ${maxCerPercent}%`,
          ['pdftotext'],
          async () => {
            requireTessdata(tessdata);
            const scan = await turnedPage(page, degrees);
            const converted = await convertFile(scan, 'png', 'pdf', { ocrEnabled: true, ocrLanguage: language, ocrDeskew: true }, 'scan.png');
            const text = extractedText(converted.buffer, `${page}-img-${degrees}`);
            expect(characterErrorRatePercent(comparable(truth, language), comparable(text, language))).toBeLessThanOrEqual(maxCerPercent);
          },
          PAGE_TIMEOUT_MS
        );
      }

      oracleTest(
        `reads a scanned PDF turned by 3 degrees in order with CER <= ${maxCerPercent}%`,
        ['pdftotext'],
        async () => {
          requireTessdata(tessdata);
          const input = await scannedPdf(await turnedPage(page, 3));
          const converted = await convertFile(input, 'pdf', 'pdf', { ocrEnabled: true, ocrMode: 'force', ocrLanguage: language, ocrDeskew: true }, 'scan.pdf');
          const text = extractedText(converted.buffer, `${page}-pdf`);
          expect(characterErrorRatePercent(comparable(truth, language), comparable(text, language))).toBeLessThanOrEqual(maxCerPercent);
        },
        PAGE_TIMEOUT_MS
      );

      oracleTest(
        'reads the committed 3 degree skew page in order',
        ['pdftotext'],
        async () => {
          requireTessdata(tessdata);
          const converted = await convertFile(fixtureImage(page, 'skew3'), 'png', 'pdf', { ocrEnabled: true, ocrLanguage: language, ocrDeskew: true }, 'skew3.png');
          const text = extractedText(converted.buffer, `${page}-skew3`);
          expect(characterErrorRatePercent(comparable(truth, language), comparable(text, language))).toBeLessThanOrEqual(maxCerPercent);
        },
        PAGE_TIMEOUT_MS
      );

      oracleTest(
        'writes the same PDF with ocrDeskew false as without the option, and a level page the same with it on',
        ['pdftotext', 'pdfinfo'],
        async () => {
          requireTessdata(tessdata);
          const skewed = await turnedPage(page, 3);
          const omitted = await convertFile(skewed, 'png', 'pdf', { ocrEnabled: true, ocrLanguage: language }, 'scan.png');
          const off = await convertFile(skewed, 'png', 'pdf', { ocrEnabled: true, ocrLanguage: language, ocrDeskew: false }, 'scan.png');
          expect(extractedText(off.buffer, `${page}-off`)).toBe(extractedText(omitted.buffer, `${page}-omitted`));
          expect(pageSizePoints(off.buffer, `${page}-off`)).toEqual(pageSizePoints(omitted.buffer, `${page}-omitted`));
          expect(await pageStructure(off.buffer)).toEqual(await pageStructure(omitted.buffer));

          const level = fixtureImage(page, 'clean300');
          const levelOff = await convertFile(level, 'png', 'pdf', { ocrEnabled: true, ocrLanguage: language }, 'level.png');
          const levelOn = await convertFile(level, 'png', 'pdf', { ocrEnabled: true, ocrLanguage: language, ocrDeskew: true }, 'level.png');
          expect(await pageStructure(levelOn.buffer)).toEqual(await pageStructure(levelOff.buffer));
          expect(extractedText(levelOn.buffer, `${page}-level-on-text`)).toBe(extractedText(levelOff.buffer, `${page}-level-off-text`));
          expect(pageSizePoints(levelOn.buffer, `${page}-level-on`)).toEqual(pageSizePoints(levelOff.buffer, `${page}-level-off`));
        },
        PAGE_TIMEOUT_MS
      );
    });
  }

  oracleTest(
    'keeps every recognised word on the page when the turn would carry a line past its edge',
    ['pdftotext'],
    async () => {
      requireTessdata('eng');
      const scan = await turnedPage('en_a', 10);
      const levelled = await convertFile(scan, 'png', 'pdf', { ocrEnabled: true, ocrLanguage: 'eng', ocrDeskew: true }, 'scan.png');
      const words = (pdf: Buffer, name: string): { xMin: number; xMax: number; yMin: number; yMax: number }[] => {
        const file = path.join(work, `${name}.pdf`);
        fs.writeFileSync(file, pdf);
        const html = execFileSync(tool('pdftotext'), ['-bbox', file, '-'], { encoding: 'utf8' });
        return [...html.matchAll(/xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/g)].map((m) => ({
          xMin: Number(m[1]), yMin: Number(m[2]), xMax: Number(m[3]), yMax: Number(m[4]),
        }));
      };
      const [width, height] = pageSizePoints(levelled.buffer, 'edge-levelled');
      const levelledWords = words(levelled.buffer, 'edge-levelled');
      expect(levelledWords.length).toBe(groundTruth('en_a').split(/\s+/).filter(Boolean).length);
      for (const w of levelledWords) {
        expect(w.xMin).toBeGreaterThanOrEqual(-0.5);
        expect(w.yMin).toBeGreaterThanOrEqual(-0.5);
        expect(w.xMax).toBeLessThanOrEqual(width + 0.5);
        expect(w.yMax).toBeLessThanOrEqual(height + 0.5);
      }
    },
    PAGE_TIMEOUT_MS
  );
});

/** How many content streams the first page has and its media box: a levelled page is wrapped by two more streams. */
async function pageStructure(pdf: Buffer): Promise<{ streams: number; mediaBox: number[] }> {
  const doc = await PDFDocument.load(pdf);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const { x, y, width, height } = page.getMediaBox();
  return { streams: contents && 'size' in contents ? (contents as { size(): number }).size() : 1, mediaBox: [x, y, width, height] };
}
