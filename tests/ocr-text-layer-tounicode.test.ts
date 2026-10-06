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
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import {
  createLosslessSandwichPdfFromImage,
  createLosslessSandwichPdfFromPdf,
  createToUnicodeCMap,
  ensureUnicodeFont,
  type OcrResult,
} from '../src/lib/conversions/ocr-pdf-combiner';
import { TextLayerCidMap } from '../src/lib/conversions/ocr-text-layer-font';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';

/**
 * ISO 32000-1 §9.10.3: inside a ToUnicode `bfrange` only the last byte of a code may vary, so the
 * text layer maps one dense CID per used code point with `bfchar` entries whose destinations are
 * UTF-16BE (surrogate pairs for astral code points). Expected text below is the literal input;
 * extraction oracles are poppler, PyMuPDF and qpdf.
 */

const PAGE_WIDTH = 480;
const PAGE_HEIGHT = 320;
const LINE_HEIGHT = 24;
const LINE_PITCH = 40;
const LEFT_MARGIN = 10;
const WORD_PITCH = 110;
const WORD_WIDTH = 100;
const LINE_WIDTH = 440;
const BFCHAR_BLOCK_LIMIT = 100;
const MANY_CODE_POINTS_START = 0x4e00;
const MANY_CODE_POINTS_COUNT = 250;
const MANY_CODE_POINTS_PER_WORD = 5;
const ASTRAL_FALLBACK_PLANE_START = 0x20000;
const MAX_CID = 0xffff;
const LATIN1_MAX = 0xff;
const NARROW_ADVANCE = 500;
const WIDE_ADVANCE = 1000;

const ASTRAL_IDEOGRAPH = '\u{20BB7}';
const SIMPLE_FONT_LINE = '\u00C9\u00E9 \u00C5 \u00C5ngstr\u00F6m';
const DECOMPOSED_INPUT = 'Café Ångström';
const INPUT_LINES = [
  '한글 문서 검색',
  'ひらがな カタカナ',
  `${ASTRAL_IDEOGRAPH}野家 ${ASTRAL_IDEOGRAPH}`,
  SIMPLE_FONT_LINE,
  DECOMPOSED_INPUT,
];

function ocrResultFor(lines: string[], firstLine = 0): OcrResult {
  return {
    text: lines.join('\n'),
    confidence: 0.9,
    wordCount: lines.join(' ').split(' ').length,
    lines,
    lineBlocks: lines.map((line, index) => ({
      text: line,
      bbox: { x: LEFT_MARGIN, y: 20 + (firstLine + index) * LINE_PITCH, width: LINE_WIDTH, height: LINE_HEIGHT },
      words: line.split(' ').map((word, i) => ({
        text: word,
        bbox: {
          x: LEFT_MARGIN + i * WORD_PITCH,
          y: 20 + (firstLine + index) * LINE_PITCH,
          width: WORD_WIDTH,
          height: LINE_HEIGHT,
        },
      })),
    })),
  };
}

async function sandwichPdf(lines: string[], pageHeight = PAGE_HEIGHT): Promise<Buffer> {
  const png = await sharp({
    create: { width: PAGE_WIDTH, height: pageHeight, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  return createLosslessSandwichPdfFromImage(png, ocrResultFor(lines), {}, 'tounicode');
}

function withTempPdf<T>(pdf: Buffer, fn: (pdfPath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-tounicode-'));
  try {
    const pdfPath = path.join(dir, 'out.pdf');
    fs.writeFileSync(pdfPath, pdf);
    return fn(pdfPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pdftotextLines(pdfPath: string): string[] {
  const result = spawnSync(getOracleToolPath('pdftotext') as string, ['-enc', 'UTF-8', pdfPath, '-'], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('Syntax Error');
  return result.stdout
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim().normalize('NFC'))
    .filter(Boolean);
}

const PYMUPDF_SCRIPT = [
  'import json, sys',
  'import pymupdf',
  'doc = pymupdf.open(sys.argv[1])',
  'print(json.dumps([page.get_text("text") for page in doc]))',
].join('\n');

function pymupdfLines(pdfPath: string, normalize = true): string[] {
  const python = getOracleToolPath('python3');
  if (!python) throw new OracleToolMissingError('python3');
  const probe = spawnSync(python, ['-I', '-c', 'import pymupdf'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new OracleToolMissingError('pymupdf', 'PyMuPDF is not importable');
  const result = spawnSync(python, ['-I', '-c', PYMUPDF_SCRIPT, pdfPath], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  const pages = JSON.parse(result.stdout) as string[];
  return pages
    .join('\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .map((line) => (normalize ? line.normalize('NFC') : line))
    .filter(Boolean);
}

// Extraction tools may compose combining marks, so extracted text is compared after NFC.
const EXPECTED_LINES = INPUT_LINES.map((line) => line.normalize('NFC'));
// Pure Latin-1 lines stay on the simple Helvetica font; every other line (including the
// decomposed one, which carries combining marks) goes through the composite font, code point
// for code point as recognized.
const COMPOSITE_FONT_LINES = INPUT_LINES.filter((line) => line !== SIMPLE_FONT_LINE);

// --- Independent PDF structure readers (no code from the module under test) ---

function decodedStream(stream: PDFRawStream): string {
  return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
}

function pageContent(doc: PDFDocument): string {
  const contents = doc.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams
    .map((ref) => doc.context.lookup(ref) as PDFRawStream)
    .map(decodedStream)
    .join('\n');
}

function toUnicodeStream(doc: PDFDocument, type0: PDFDict): PDFRawStream {
  return doc.context.lookup(type0.get(PDFName.of('ToUnicode'))) as PDFRawStream;
}

function type0FontEntry(doc: PDFDocument): { key: string; dict: PDFDict } {
  const resources = doc.getPage(0).node.Resources() as PDFDict;
  const fonts = resources.lookup(PDFName.of('Font'), PDFDict);
  const type0 = fonts
    .keys()
    .map((key) => ({ key: key.decodeText(), dict: fonts.lookup(key, PDFDict) }))
    .filter(({ dict }) => dict.get(PDFName.of('Subtype'))?.toString() === '/Type0');
  expect(type0).toHaveLength(1);
  return type0[0];
}

function type0Font(doc: PDFDocument): PDFDict {
  return type0FontEntry(doc).dict;
}

interface ParsedToUnicode {
  cmap: string;
  blockSizes: number[];
  map: Map<number, string>;
}

function utf16beHexToString(hex: string): string {
  const units: number[] = [];
  for (let i = 0; i < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCharCode(...units);
}

function parseToUnicode(doc: PDFDocument): ParsedToUnicode {
  const cmap = decodedStream(toUnicodeStream(doc, type0Font(doc)));
  const blockSizes: number[] = [];
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/(\d+)\s+beginbfchar\s+([\s\S]*?)endbfchar/g)) {
    const lines = block[2].split('\n').filter((l) => l.trim());
    blockSizes.push(Number(block[1]));
    expect(lines).toHaveLength(Number(block[1]));
    for (const line of lines) {
      const m = /^<([0-9A-F]{4})>\s+<([0-9A-F]{4}(?:[0-9A-F]{4})?)>$/.exec(line.trim());
      expect(m, `malformed bfchar line: ${line}`).not.toBeNull();
      const cid = parseInt((m as RegExpExecArray)[1], 16);
      expect(map.has(cid)).toBe(false);
      map.set(cid, utf16beHexToString((m as RegExpExecArray)[2]));
    }
  }
  return { cmap, blockSizes, map };
}

/** Decodes every string shown with the composite font through the document's own ToUnicode map. */
function decodeShownText(content: string, fontKey: string, map: Map<number, string>): string[] {
  const lines: string[] = [];
  const showOps = new RegExp(`/${fontKey}\\s+[\\d.]+\\s+Tf[^\\[]*\\[([^\\]]*)\\]\\s*TJ`, 'g');
  for (const tj of content.matchAll(showOps)) {
    let text = '';
    for (const hex of tj[1].matchAll(/<([0-9A-Fa-f]*)>/g)) {
      expect(hex[1].length % 4).toBe(0);
      for (let i = 0; i < hex[1].length; i += 4) {
        const cid = parseInt(hex[1].slice(i, i + 4), 16);
        const unicode = map.get(cid);
        expect(unicode, `CID ${cid} has no ToUnicode mapping`).toBeDefined();
        text += unicode;
      }
    }
    lines.push(text);
  }
  return lines;
}

describe('OCR text layer ToUnicode (ISO 32000-1 §9.10.3)', () => {
  it('maps one dense CID per used code point with bfchar and no bfrange', async () => {
    const doc = await PDFDocument.load(await sandwichPdf(INPUT_LINES));
    const { cmap, map, blockSizes } = parseToUnicode(doc);

    expect(cmap).not.toContain('beginbfrange');
    expect(cmap).toMatch(/begincodespacerange\s*<0000>\s*<FFFF>\s*endcodespacerange/);
    expect(blockSizes.every((n) => n >= 1 && n <= BFCHAR_BLOCK_LIMIT)).toBe(true);

    const used = new Set<string>();
    for (const line of COMPOSITE_FONT_LINES) for (const ch of line) used.add(ch);
    used.add(' ');
    const mapped = [...map.values()];
    expect([...mapped].sort()).toEqual([...used].sort());
    // Dense CIDs starting right after .notdef.
    expect([...map.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: map.size }, (_, i) => i + 1));
    // The astral ideograph is one CID whose destination is the surrogate pair D842 DFB7.
    expect(cmap).toMatch(/<[0-9A-F]{4}> <D842DFB7>/);
    expect(cmap).not.toMatch(/<D842> <|<DFB7> </);
  });

  it('shows text with CIDs that decode back to the input through the document ToUnicode', async () => {
    const doc = await PDFDocument.load(await sandwichPdf(INPUT_LINES));
    const { map } = parseToUnicode(doc);
    const shown = decodeShownText(pageContent(doc), type0FontEntry(doc).key, map);
    expect(shown.map((l) => l.replace(/\s+/g, ' ').trim()).sort()).toEqual([...COMPOSITE_FONT_LINES].sort());
  });

  it('advertises one /W width per used CID', async () => {
    const doc = await PDFDocument.load(await sandwichPdf(INPUT_LINES));
    const { map } = parseToUnicode(doc);
    const cidFont = type0Font(doc).lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
    const w = cidFont.lookup(PDFName.of('W'), PDFArray);

    expect((w.lookup(0, PDFNumber) as PDFNumber).asNumber()).toBe(1);
    const widths = w.lookup(1, PDFArray);
    expect(widths.size()).toBe(map.size);
    for (let i = 0; i < widths.size(); i++) {
      const unicode = map.get(i + 1) as string;
      let expectedWidth = (unicode.codePointAt(0) as number) <= LATIN1_MAX ? NARROW_ADVANCE : WIDE_ADVANCE;
      // combining marks (U+0301, U+030A in the decomposed line) take no space
      if (/\p{M}/u.test(unicode)) expectedWidth = 0;
      expect((widths.lookup(i, PDFNumber) as PDFNumber).asNumber()).toBe(expectedWidth);
    }
    expect(w.size()).toBe(2);
  });

  it('splits more than 100 distinct characters into bfchar blocks of at most 100', async () => {
    const chars = Array.from({ length: MANY_CODE_POINTS_COUNT }, (_, i) =>
      String.fromCodePoint(MANY_CODE_POINTS_START + i)
    );
    const lines: string[] = [];
    for (let i = 0; i < chars.length; i += MANY_CODE_POINTS_PER_WORD) {
      lines.push(chars.slice(i, i + MANY_CODE_POINTS_PER_WORD).join(''));
    }
    // One line per row is too tall for the page; pack five words per line.
    const packed: string[] = [];
    for (let i = 0; i < lines.length; i += 5) packed.push(lines.slice(i, i + 5).join(' '));
    const doc = await PDFDocument.load(await sandwichPdf(packed, PAGE_HEIGHT * 2));
    const { map, blockSizes } = parseToUnicode(doc);

    expect(map.size).toBe(MANY_CODE_POINTS_COUNT + 1); // + U+0020 separating words
    expect(blockSizes).toEqual([100, 100, 51]);
    for (const ch of chars) expect([...map.values()]).toContain(ch);
  });

  oracleTest('pdftotext round-trips Hangul, kana, astral CJK and Latin diacritics', ['pdftotext'], async () => {
    const pdf = await sandwichPdf(INPUT_LINES);
    withTempPdf(pdf, (pdfPath) => {
      expect(pdftotextLines(pdfPath)).toEqual(EXPECTED_LINES);
    });
  });

  oracleTest('PyMuPDF round-trips Hangul, kana, astral CJK and Latin diacritics', ['python3'], async () => {
    const pdf = await sandwichPdf(INPUT_LINES);
    withTempPdf(pdf, (pdfPath) => {
      expect(pymupdfLines(pdfPath)).toEqual(EXPECTED_LINES);
    });
  });

  oracleTest('astral ideograph extracts as one character, not two replacement characters', ['pdftotext'], async () => {
    const pdf = await sandwichPdf([`${ASTRAL_IDEOGRAPH}`]);
    withTempPdf(pdf, (pdfPath) => {
      const extracted = pdftotextLines(pdfPath).join('');
      expect([...extracted]).toEqual([ASTRAL_IDEOGRAPH]);
      expect(extracted).not.toContain('�');
    });
  });

  oracleTest('a second OCR pass keeps the first pass text layer readable', ['pdftotext'], async () => {
    const firstPass = ['한글 문서', 'ABC 日本語'];
    const secondPass = ['ZZZ 漢字'];
    const once = await sandwichPdf(firstPass);
    const twice = await createLosslessSandwichPdfFromPdf(
      once,
      new Map([[1, ocrResultFor(secondPass, firstPass.length + 1)]])
    );
    withTempPdf(twice, (pdfPath) => {
      const lines = pdftotextLines(pdfPath);
      for (const line of [...firstPass, ...secondPass]) expect(lines, line).toContain(line);
    });
  });

  oracleTest('keeps compatibility ideographs and letterlike symbols as recognized', ['python3'], async () => {
    // NFC would rewrite U+F900 to U+8C48 and U+2126 to U+03A9; the text layer must carry what OCR read.
    const line = '\uF900 \u2126 \u212B';
    const pdf = await sandwichPdf([line]);
    withTempPdf(pdf, (pdfPath) => {
      expect(pymupdfLines(pdfPath, false)).toEqual([line]);
    });
  });

  oracleTest('qpdf --check accepts the output', ['qpdf'], async () => {
    const pdf = await sandwichPdf(INPUT_LINES);
    withTempPdf(pdf, (pdfPath) => {
      const result = spawnSync(getOracleToolPath('qpdf') as string, ['--check', pdfPath], { encoding: 'utf8' });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('No syntax or stream encoding errors found');
    });
  });
});

describe('createToUnicodeCMap / TextLayerCidMap', () => {
  it('serializes CID to code point pairs as bfchar with UTF-16BE destinations', () => {
    const cmap = createToUnicodeCMap([
      [1, 0x41],
      [2, 0xac00],
      [3, 0x20bb7],
    ]);
    expect(cmap.match(/\bbegin\w+/g)).toEqual(['begincmap', 'begincodespacerange', 'beginbfchar']);
    expect(cmap.split('\n').filter((line) => /^<[0-9A-F]{4}> </.test(line))).toEqual([
      '<0000> <FFFF>',
      '<0001> <0041>',
      '<0002> <AC00>',
      '<0003> <D842DFB7>',
    ]);
    expect(cmap).toMatch(/\n3 beginbfchar\n/);
  });

  it('emits no mappings (and no full-range bfrange) when nothing is used', () => {
    const cmap = createToUnicodeCMap();
    expect(cmap.match(/\bbegin\w+/g)).toEqual(['begincmap', 'begincodespacerange']);
    expect(cmap).toMatch(/begincodespacerange\s*<0000>\s*<FFFF>\s*endcodespacerange/);
  });

  it('rejects surrogate code points, out-of-space CIDs and duplicate CIDs with a typed error', () => {
    expect(() => createToUnicodeCMap([[1, 0xd800]])).toThrow(ConversionFailedError);
    expect(() => createToUnicodeCMap([[0x10000, 0x41]])).toThrow(ConversionFailedError);
    expect(() =>
      createToUnicodeCMap([
        [1, 0x41],
        [1, 0x42],
      ])
    ).toThrow(ConversionFailedError);
  });

  it('assigns CIDs densely from 1 in first-use order and reuses them', () => {
    const cids = new TextLayerCidMap();
    expect(cids.encodeText('ab a')).toBe('0001' + '0002' + '0003' + '0001');
    expect(cids.entries()).toEqual([
      [1, 0x61],
      [2, 0x62],
      [3, 0x20],
    ]);
  });

  it('keeps decomposed input as recognized: one CID per code point, no normalization', () => {
    const cids = new TextLayerCidMap();
    expect(cids.encodeText('e\u0301')).toBe('00010002');
    expect(cids.entries()).toEqual([
      [1, 0x65],
      [2, 0x301],
    ]);
  });

  it('rejects an unpaired surrogate with a typed error', () => {
    expect(() => new TextLayerCidMap().encodeText('a\ud800b')).toThrow(ConversionFailedError);
  });

  it('fails closed when the 2-byte CID space is exhausted', () => {
    const cids = new TextLayerCidMap();
    for (let i = 0; i < MAX_CID; i++) cids.cidFor(ASTRAL_FALLBACK_PLANE_START + i);
    expect(cids.size).toBe(MAX_CID);
    expect(() => cids.cidFor(ASTRAL_FALLBACK_PLANE_START + MAX_CID)).toThrow(ConversionFailedError);
  });

  it('ensureUnicodeFont keeps the ToUnicode stream in sync with later allocations', async () => {
    const doc = await PDFDocument.create();
    const font = ensureUnicodeFont(doc);
    expect(font.encodeText('\u{20BB7}')).toBe('0001');
    const type0: PDFDict = doc.context.lookup(font.fontRef, PDFDict);
    const first = decodedStream(toUnicodeStream(doc, type0));
    expect(first).toContain('<0001> <D842DFB7>');
    expect(font.encodeText('Z')).toBe('0002');
    const second = decodedStream(toUnicodeStream(doc, type0));
    expect(second).toContain('<0002> <005A>');
  });
});
