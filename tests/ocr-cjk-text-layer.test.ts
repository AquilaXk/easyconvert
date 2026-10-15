import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFString,
  PDFHexString,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { createLosslessSandwichPdfFromImage, type OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';

/**
 * Non-WinAnsi OCR text (Korean, mixed Latin/Hangul) is written through a composite (Type 0)
 * font. ISO 32000-1 §9.7.3 requires CIDSystemInfo Registry/Ordering to be strings; a
 * malformed composite font makes PDF readers drop the invisible text layer entirely.
 */

const KOREAN_LINE = '한글 문서 검색';
const MIXED_LINE = 'Invoice 송장 42';
const LINES = [KOREAN_LINE, MIXED_LINE];
const PAGE_WIDTH = 360;
const PAGE_HEIGHT = 160;
const LINE_HEIGHT = 24;
const LINE_TOPS = [30, 90];
const WORD_PITCH = 110;
const WORD_WIDTH = 100;
const LEFT_MARGIN = 10;

const OCR_RESULT: OcrResult = {
  text: LINES.join('\n'),
  confidence: 0.9,
  wordCount: LINES.join(' ').split(' ').length,
  lines: LINES,
  lineBlocks: LINES.map((line, lineIdx) => ({
    text: line,
    bbox: { x: LEFT_MARGIN, y: LINE_TOPS[lineIdx], width: 330, height: LINE_HEIGHT },
    words: line.split(' ').map((word, i) => ({
      text: word,
      bbox: { x: LEFT_MARGIN + i * WORD_PITCH, y: LINE_TOPS[lineIdx], width: WORD_WIDTH, height: LINE_HEIGHT },
    })),
  })),
};

async function sandwichPdf(): Promise<Buffer> {
  const png = await sharp({
    create: { width: PAGE_WIDTH, height: PAGE_HEIGHT, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  return createLosslessSandwichPdfFromImage(png, OCR_RESULT, {}, 'cjk-text-layer');
}

function pageContent(doc: PDFDocument): string {
  const contents = doc.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams
    .map((ref) => doc.context.lookup(ref) as PDFRawStream)
    .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
    .join('\n');
}

function compositeFonts(doc: PDFDocument): Array<{ key: string; dict: PDFDict }> {
  const resources = doc.getPage(0).node.Resources() as PDFDict;
  const fontDict = resources.lookup(PDFName.of('Font'), PDFDict);
  return fontDict
    .keys()
    .map((key) => ({ key: key.decodeText(), dict: fontDict.lookup(key, PDFDict) }))
    .filter(({ dict }) => dict.get(PDFName.of('Subtype'))?.toString() === '/Type0');
}

function isPdfTextString(value: unknown): boolean {
  return value instanceof PDFString || value instanceof PDFHexString;
}

function textOf(value: unknown): string {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  throw new Error(`expected a PDF string, got ${String(value)}`);
}

describe('OCR CJK text layer composite font', () => {
  it('declares a well-formed Type 0 font under the name selected by Tf', async () => {
    const doc = await PDFDocument.load(await sandwichPdf());
    const fonts = compositeFonts(doc);
    expect(fonts).toHaveLength(1);
    const [{ key, dict: type0 }] = fonts;

    const usedFonts = [...pageContent(doc).matchAll(/\/([^\s/]+)\s+[\d.]+\s+Tf/g)].map((m) => m[1]);
    expect(usedFonts).toEqual(OCR_RESULT.lineBlocks!.flatMap((block) => block.words).map(() => key));

    expect(type0.get(PDFName.of('Encoding'))?.toString()).toBe('/Identity-H');
    const descendants = type0.lookup(PDFName.of('DescendantFonts'), PDFArray);
    expect(descendants.size()).toBe(1);
    const cidFont = descendants.lookup(0, PDFDict);
    expect(cidFont.get(PDFName.of('Subtype'))?.toString()).toBe('/CIDFontType2');

    const sysInfo = cidFont.lookup(PDFName.of('CIDSystemInfo'), PDFDict);
    const registry = sysInfo.get(PDFName.of('Registry'));
    const ordering = sysInfo.get(PDFName.of('Ordering'));
    expect(isPdfTextString(registry)).toBe(true);
    expect(isPdfTextString(ordering)).toBe(true);
    expect(registry).not.toBeInstanceOf(PDFName);
    expect(ordering).not.toBeInstanceOf(PDFName);
    expect(textOf(registry)).toBe('Adobe');
    expect(textOf(ordering)).toBe('Identity');
    expect((sysInfo.get(PDFName.of('Supplement')) as PDFNumber).asNumber()).toBe(0);

    const descriptor = cidFont.lookup(PDFName.of('FontDescriptor'), PDFDict);
    expect(descriptor.get(PDFName.of('Type'))?.toString()).toBe('/FontDescriptor');

    const toUnicode = type0.lookup(PDFName.of('ToUnicode'), PDFRawStream);
    const cmap = Buffer.from(decodePDFRawStream(toUnicode).decode()).toString('latin1');
    expect(cmap).toMatch(/begincodespacerange\s*<0000>\s*<FFFF>\s*endcodespacerange/);
  });

  oracleTest('pdftotext extracts Korean and mixed lines without syntax errors', ['pdftotext'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cjk-'));
    try {
      const pdfPath = path.join(dir, 'out.pdf');
      fs.writeFileSync(pdfPath, await sandwichPdf());
      const pdftotext = getOracleToolPath('pdftotext') as string;
      const result = spawnSync(pdftotext, ['-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('Syntax Error');
      const extracted = result.stdout
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      expect(extracted).toEqual(LINES);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
