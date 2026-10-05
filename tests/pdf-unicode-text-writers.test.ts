import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { buildHwpCompoundFile } from '../src/lib/conversions/hwp';
import { parseHtmlToPdfBlocks } from '../src/lib/conversions/html-blocks';
import { executeWorkerConversion } from '../src/worker/engines';
import {
  ComplexScriptRequiresNativeEngineError,
  ConversionFailedError,
  EngineUnavailableError,
} from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import {
  extractFontsWithExternalPdffonts,
  OracleToolMissingError,
  requireOracleTool,
  type ExternalOracleTool,
} from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
import { synthesizeHwp5CompoundCorpus } from './helpers/corpus-synthesizer';

/**
 * In-process text writers (txt, md, html, hwp to PDF) must embed fonts that really cover the text,
 * carry no injected branding, and keep HTML structure. Poppler (pdftotext, pdffonts, pdfinfo,
 * pdfimages) is the oracle; fontconfig (fc-list) decides whether a covering font is installed.
 */

const SAMPLES = {
  korean: ['한국어 문서 변환 시험 문장입니다.', '두 번째 문단도 그대로 보존됩니다.'],
  japanese: ['日本語の文書変換テストです。', '二番目の段落もそのまま残ります。'],
  chinese: ['中文文档转换测试句子。', '第二段落也应完整保留。'],
  latin: ['Plain Latin conversion sample: café, naïve, façade.', 'A second paragraph stays intact.'],
} as const;

const ARABIC_LINE = 'مرحبا بكم في اختبار تحويل المستندات';
const BRANDING = /EasyConvert|Generated with/i;
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const POPPLER_TOOLS: ExternalOracleTool[] = ['pdftotext', 'pdffonts', 'pdfinfo', 'fc-list'];
const LIBREOFFICE_TOOLS: ExternalOracleTool[] = ['soffice', ...POPPLER_TOOLS];
const LIBREOFFICE_TIMEOUT_MS = 180_000;
const UNASSIGNED_CODE_POINT = '͸';

type TextSource = 'txt' | 'md' | 'html' | 'hwp';
const TEXT_SOURCES: TextSource[] = ['txt', 'md', 'html', 'hwp'];

function runPoppler(tool: ExternalOracleTool, args: string[], pdf: Buffer): string {
  const binary = requireOracleTool(tool);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-unicode-oracle-'));
  const file = path.join(dir, 'input.pdf');
  try {
    fs.writeFileSync(file, pdf);
    const trailing = tool === 'pdftotext' ? [file, '-'] : [file];
    return execFileSync(binary, [...args, ...trailing], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pdfText(pdf: Buffer, layout = false): string {
  return runPoppler('pdftotext', layout ? ['-q', '-layout'] : ['-q'], pdf);
}

/** NFC, without bidi embedding marks, whitespace runs collapsed to one space. */
function normalizeText(text: string): string {
  return text.normalize('NFC').replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim();
}

function withoutWhitespace(text: string): string {
  return text.normalize('NFC').replace(BIDI_CONTROLS, '').replace(/\s+/g, '');
}

/** Whether fontconfig lists an embeddable outline font (not colour, not a placeholder-box font) for the code point. */
function hasUsableInstalledFont(codePoint: number): boolean {
  const fcList = requireOracleTool('fc-list');
  const listing = execFileSync(fcList, ['--format', '%{fontformat}|%{color}|%{family}|%{file}\\n', `:charset=${codePoint.toString(16)}`], {
    encoding: 'utf-8',
  });
  return listing.split('\n').some((line) => {
    const [format, color, family, file] = line.split('|');
    return (
      (format === 'TrueType' || format === 'CFF') &&
      color !== 'True' &&
      !/unifont|last\s*resort/i.test(family ?? '') &&
      /\.(ttf|otf|ttc)$/i.test(file ?? '')
    );
  });
}

/** Skips (strict mode: fails) unless fontconfig lists an embeddable outline font for every character. */
function requireCoveringFonts(text: string): void {
  const uncovered: string[] = [];
  for (const ch of new Set(Array.from(text))) {
    if (/\s/u.test(ch)) continue;
    const codePoint = ch.codePointAt(0) as number;
    if (!hasUsableInstalledFont(codePoint)) uncovered.push(`U+${codePoint.toString(16).toUpperCase()}`);
  }
  if (uncovered.length > 0) {
    throw new OracleToolMissingError('font', `No installed outline font covers ${uncovered.slice(0, 8).join(', ')}`);
  }
}

/** Runs `operation` with an environment variable set, restoring the previous value afterwards. */
async function withEnvValue<T>(name: string, value: string, operation: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/**
 * Writes an executable stand-in for the LibreOffice binary that answers profile warm-up (--help)
 * and then runs `conversion` for real conversions, so the engine meets a genuine failing process.
 */
function failingSoffice(conversion: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failing-soffice-'));
  const file = path.join(dir, 'soffice');
  fs.writeFileSync(file, `#!/bin/sh\ncase "$*" in *--help*) exit 0;; esac\n${conversion}\n`, { mode: 0o755 });
  return file;
}

const A4_LANDSCAPE = /Page size:\s+841\.89 x 595\.(?:28|3\d*) pts/;
const A4_PORTRAIT = /Page size:\s+595\.(?:28|3\d*) x 841\.89 pts/;

/**
 * Times `run` on a small and a large input. Growth well under the square of the size ratio shows
 * the work is linear (a quadratic step would grow by the square); a generous ceiling catches
 * hangs. Used instead of tight wall-clock budgets, which trip under parallel test load.
 */
async function measureGrowth<T>(run: (size: number) => Promise<T>, small: number, large: number): Promise<{ growth: number; largeMs: number; result: T }> {
  const smallStarted = Date.now();
  await run(small);
  const smallMs = Date.now() - smallStarted;
  const largeStarted = Date.now();
  const result = await run(large);
  const largeMs = Date.now() - largeStarted;
  return { growth: largeMs / Math.max(smallMs, 1), largeMs, result };
}

const GROWTH_CEILING_MS = 10_000;

/** Settles a promise into its value or its rejection reason. */
function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

function buildSource(source: TextSource, lines: readonly string[]): Buffer {
  if (source === 'txt') return Buffer.from(`${lines.join('\n')}\n`, 'utf-8');
  if (source === 'md') return Buffer.from(`${lines.join('\n\n')}\n`, 'utf-8');
  if (source === 'html') {
    const body = lines.map((line) => `<p>${line}</p>`).join('\n');
    return Buffer.from(
      `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Sample title</title></head><body>\n${body}\n</body></html>\n`,
      'utf-8'
    );
  }
  return buildHwpCompoundFile({ paragraphs: lines.map((text) => ({ text })), compressed: true });
}

function expectEmbeddedFontsOnly(pdf: Buffer): void {
  const fonts = extractFontsWithExternalPdffonts(pdf);
  expect(fonts.length).toBeGreaterThan(0);
  for (const font of fonts) {
    expect({ name: font.name, embedded: font.emb }).toEqual({ name: font.name, embedded: true });
  }
}

function expectNoBranding(pdf: Buffer): void {
  expect(pdfText(pdf)).not.toMatch(BRANDING);
  expect(runPoppler('pdfinfo', [], pdf)).not.toMatch(BRANDING);
}

/** The JPEG streams of the PDF exactly as stored, extracted with `pdfimages -j`. */
function extractedJpegs(pdf: Buffer): Buffer[] {
  const binary = requireOracleTool('pdfimages');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfimages-j-'));
  try {
    const file = path.join(dir, 'input.pdf');
    fs.writeFileSync(file, pdf);
    execFileSync(binary, ['-j', file, path.join(dir, 'img')]);
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jpg'))
      .sort()
      .map((name) => fs.readFileSync(path.join(dir, name)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Number of images pdfimages lists in the PDF. */
function imageCount(pdf: Buffer): number {
  return runPoppler('pdfimages', ['-list'], pdf)
    .split('\n')
    .slice(2)
    .filter((line) => line.trim().length > 0).length;
}

/** Index of the first line at or after `from` matching the pattern; fails when none does. */
function lineIndex(lines: string[], pattern: RegExp, from: number): number {
  const index = lines.findIndex((line, i) => i >= from && pattern.test(line));
  expect({ pattern: pattern.source, found: index >= 0 }).toEqual({ pattern: pattern.source, found: true });
  return index;
}

function linkTargets(pdfBytes: Buffer): Promise<string[]> {
  return PDFDocument.load(pdfBytes).then((pdf) => {
    const uris: string[] = [];
    for (const page of pdf.getPages()) {
      const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const annot = annots.lookup(i, PDFDict);
        const action = annot.lookupMaybe(PDFName.of('A'), PDFDict);
        const uri = action?.lookupMaybe(PDFName.of('URI'), PDFString);
        if (uri) uris.push(uri.decodeText());
      }
    }
    return uris;
  });
}

/** Independent minimal PNG encoder (8-bit RGB, filter 0) for an image embedding fixture. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function buildRgbPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set([x * 60, y * 80, 200], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function buildDocx(paragraphs: readonly string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('In-process text-to-PDF writers embed covering Unicode fonts and no branding', () => {
  for (const [language, lines] of Object.entries(SAMPLES)) {
    for (const source of TEXT_SOURCES) {
      oracleTest(`${source} to pdf keeps ${language} text exactly, with embedded fonts and no branding`, POPPLER_TOOLS, async () => {
        requireCoveringFonts(lines.join(''));
        const result = await convertFile(buildSource(source, lines), source, 'pdf', {}, `sample.${source}`);

        expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(normalizeText(pdfText(result.buffer))).toBe(normalizeText(lines.join(' ')));
        expectEmbeddedFontsOnly(result.buffer);
        expectNoBranding(result.buffer);
      });
    }
  }

  oracleTest('wraps a long multi-page Korean and Chinese text without losing or reordering characters', POPPLER_TOOLS, async () => {
    const paragraph = `${SAMPLES.korean[0]} ${SAMPLES.chinese[0]} ${SAMPLES.korean[1]}`;
    requireCoveringFonts(paragraph);
    const lines = Array.from({ length: 120 }, (_, i) => `${i + 1}. ${paragraph}`);
    const result = await convertFile(Buffer.from(lines.join('\n'), 'utf-8'), 'txt', 'pdf', {}, 'long.txt');

    const pages = Number(/Pages:\s+(\d+)/.exec(runPoppler('pdfinfo', [], result.buffer))?.[1]);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(withoutWhitespace(pdfText(result.buffer))).toBe(withoutWhitespace(lines.join('')));
    expectNoBranding(result.buffer);
  });

  oracleTest('renders hwp tables row by row without truncating long cells', POPPLER_TOOLS, async () => {
    const longCell = '이 셀에는 열 너비보다 훨씬 긴 문장이 들어 있어서 여러 줄로 나뉘어야 하며 말줄임표로 잘리면 안 됩니다.';
    const rows = [
      ['품목', '수량', '비고'],
      ['사과', '3', longCell],
      ['배', '5', '없음'],
    ];
    requireCoveringFonts(rows.flat().join(''));
    const hwp = buildHwpCompoundFile({ paragraphs: [{ text: '재고 현황' }], tables: [{ rows }], compressed: true });
    const result = await convertFile(hwp, 'hwp', 'pdf', {}, 'table.hwp');

    const layout = pdfText(result.buffer, true).split('\n');
    const title = lineIndex(layout, /재고 현황/, 0);
    const header = lineIndex(layout, /품목\s+수량\s+비고/, title + 1);
    const apple = lineIndex(layout, /사과\s+3/, header + 1);
    lineIndex(layout, /배\s+5\s+없음/, apple + 1);
    expect(withoutWhitespace(pdfText(result.buffer))).toContain(withoutWhitespace(longCell));
    expect(pdfText(result.buffer)).not.toContain('…');
    expectEmbeddedFontsOnly(result.buffer);
    expectNoBranding(result.buffer);
  });

  oracleTest('docx and csv in-process PDF writers embed fonts covering Korean text', POPPLER_TOOLS, async () => {
    const lines = SAMPLES.korean;
    requireCoveringFonts(lines.join(''));
    const docx = await convertFile(await buildDocx(lines), 'docx', 'pdf', {}, 'report.docx');
    expect(normalizeText(pdfText(docx.buffer))).toContain(normalizeText(lines.join(' ')));
    expectEmbeddedFontsOnly(docx.buffer);

    const csv = await convertFile(Buffer.from(`이름,설명\n사과,${lines[0]}\n`, 'utf-8'), 'csv', 'pdf', {}, 'data.csv');
    const csvText = normalizeText(pdfText(csv.buffer));
    expect(csvText).toContain('이름');
    expect(csvText).toContain('설명');
    expect(csvText).toContain('사과');
    expectEmbeddedFontsOnly(csv.buffer);
  });

  oracleTest('lists installed fonts once for concurrent first calls and retries a failed listing later', ['fc-list'], async () => {
    const RETRY_AFTER_MS = 60_000;
    const realFcList = requireOracleTool('fc-list');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-list-wrapper-'));
    const spawns = path.join(dir, 'spawns');
    const wrapper = path.join(dir, 'fc-list');
    const writeWrapper = (body: string): void => fs.writeFileSync(wrapper, `#!/bin/sh\necho spawn >> '${spawns}'\n${body}\n`, { mode: 0o755 });
    const spawnCount = (): number => (fs.existsSync(spawns) ? fs.readFileSync(spawns, 'utf-8').split('\n').filter(Boolean).length : 0);

    vi.resetModules();
    const fonts = await import('../src/lib/conversions/pdf-fonts');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withEnvValue('FC_LIST_PATH', wrapper, async () => {
        writeWrapper('exit 1');
        await Promise.all(Array.from({ length: 5 }, () => fonts.loadFontCoverageIndex()));
        await fonts.loadFontCoverageIndex();
        const afterFailure = spawnCount();

        writeWrapper(`exec '${realFcList}' "$@"`);
        await fonts.loadFontCoverageIndex();
        const beforeRetryInterval = spawnCount();

        vi.setSystemTime(Date.now() + RETRY_AFTER_MS + 1);
        await Promise.all(Array.from({ length: 5 }, () => fonts.loadFontCoverageIndex()));
        const afterRetry = spawnCount();
        await fonts.loadFontCoverageIndex();
        vi.setSystemTime(Date.now() + RETRY_AFTER_MS + 1);
        await fonts.loadFontCoverageIndex();

        expect({ afterFailure, beforeRetryInterval, afterRetry, afterSuccess: spawnCount() }).toEqual({
          afterFailure: 1,
          beforeRetryInterval: 1,
          afterRetry: 2,
          afterSuccess: 2,
        });
      });
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it('rejects unassigned, private-use and noncharacter code points with ConversionFailedError (400)', async () => {
    for (const [label, ch] of [
      ['U+0378', UNASSIGNED_CODE_POINT],
      ['U+E000', '\ue000'],
      ['U+FFFF', '\uffff'],
    ]) {
      const { error } = await settle(convertFile(Buffer.from(`Latin text then ${ch} then more`, 'utf-8'), 'txt', 'pdf', {}, 'gap.txt'));
      expect({ label, name: (error as Error)?.name }).toEqual({ label, name: 'ConversionFailedError' });
      expect((error as Error).message).toContain(label);
    }
  });

  oracleTest('fails with EngineUnavailableError when no installed font has a glyph for an assigned character', ['fc-list'], async () => {
    // Assigned characters of historic scripts; the first one no installed outline font covers is used.
    const candidates = [0x13000, 0x12000, 0x17000, 0x1b170, 0x16e40, 0x10d00, 0x11400, 0x1e900, 0x10000];
    const uncovered = candidates.find((codePoint) => !hasUsableInstalledFont(codePoint));
    if (uncovered === undefined) throw new OracleToolMissingError('font', 'Every candidate historic-script character has an installed font');
    const label = `U+${uncovered.toString(16).toUpperCase()}`;
    const { error } = await settle(convertFile(Buffer.from(`Latin ${String.fromCodePoint(uncovered)} text`, 'utf-8'), 'txt', 'pdf', {}, 'gap.txt'));
    expect((error as Error).name).toBe('EngineUnavailableError');
    expect((error as EngineUnavailableError).engineName).toBe('unicode-font');
    expect((error as Error).message).toContain(label);
  });

  oracleTest('settles thousands of distinct uncommon Han characters with one font listing, not one per character', ['pdftotext', 'fc-list'], async () => {
    const EXT_B_FIRST = 0x20000;
    const DISTINCT = 3000;
    const realFcList = requireOracleTool('fc-list');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-list-count-'));
    const spawns = path.join(dir, 'spawns');
    const wrapper = path.join(dir, 'fc-list');
    fs.writeFileSync(wrapper, `#!/bin/sh\necho spawn >> '${spawns}'\nexec '${realFcList}' "$@"\n`, { mode: 0o755 });
    let text = 'Han Extension B: ';
    for (let i = 0; i < DISTINCT; i++) text += String.fromCodePoint(EXT_B_FIRST + i);

    vi.resetModules();
    const fresh = await import('../src/lib/conversions/index');
    const started = Date.now();
    const { value, error } = await withEnvValue('FC_LIST_PATH', wrapper, () =>
      settle(fresh.convertFile(Buffer.from(text, 'utf-8'), 'txt', 'pdf', {}, 'ext-b.txt'))
    );
    const elapsed = Date.now() - started;
    vi.resetModules();
    const spawnCount = fs.readFileSync(spawns, 'utf-8').split('\n').filter(Boolean).length;
    expect({ spawnCount, underCeiling: elapsed < GROWTH_CEILING_MS, elapsed }).toEqual({ spawnCount: 1, underCeiling: true, elapsed });
    if (value) {
      expect(withoutWhitespace(pdfText(value.buffer))).toBe(withoutWhitespace(text));
    } else {
      expect((error as Error).name).toBe('EngineUnavailableError');
      expect((error as EngineUnavailableError).engineName).toBe('unicode-font');
      const reported = Number.parseInt(/U\+([0-9A-F]{5})/.exec((error as Error).message)?.[1] ?? '0', 16);
      expect(reported).toBeGreaterThanOrEqual(EXT_B_FIRST);
      expect(reported).toBeLessThan(EXT_B_FIRST + DISTINCT);
    }
  }, 120_000);

  oracleTest('renders the golden HWP fixture with its paragraphs and table rows in order', POPPLER_TOOLS, async () => {
    const corpus = synthesizeHwp5CompoundCorpus();
    const expected = [
      ...corpus.doc.paragraphs.map((paragraph) => paragraph.text),
      ...(corpus.doc.tables ?? []).flatMap((table) => table.rows.flat()),
    ].join('');
    const result = await convertFile(corpus.buffer, 'hwp', 'pdf', {}, 'enterprise-compound-document.hwp');
    expect(withoutWhitespace(pdfText(result.buffer, true))).toBe(withoutWhitespace(expected));
    expectEmbeddedFontsOnly(result.buffer);
    expectNoBranding(result.buffer);
  });

  it('keeps refusing Arabic in the in-process writer, which cannot shape it', async () => {
    const error = await convertFile(buildSource('hwp', [ARABIC_LINE]), 'hwp', 'pdf', {}, 'arabic.hwp').then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(ComplexScriptRequiresNativeEngineError);
    expect((error as Error).name).toBe('ComplexScriptRequiresNativeEngineError');
    expect((error as Error).message).toMatch(/\(Arabic\)/);
  });
});

describe('In-process PDF layout limits', () => {
  oracleTest('wraps a 1 MB unbroken token in linear time without losing characters', ['pdftotext'], async () => {
    // Growth, not wall-clock: 4x the input must cost well under the 16x a quadratic wrap would.
    const SMALL_BYTES = 256 * 1024;
    const TOKEN_BYTES = 4 * SMALL_BYTES;
    const MAX_GROWTH = 8;
    const CEILING_MS = 10_000;
    const timed = async (bytes: number): Promise<{ elapsed: number; pdf: Buffer }> => {
      const started = Date.now();
      const result = await convertFile(Buffer.from('a'.repeat(bytes), 'utf-8'), 'txt', 'pdf', {}, 'token.txt');
      return { elapsed: Date.now() - started, pdf: result.buffer };
    };
    const small = await timed(SMALL_BYTES);
    const large = await timed(TOKEN_BYTES);
    const growth = large.elapsed / Math.max(small.elapsed, 1);
    expect({ linear: growth < MAX_GROWTH, underCeiling: large.elapsed < CEILING_MS, growth, ms: large.elapsed }).toEqual({
      linear: true,
      underCeiling: true,
      growth,
      ms: large.elapsed,
    });
    const extracted = withoutWhitespace(pdfText(large.pdf));
    expect(extracted.length).toBe(TOKEN_BYTES);
    expect(extracted).toBe('a'.repeat(TOKEN_BYTES));
  }, 120_000);

  oracleTest('wraps long runs of spaces and tabs in linear time without losing the text around them', ['pdftotext'], async () => {
    // Growth, not wall clock: 8x the input must cost well under the 64x a quadratic wrap would.
    const SMALL = 25_000;
    const LARGE = 8 * SMALL;
    const MAX_GROWTH = 20;
    const CEILING_MS = 10_000;
    for (const [label, whitespace] of [
      ['spaces', ' '],
      ['tabs', '\t'],
    ] as const) {
      const timed = async (count: number): Promise<{ elapsed: number; pdf: Buffer }> => {
        const started = Date.now();
        const result = await convertFile(Buffer.from(`start${whitespace.repeat(count)}end`, 'utf-8'), 'txt', 'pdf', {}, 'gap.txt');
        return { elapsed: Date.now() - started, pdf: result.buffer };
      };
      const small = await timed(SMALL);
      const large = await timed(LARGE);
      const growth = large.elapsed / Math.max(small.elapsed, 1);
      expect({ label, linear: growth < MAX_GROWTH, underCeiling: large.elapsed < CEILING_MS, growth, ms: large.elapsed }).toEqual({
        label,
        linear: true,
        underCeiling: true,
        growth,
        ms: large.elapsed,
      });
      expect(withoutWhitespace(pdfText(large.pdf))).toBe('startend');
    }
  }, 120_000);

  oracleTest('allows up to 32 combining marks on one character and refuses longer runs', ['pdftotext'], async () => {
    const MARK_CAP = 32;
    // Distinct marks (U+0300 onwards): pdftotext drops identical glyphs drawn at the same spot.
    const marks = Array.from({ length: MARK_CAP }, (_, i) => String.fromCodePoint(0x300 + i)).join('');
    requireCoveringFonts(marks);
    const accepted = await convertFile(Buffer.from(`ok a${marks} end`, 'utf-8'), 'txt', 'pdf', {}, 'marks.txt');
    // pdftotext orders stacked marks by position, so compare the characters as a multiset.
    const sortedCharacters = (text: string): string => Array.from(withoutWhitespace(text).normalize('NFD')).sort().join('');
    expect(sortedCharacters(pdfText(accepted.buffer))).toBe(sortedCharacters(`oka${marks}end`));
    const { error } = await settle(convertFile(Buffer.from(`a${'\u0301'.repeat(MARK_CAP + 1)}`, 'utf-8'), 'txt', 'pdf', {}, 'marks.txt'));
    expect((error as Error)?.name).toBe('ConversionFailedError');
    expect((error as Error).message).toMatch(/33 combining marks/);
  });

  oracleTest('wraps a long unbroken token inside an HTML paragraph without losing characters', ['pdftotext'], async () => {
    // 4x the token must cost well under the 16x a quadratic wrap would.
    const MAX_GROWTH = 8;
    const { growth, largeMs, result } = await measureGrowth(
      (size) => convertFile(Buffer.from(`<p>start ${'x'.repeat(size)} end</p>`, 'utf-8'), 'html', 'pdf', {}, 'token.html'),
      12_500,
      50_000
    );
    expect({ linear: growth < MAX_GROWTH, underCeiling: largeMs < GROWTH_CEILING_MS, growth, largeMs }).toEqual({
      linear: true,
      underCeiling: true,
      growth,
      largeMs,
    });
    expect(withoutWhitespace(pdfText(result.buffer))).toBe(`start${'x'.repeat(50_000)}end`);
  }, 120_000);

  it('refuses list and quote nesting too deep to leave room for text', async () => {
    for (const [label, html] of [
      ['blockquote', `${'<blockquote>'.repeat(40)}HelloWorld${'</blockquote>'.repeat(40)}`],
      ['ul', `${'<ul><li>'.repeat(30)}HelloWorld${'</li></ul>'.repeat(30)}`],
    ]) {
      const { error } = await settle(convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'deep.html'));
      expect({ label, name: (error as Error)?.name }).toEqual({ label, name: 'ConversionFailedError' });
      expect((error as Error).message).toMatch(/nest/);
    }
  });

  oracleTest('keeps every character of moderately nested lists and quotes', ['pdftotext'], async () => {
    const html = `${'<ul><li>'.repeat(8)}DeepListText${'</li></ul>'.repeat(8)}${'<blockquote>'.repeat(8)}DeepQuoteText${'</blockquote>'.repeat(8)}`;
    const result = await convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'nested.html');
    expect(withoutWhitespace(pdfText(result.buffer)).replace(/•/g, '')).toBe('DeepListTextDeepQuoteText');
  });

  it('hands tables wider or taller than a page to LibreOffice with EngineUnavailableError', async () => {
    const wideRow = `<tr>${Array.from({ length: 30 }, (_, i) => `<td>c${i}</td>`).join('')}</tr>`;
    const tallCell = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(' ');
    for (const [label, html] of [
      ['wide', `<table>${wideRow}</table>`],
      ['tall', `<table><tr><td>${tallCell}</td><td>x</td></tr></table>`],
    ]) {
      const { error } = await settle(convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, `${label}.html`));
      expect({ label, name: (error as Error)?.name }).toEqual({ label, name: 'EngineUnavailableError' });
      expect((error as EngineUnavailableError).engineName).toBe('soffice');
    }
  });

  oracleTest('lets a colspan cell use the width of the columns it spans', ['pdftotext'], async () => {
    const wide = 'Quarterly revenue summary across all regional offices';
    const html = `<table><tr><td colspan="2">${wide}</td></tr><tr><td>left cell</td><td>right cell</td></tr></table>`;
    const result = await convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'colspan.html');
    const layout = pdfText(result.buffer, true).split('\n');
    const spanning = lineIndex(layout, new RegExp(wide), 0);
    lineIndex(layout, /left cell\s+right cell/, spanning + 1);
  });
});

describe('HTML parsing robustness', () => {
  oracleTest('keeps structure when the text holds characters whose lowercase form is longer (Turkish dotted I)', ['pdftotext'], async () => {
    for (const [source, input] of [
      ['html', '<h1>Başlık</h1><p>İstanbul güzel.</p><ul><li>bir</li><li>iki</li></ul><script>var hidden = 1</script><p>son</p>'],
      ['md', '# Başlık\n\nİstanbul güzel.\n\n- bir\n- iki\n\nson\n'],
    ] as const) {
      const result = await convertFile(Buffer.from(input, 'utf-8'), source, 'pdf', {}, `turkish.${source}`);
      const lines = pdfText(result.buffer, true)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect({ source, lines: lines.map((line) => line.replace(/\s+/g, ' ')) }).toEqual({
        source,
        lines: ['Başlık', 'İstanbul güzel.', '• bir', '• iki', 'son'],
      });
    }
  });

  it('parses a body with 150,000 paragraphs without exhausting the call stack', async () => {
    const PARAGRAPHS = 150_000;
    const parsed = await parseHtmlToPdfBlocks(`<html><body>${'<p>x</p>'.repeat(PARAGRAPHS)}</body></html>`);
    expect(parsed.blocks.length).toBe(PARAGRAPHS);
    expect(parsed.blocks.map((block) => (block.kind === 'paragraph' ? block.content.map((c) => c.text).join('') : block.kind))).toEqual(
      new Array<string>(PARAGRAPHS).fill('x')
    );
  });

  it('refuses an embedded image above the pixel limit from its header, without decoding it', async () => {
    const SIDE = 6000;
    const png = await sharp({ create: { width: SIDE, height: SIDE, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const html = `<p>x</p><img src="data:image/png;base64,${png.toString('base64')}">`;
    const started = Date.now();
    const { error } = await settle(convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'bomb.html'));
    const elapsed = Date.now() - started;
    // The message carries the header's size: the limit is applied from the header, before decoding.
    expect((error as Error)?.name).toBe('ConversionFailedError');
    expect((error as Error).message).toMatch(/6000x6000 pixels, above the 25000000-pixel limit/);
    expect({ underCeiling: elapsed < GROWTH_CEILING_MS, elapsed }).toEqual({ underCeiling: true, elapsed });
  });

  oracleTest('embeds a plain sRGB baseline JPEG byte for byte', ['pdfimages'], async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 120, b: 220 } } })
      .jpeg({ quality: 80 })
      .toBuffer();
    const result = await convertFile(Buffer.from(`<img src="data:image/jpeg;base64,${jpeg.toString('base64')}">`), 'html', 'pdf', {}, 'photo.html');
    const [embedded] = extractedJpegs(result.buffer);
    const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
    expect({ bytes: embedded.length, sha256: sha256(embedded) }).toEqual({ bytes: jpeg.length, sha256: sha256(jpeg) });
  });

  oracleTest('re-encodes JPEGs it must transform at full quality without chroma subsampling', ['pdfimages'], async () => {
    const rotated = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .jpeg({ quality: 80 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const result = await convertFile(Buffer.from(`<img src="data:image/jpeg;base64,${rotated.toString('base64')}">`), 'html', 'pdf', {}, 'rotated.html');
    const [embedded] = extractedJpegs(result.buffer);
    const metadata = await sharp(embedded).metadata();
    expect({ width: metadata.width, height: metadata.height, chroma: metadata.chromaSubsampling, orientation: metadata.orientation ?? 1 }).toEqual({
      width: 48,
      height: 64,
      chroma: '4:4:4',
      orientation: 1,
    });
  });

  it('caps the images of one document by count and by total pixels', async () => {
    const tiny = buildRgbPng(2, 2).toString('base64');
    const manyImages = Array.from({ length: 65 }, () => `<img src="data:image/png;base64,${tiny}">`).join('');
    const tooMany = await settle(convertFile(Buffer.from(manyImages, 'utf-8'), 'html', 'pdf', {}, 'many.html'));
    expect((tooMany.error as Error)?.name).toBe('ConversionFailedError');
    expect((tooMany.error as Error).message).toMatch(/65 images/);

    const side = 4500;
    const large = await sharp({ create: { width: side, height: side, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const fiveLarge = Array.from({ length: 5 }, () => `<img src="data:image/png;base64,${large.toString('base64')}">`).join('');
    const tooLarge = await settle(convertFile(Buffer.from(fiveLarge, 'utf-8'), 'html', 'pdf', {}, 'large.html'));
    expect((tooLarge.error as Error)?.name).toBe('ConversionFailedError');
    expect((tooLarge.error as Error).message).toMatch(/101250000 pixels/);
  });

  it('refuses non-PNG/JPEG image data before decoding it', async () => {
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } }).gif().toBuffer();
    const { error } = await settle(convertFile(Buffer.from(`<img src="data:image/gif;base64,${gif.toString('base64')}">`), 'html', 'pdf', {}, 'gif.html'));
    expect((error as Error)?.name).toBe('EngineUnavailableError');
    expect((error as EngineUnavailableError).engineName).toBe('soffice');
    expect((error as Error).message).toMatch(/gif/);
  });

  oracleTest('applies the JPEG orientation tag so the image keeps its aspect ratio', ['pdfimages'], async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const result = await convertFile(Buffer.from(`<img src="data:image/jpeg;base64,${jpeg.toString('base64')}">`), 'html', 'pdf', {}, 'rot.html');
    const [image] = runPoppler('pdfimages', ['-list'], result.buffer)
      .split('\n')
      .slice(2)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim().split(/\s+/));
    expect({ width: Number(image[3]), height: Number(image[4]), xPpi: image[12], yPpi: image[13] }).toEqual({
      width: 48,
      height: 64,
      xPpi: image[13],
      yPpi: image[13],
    });
  });

  oracleTest('separates table cells and rows that sit inside inline elements', ['pdftotext'], async () => {
    const html = '<span><table><tr><td>Name</td><td>Qty</td></tr><tr><td>Apple</td><td>3</td></tr></table></span>';
    const result = await convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'inline-table.html');
    const lines = pdfText(result.buffer)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines).toEqual(['Name Qty', 'Apple 3']);
  });

  oracleTest('skips hidden, display:none, noscript and template content', ['pdftotext'], async () => {
    const html =
      '<div hidden>secret one</div><p style="color: red; display : none !important">secret two</p>' +
      '<noscript>secret three</noscript><template><p>secret four</p></template><p>visible text</p>';
    const result = await convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'hidden.html');
    expect(normalizeText(pdfText(result.buffer))).toBe('visible text');
  });

  it('percent-encodes non-ASCII characters and spaces in link targets', async () => {
    const html = '<p><a href="https://example.com/문서 목록?q=한&amp;x=%20">docs</a></p>';
    const result = await convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'link.html');
    expect(await linkTargets(result.buffer)).toEqual(['https://example.com/%EB%AC%B8%EC%84%9C%20%EB%AA%A9%EB%A1%9D?q=%ED%95%9C&x=%20']);
  });
});

describe('Markdown to PDF keeps literal text and structure', () => {
  oracleTest('keeps angle-bracket text and raw HTML as literal text', ['pdftotext'], async () => {
    const markdown = 'Use `List<String>` and a<b and c>d then <script>alert(1)</script> x & y';
    const result = await convertFile(Buffer.from(markdown, 'utf-8'), 'md', 'pdf', {}, 'literal.md');
    expect(normalizeText(pdfText(result.buffer))).toBe('Use List<String> and a<b and c>d then <script>alert(1)</script> x & y');
  });

  oracleTest('renders headings, lists, emphasis, links and pipe tables', ['pdftotext'], async () => {
    const markdown = [
      '# Release Notes',
      '',
      'Intro with **bold**, *emphasis*, snake_case_name, 2 * 3 * 4 and a [reference](https://example.com/notes).',
      '',
      '- first item',
      '- second item',
      '',
      '1. step one',
      '2. step two',
      '',
      '| Name | Qty |',
      '|------|----:|',
      '| a<b  | 3   |',
      '',
      '```',
      'code <b>kept</b>',
      '```',
    ].join('\n');
    const result = await convertFile(Buffer.from(markdown, 'utf-8'), 'md', 'pdf', {}, 'notes.md');
    const layout = pdfText(result.buffer, true).split('\n');
    const heading = lineIndex(layout, /^\s*Release Notes\s*$/, 0);
    const intro = lineIndex(layout, /Intro with bold, emphasis, snake_case_name, 2 \* 3 \* 4 and a reference\./, heading + 1);
    const first = lineIndex(layout, /•\s+first item/, intro + 1);
    const second = lineIndex(layout, /•\s+second item/, first + 1);
    const stepOne = lineIndex(layout, /1\.\s+step one/, second + 1);
    const stepTwo = lineIndex(layout, /2\.\s+step two/, stepOne + 1);
    const header = lineIndex(layout, /Name\s+Qty/, stepTwo + 1);
    const row = lineIndex(layout, /a<b\s+3/, header + 1);
    lineIndex(layout, /code <b>kept<\/b>/, row + 1);
    expect(await linkTargets(result.buffer)).toEqual(['https://example.com/notes']);
  });

  oracleTest('tokenizes inline Markdown once: no attribute break-out, intact URLs, allowed schemes only', ['pdftotext', 'pdfimages'], async () => {
    const png = buildRgbPng(4, 3).toString('base64');
    const cases: Array<{ markdown: string; text: string; links: string[]; images: number }> = [
      { markdown: '![ [p](q) ](r)', text: '[p](q)', links: [], images: 0 },
      { markdown: '[a](http://x.example/*b*)', text: 'a', links: ['http://x.example/*b*'], images: 0 },
      { markdown: '[x](javascript:void0) and [f](file:///etc/hosts)', text: 'x and f', links: [], images: 0 },
      { markdown: '[x](javascript:alert(1))', text: '[x](javascript:alert(1))', links: [], images: 0 },
      { markdown: '![local](file:///etc/passwd) ![remote](http://192.0.2.2/m.png)', text: 'local remote', links: [], images: 0 },
      { markdown: '[a](b"onmouseover=x) [mail](mailto:team@example.com)', text: 'a mail', links: ['mailto:team@example.com'], images: 0 },
      { markdown: `before ![dot](data:image/png;base64,${png}) after`, text: 'before after', links: [], images: 1 },
    ];
    for (const { markdown, text, links, images } of cases) {
      const result = await convertFile(Buffer.from(markdown, 'utf-8'), 'md', 'pdf', {}, 'inline.md');
      expect({
        markdown,
        text: normalizeText(pdfText(result.buffer)),
        links: await linkTargets(result.buffer),
        images: imageCount(result.buffer),
      }).toEqual({ markdown, text, links, images });
    }
  });

  oracleTest('keeps the start number of an ordered list', ['pdftotext'], async () => {
    const result = await convertFile(Buffer.from('3. third\n4. fourth\n', 'utf-8'), 'md', 'pdf', {}, 'start.md');
    const layout = pdfText(result.buffer, true).split('\n');
    const third = lineIndex(layout, /3\.\s+third/, 0);
    lineIndex(layout, /4\.\s+fourth/, third + 1);
  });

  oracleTest(
    'sends LibreOffice no local or remote images and no script or file links from Markdown',
    LIBREOFFICE_TOOLS,
    async () => {
      requireCoveringFonts('한국어 문서');
      const markdown = '한국어 문서\n\n![x](file:///etc/hosts)\n\n![y](http://192.0.2.2:18765/m.png)\n\n[js](javascript:void0) [f](file:///etc/hosts) [ok](https://example.com/a)\n';
      const result = await executeWorkerConversion(Buffer.from(markdown, 'utf-8'), 'md', 'pdf', {}, 'risky.md');
      expect(result.engineUsed).toMatch(/^native-soffice/);
      expect(imageCount(result.buffer)).toBe(0);
      expect(await linkTargets(result.buffer)).toEqual(['https://example.com/a']);
      expect(normalizeText(pdfText(result.buffer))).toBe('한국어 문서 x y js f ok');
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest('converts long runs of table pipes in linear time', ['pdftotext'], async () => {
    // 4x the pipes must cost well under the 16x the old quadratic table pattern took.
    const MAX_GROWTH = 8;
    const { growth, largeMs, result } = await measureGrowth(
      (size) => convertFile(Buffer.from('|'.repeat(size), 'utf-8'), 'md', 'pdf', {}, 'pipes.md'),
      10_000,
      40_000
    );
    expect({ linear: growth < MAX_GROWTH, underCeiling: largeMs < GROWTH_CEILING_MS, growth, largeMs }).toEqual({
      linear: true,
      underCeiling: true,
      growth,
      largeMs,
    });
    expect(withoutWhitespace(pdfText(result.buffer))).toBe('|'.repeat(40_000));
  }, 120_000);
});

const STRUCTURED_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Inventory report</title><style>h1 { color: red; }</style></head>
<body>
<h1>Inventory Report</h1>
<p>Opening paragraph with a <a href="https://example.com/inventory">reference link</a> inside.</p>
<ul><li>Apple crate</li><li>Banana crate</li></ul>
<ol><li>First step</li><li>Second step</li></ol>
<table>
  <thead><tr><th>Name</th><th>Quantity</th></tr></thead>
  <tbody><tr><td>Apple</td><td>3</td></tr><tr><td>Banana</td><td>5</td></tr></tbody>
</table>
<p>Closing paragraph.</p>
<script>document.write('script text must not render');</script>
</body></html>`;

function expectStructuredLayout(pdf: Buffer): void {
  const layout = pdfText(pdf, true).split('\n');
  const heading = lineIndex(layout, /Inventory Report/, 0);
  const paragraph = lineIndex(layout, /Opening paragraph with a reference link inside\./, heading + 1);
  const firstBullet = lineIndex(layout, /•\s+Apple crate/, paragraph + 1);
  const secondBullet = lineIndex(layout, /•\s+Banana crate/, firstBullet + 1);
  const firstStep = lineIndex(layout, /1\.\s+First step/, secondBullet + 1);
  const secondStep = lineIndex(layout, /2\.\s+Second step/, firstStep + 1);
  const header = lineIndex(layout, /Name\s+Quantity/, secondStep + 1);
  const apple = lineIndex(layout, /Apple\s+3/, header + 1);
  const banana = lineIndex(layout, /Banana\s+5/, apple + 1);
  lineIndex(layout, /Closing paragraph\./, banana + 1);
  const all = layout.join('\n');
  expect(all).not.toContain('script text must not render');
  expect(all).not.toContain('Inventory report');
  expect(all).not.toMatch(BRANDING);
}

describe('HTML to PDF keeps document structure', () => {
  oracleTest('in-process renderer keeps headings, paragraphs, lists, tables and links in order', POPPLER_TOOLS, async () => {
    const result = await convertFile(Buffer.from(STRUCTURED_HTML, 'utf-8'), 'html', 'pdf', {}, 'report.html');
    expectStructuredLayout(result.buffer);
    expect(await linkTargets(result.buffer)).toEqual(['https://example.com/inventory']);
    expectEmbeddedFontsOnly(result.buffer);
  });

  oracleTest(
    'LibreOffice renders HTML with the same structure when it is installed',
    LIBREOFFICE_TOOLS,
    async () => {
      const result = await executeWorkerConversion(Buffer.from(STRUCTURED_HTML, 'utf-8'), 'html', 'pdf', {}, 'report.html');
      expect(result.engineUsed).toMatch(/^native-soffice/);
      expectStructuredLayout(result.buffer);
      expect(await linkTargets(result.buffer)).toContain('https://example.com/inventory');
      expectEmbeddedFontsOnly(result.buffer);
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest('in-process renderer embeds data: URI PNG images at their pixel size', ['pdftotext', 'pdfimages'], async () => {
    const png = buildRgbPng(4, 3).toString('base64');
    const html = `<p>Before image</p><img alt="swatch" src="data:image/png;base64,${png}"><p>After image</p>`;
    const result = await convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'image.html');

    const images = runPoppler('pdfimages', ['-list'], result.buffer)
      .split('\n')
      .slice(2)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim().split(/\s+/));
    expect(images).toHaveLength(1);
    expect({ type: images[0][2], width: Number(images[0][3]), height: Number(images[0][4]) }).toEqual({
      type: 'image',
      width: 4,
      height: 3,
    });
    expect(normalizeText(pdfText(result.buffer))).toBe('Before image After image');
  });

  it('refuses external image references instead of dropping them', async () => {
    const html = '<p>Logo below</p><img src="https://example.com/logo.png" alt="logo">';
    const error = await convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'remote.html').then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).name).toBe('ConversionFailedError');
    expect((error as Error).message).toMatch(/"https:\/\/example\.com\/logo\.png" is an external reference/);
  });

  it('refuses embedded media the in-process renderer cannot draw when LibreOffice is absent', async () => {
    const html = '<p>Clip below</p><video src="data:video/mp4;base64,AAAAIGZ0eXBpc29t"></video>';
    const error = await withMissingBinary('SOFFICE_PATH', () =>
      executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'media.html')
    ).then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as EngineUnavailableError).engineName).toBe('soffice');
    expect((error as Error).message).toContain('<video>');
  });
});

describe('CJK and complex-script text routes to LibreOffice when it is installed', () => {
  const MIXED_LINES = [SAMPLES.korean[0], SAMPLES.japanese[0], SAMPLES.chinese[0], ARABIC_LINE, SAMPLES.latin[0]];

  for (const source of TEXT_SOURCES) {
    oracleTest(
      `${source} with Korean, Japanese, Chinese, Arabic and Latin text converts through LibreOffice exactly`,
      LIBREOFFICE_TOOLS,
      async () => {
        requireCoveringFonts(MIXED_LINES.join(''));
        const result = await executeWorkerConversion(buildSource(source, MIXED_LINES), source, 'pdf', {}, `mixed.${source}`);

        expect(result.engineUsed).toMatch(/^native-soffice/);
        expect(normalizeText(pdfText(result.buffer))).toBe(normalizeText(MIXED_LINES.join(' ')));
        expectEmbeddedFontsOnly(result.buffer);
        expectNoBranding(result.buffer);
      },
      LIBREOFFICE_TIMEOUT_MS
    );
  }

  oracleTest('Korean txt that installed fonts cover stays in-process even when LibreOffice is installed', POPPLER_TOOLS, async () => {
    requireCoveringFonts(SAMPLES.korean.join(''));
    // A LibreOffice stand-in that would fail: the in-process writer must not even try it.
    const result = await withEnvValue('SOFFICE_PATH', failingSoffice('exit 3'), () =>
      executeWorkerConversion(buildSource('txt', SAMPLES.korean), 'txt', 'pdf', {}, 'korean.txt')
    );
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.fallbackChain).toBeUndefined();
    expect(normalizeText(pdfText(result.buffer))).toBe(normalizeText(SAMPLES.korean.join(' ')));
    expectEmbeddedFontsOnly(result.buffer);
  });

  oracleTest('Korean HTML falls back to the in-process renderer, with fonts, when LibreOffice is absent', POPPLER_TOOLS, async () => {
    requireCoveringFonts(SAMPLES.korean.join(''));
    const result = await withMissingBinary('SOFFICE_PATH', () =>
      executeWorkerConversion(buildSource('html', SAMPLES.korean), 'html', 'pdf', {}, 'korean.html')
    );
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.fallbackChain?.[0]).toMatch(/^native-soffice: /);
    expect(normalizeText(pdfText(result.buffer))).toBe(normalizeText(SAMPLES.korean.join(' ')));
    expectEmbeddedFontsOnly(result.buffer);
  });
});

describe('LibreOffice failures, page orientation and text encodings', () => {
  oracleTest('HTML falls back to the in-process renderer when LibreOffice exits with an error', POPPLER_TOOLS, async () => {
    const result = await withEnvValue('SOFFICE_PATH', failingSoffice('exit 3'), () =>
      executeWorkerConversion(Buffer.from(STRUCTURED_HTML, 'utf-8'), 'html', 'pdf', {}, 'report.html')
    );
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.fallbackChain?.[0]).toMatch(/^native-soffice: /);
    expectStructuredLayout(result.buffer);
  });

  oracleTest('HTML falls back to the in-process renderer when LibreOffice times out', POPPLER_TOOLS, async () => {
    const TIMEOUT_MS = 1500;
    // A ceiling well below the 60 s the stand-in sleeps: the engine gave up at its timeout.
    const CEILING_MS = 20_000;
    const started = Date.now();
    const result = await withEnvValue('SOFFICE_PATH', failingSoffice('exec sleep 60'), () =>
      executeWorkerConversion(Buffer.from(STRUCTURED_HTML, 'utf-8'), 'html', 'pdf', { timeoutMs: TIMEOUT_MS }, 'report.html')
    );
    const elapsed = Date.now() - started;
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.fallbackChain?.[0]).toMatch(/^native-soffice: /);
    expect({ underCeiling: elapsed < CEILING_MS, elapsed }).toEqual({ underCeiling: true, elapsed });
    expectStructuredLayout(result.buffer);
  }, 60_000);

  it('refuses HTML that references external resources before LibreOffice could fetch them', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-marker-')), 'invoked');
    const recordingSoffice = failingSoffice(`touch '${marker}'; exit 3`);
    for (const html of [
      '<p>remote</p><img src="http://192.0.2.2:18765/m.png">',
      '<p>local</p><img srcset="file:///etc/hosts 1x">',
      '<p>frame</p><iframe src="http://192.0.2.2:18765/"></iframe>',
      '<link rel="stylesheet" href="http://192.0.2.2:18765/s.css"><p>styled</p>',
    ]) {
      const { error } = await settle(
        withEnvValue('SOFFICE_PATH', recordingSoffice, () => executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'remote.html'))
      );
      expect({ html, name: (error as Error)?.name, invoked: fs.existsSync(marker) }).toEqual({ html, name: 'ConversionFailedError', invoked: false });
      expect((error as Error).message).toMatch(/external reference/);
    }
  });

  it('refuses CSS url(), @import, image-set and background references before LibreOffice could load them', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-css-marker-')), 'invoked');
    const recordingSoffice = failingSoffice(`touch '${marker}'; exit 3`);
    const external = (reference: string): string => `"${reference}" is an external reference`;
    const cases: Array<[string, string]> = [
      ['<p style="background:url(file:///etc/hosts)">attribute</p>', external('file:///etc/hosts')],
      ['<style>@import "http://192.0.2.2:18765/a.css";</style><p>import</p>', external('http://192.0.2.2:18765/a.css')],
      // Any backslash is refused: CSS readers disagree on escapes such as \75 (u).
      ['<p style="background:\\75 rl(file:///etc/hosts)">escaped</p>', 'backslash escape is not supported'],
      ['<style>p { background : /* note */ URL( \'file:///etc/hosts\' ) }</style><p>quoted</p>', external('file:///etc/hosts')],
      ['<style>@import/* note */url(http://192.0.2.2:18765/b.css);</style><p>import url</p>', external('http://192.0.2.2:18765/b.css')],
      ['<style>p { background: image-set("file:///etc/hosts" 1x) }</style><p>image-set</p>', external('file:///etc/hosts')],
      ['<table><tr><td background="file:///etc/hosts">cell</td></tr></table>', external('file:///etc/hosts')],
    ];
    for (const [html, message] of cases) {
      const { error } = await settle(
        withEnvValue('SOFFICE_PATH', recordingSoffice, () => executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'css.html'))
      );
      expect({ html, name: (error as Error)?.name, invoked: fs.existsSync(marker) }).toEqual({ html, name: 'ConversionFailedError', invoked: false });
      expect((error as Error).message).toContain(message);
    }
  });

  oracleTest('still sends HTML whose CSS uses only embedded image data to LibreOffice', ['pdftotext'], async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-css-data-')), 'invoked');
    const png = buildRgbPng(2, 2).toString('base64');
    const html =
      `<style>p { background: url('data:image/png;base64,${png}') }</style>` +
      `<p style="background-image:url(data:image/png;base64,${png})">data backgrounds</p>`;
    const result = await withEnvValue('SOFFICE_PATH', failingSoffice(`touch '${marker}'; exit 3`), () =>
      executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'css-data.html')
    );
    expect({ invoked: fs.existsSync(marker), engine: result.engineUsed, text: normalizeText(pdfText(result.buffer)) }).toEqual({
      invoked: true,
      engine: 'internal-fallback',
      text: 'data backgrounds',
    });
  });

  it('refuses every URL attribute outside the allowlist, inline SVG included, before LibreOffice could load it', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-url-marker-')), 'invoked');
    const recordingSoffice = failingSoffice(`touch '${marker}'; exit 3`);
    const cases: Array<[string, string]> = [
      ['<p>svg image</p><svg><image href="file:///tmp/local.png" width="10" height="10"/></svg>', 'file:///tmp/local.png'],
      ['<p>svg xlink</p><svg><image xlink:href="http://192.0.2.2:18765/a.png"/></svg>', 'http://192.0.2.2:18765/a.png'],
      ['<p>svg use</p><svg><use href="file:///x#a"/></svg>', 'file:///x#a'],
      ['<p>svg prefix</p><svg xmlns:xl="http://www.w3.org/1999/xlink"><image XL:HREF="file:///etc/hosts"/></svg>', 'file:///etc/hosts'],
      ['<p>filter</p><svg><filter id="f"><feImage href="http://192.0.2.2:18765/f.png"/></filter></svg>', 'http://192.0.2.2:18765/f.png'],
      ['<p>svg sheet</p><svg><style>rect { fill: url(file:///x.svg#g) }</style><rect/></svg>', 'file:///x.svg#g'],
      ['<p>paint</p><svg><rect fill="url(http://192.0.2.2:18765/p.svg#g)"/></svg>', 'http://192.0.2.2:18765/p.svg#g'],
      ['<p>object</p><object data="file:///etc/hosts"></object>', 'file:///etc/hosts'],
      ['<form action="http://192.0.2.2:18765/submit"><p>form</p></form>', 'http://192.0.2.2:18765/submit'],
      ['<form><button formaction="file:///etc/hosts">go</button></form>', 'file:///etc/hosts'],
      ['<blockquote cite="http://192.0.2.2:18765/q">quote</blockquote>', 'http://192.0.2.2:18765/q'],
      ['<script src="http://192.0.2.2:18765/s.js"></script><p>script</p>', 'http://192.0.2.2:18765/s.js'],
      ['<p>relative</p><img src="images/logo.png">', 'images/logo.png'],
      ['<p><a href="file:///etc/hosts">local link</a></p>', 'file:///etc/hosts'],
      ['<p><a href="java\tscript:alert(1)">script link</a></p>', 'java\tscript:alert(1)'],
      ['<p><a href="https://example.com/" ping="http://192.0.2.2:18765/ping">ping</a></p>', 'http://192.0.2.2:18765/ping'],
      [`<p>srcset</p><img srcset="data:image/png;base64,${buildRgbPng(1, 1).toString('base64')} 1x, file:///etc/hosts 2x">`, 'file:///etc/hosts'],
      ['<meta http-equiv="refresh" content="0; url=file:///etc/hosts"><p>refresh</p>', 'file:///etc/hosts'],
    ];
    for (const [html, reference] of cases) {
      const { error } = await settle(
        withEnvValue('SOFFICE_PATH', recordingSoffice, () => executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'urls.html'))
      );
      expect({ html, name: (error as Error)?.name, invoked: fs.existsSync(marker) }).toEqual({ html, name: 'ConversionFailedError', invoked: false });
      expect((error as Error).message).toContain(`"${reference}" is an external reference`);
    }
  });

  oracleTest('still sends same-document fragments, web and mail links, and data: sources to LibreOffice', ['pdftotext'], async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-url-allowed-')), 'invoked');
    const png = `data:image/png;base64,${buildRgbPng(2, 2).toString('base64')}`;
    const html =
      `<p><a href="#target">jump</a> <a href="https://example.com/a">web</a> <a href="HTTP://example.com/b">plain</a> ` +
      `<a href="mailto:team@example.com">mail</a> <a href="">self</a></p>` +
      `<p><img src="${png}" srcset="${png} 1x, ${png} 2x" alt="pixel"></p><h2 id="target">Target</h2>`;
    const result = await withEnvValue('SOFFICE_PATH', failingSoffice(`touch '${marker}'; exit 3`), () =>
      executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'links.html')
    );
    expect({ invoked: fs.existsSync(marker), engine: result.engineUsed, text: normalizeText(pdfText(result.buffer)) }).toEqual({
      invoked: true,
      engine: 'internal-fallback',
      text: 'jump web plain mail self Target',
    });

    // Inline SVG that refers only to its own fragments and data: images passes the reference check (no 400),
    // but no engine draws inline SVG, so it is refused as unavailable before LibreOffice runs instead of being dropped.
    const svgMarker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-svg-allowed-')), 'invoked');
    const svg =
      `<p>shapes</p><svg xmlns:xlink="http://www.w3.org/1999/xlink"><defs><rect id="r" width="4" height="4" fill="url(#g)"/></defs>` +
      `<use href="#r"/><use xlink:href="#r"/><image href="${png}" width="2" height="2"/></svg>`;
    const { error } = await settle(
      withEnvValue('SOFFICE_PATH', failingSoffice(`touch '${svgMarker}'; exit 3`), () =>
        executeWorkerConversion(Buffer.from(svg, 'utf-8'), 'html', 'pdf', {}, 'shapes.html')
      )
    );
    expect({ invoked: fs.existsSync(svgMarker), name: (error as Error)?.name }).toEqual({ invoked: false, name: 'EngineUnavailableError' });
  });

  it('reports a LibreOffice failure on complex-script text as EngineUnavailableError (503)', async () => {
    const { error } = await settle(
      withEnvValue('SOFFICE_PATH', failingSoffice('exit 3'), () =>
        executeWorkerConversion(Buffer.from(ARABIC_LINE, 'utf-8'), 'txt', 'pdf', {}, 'arabic.txt')
      )
    );
    expect((error as Error)?.name).toBe('EngineUnavailableError');
    expect((error as EngineUnavailableError).engineName).toBe('soffice');
  });

  oracleTest('an explicit orientation keeps non-complex-script HTML in-process on landscape pages', ['pdfinfo', 'pdftotext'], async () => {
    const result = await withEnvValue('SOFFICE_PATH', failingSoffice('exit 3'), () =>
      executeWorkerConversion(Buffer.from('<p>Landscape page</p>', 'utf-8'), 'html', 'pdf', { orientation: 'landscape' }, 'wide.html')
    );
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.fallbackChain).toBeUndefined();
    expect(runPoppler('pdfinfo', [], result.buffer)).toMatch(A4_LANDSCAPE);
    expect(normalizeText(pdfText(result.buffer))).toBe('Landscape page');
  });

  oracleTest(
    'complex-script text with an orientation renders through LibreOffice on pages of that orientation',
    LIBREOFFICE_TOOLS,
    async () => {
      requireCoveringFonts(ARABIC_LINE);
      for (const [orientation, pageSize] of [
        ['landscape', A4_LANDSCAPE],
        ['portrait', A4_PORTRAIT],
      ] as const) {
        const result = await executeWorkerConversion(Buffer.from(`${ARABIC_LINE}\n`, 'utf-8'), 'txt', 'pdf', { orientation }, 'arabic.txt');
        expect(result.engineUsed).toMatch(/^native-soffice/);
        expect(runPoppler('pdfinfo', [], result.buffer)).toMatch(pageSize);
        expect(normalizeText(pdfText(result.buffer))).toBe(normalizeText(ARABIC_LINE));
      }
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest('decodes UTF-16 text with a byte order mark', POPPLER_TOOLS, async () => {
    requireCoveringFonts(SAMPLES.korean.join(''));
    const text = SAMPLES.korean.join('\n');
    for (const [label, bytes] of [
      ['utf-16le', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])],
      ['utf-16be', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])],
    ] as const) {
      const result = await convertFile(bytes, 'txt', 'pdf', {}, `${label}.txt`);
      expect({ label, text: normalizeText(pdfText(result.buffer)) }).toEqual({ label, text: normalizeText(SAMPLES.korean.join(' ')) });
    }
  });

  it('rejects Latin-1 HTML and Markdown with a typed 400 on both the in-process and worker routes', async () => {
    const latin1Html = Buffer.concat([Buffer.from('<meta charset="iso-8859-1"><p>caf'), Buffer.from([0xe9]), Buffer.from('</p>')]);
    const latin1Markdown = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\n')]);
    for (const [label, source, bytes] of [
      ['html', 'html', latin1Html],
      ['md', 'md', latin1Markdown],
    ] as const) {
      const direct = await settle(convertFile(bytes, source, 'pdf', {}, `latin1.${source}`));
      const routed = await settle(
        withEnvValue('SOFFICE_PATH', failingSoffice('exit 3'), () => executeWorkerConversion(bytes, source, 'pdf', {}, `latin1.${source}`))
      );
      expect({ label, direct: (direct.error as Error)?.name, routed: (routed.error as Error)?.name }).toEqual({
        label,
        direct: 'ConversionFailedError',
        routed: 'ConversionFailedError',
      });
      expect((routed.error as Error).message).toMatch(/UTF-8/);
    }
  });

  oracleTest('decodes UTF-16 HTML with a byte order mark', ['pdftotext'], async () => {
    const html = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p>hello café</p>', 'utf16le')]);
    const result = await convertFile(html, 'html', 'pdf', {}, 'utf16.html');
    expect(normalizeText(pdfText(result.buffer))).toBe('hello café');
  });

  it('rejects text that is not valid UTF-8 and has no UTF-16 byte order mark', async () => {
    const eucKr = Buffer.from('C7D1B1B9BEEE20B9AEBCAD', 'hex');
    const { error } = await settle(convertFile(eucKr, 'txt', 'pdf', {}, 'euc-kr.txt'));
    expect((error as Error)?.name).toBe('ConversionFailedError');
    expect((error as Error).message).toMatch(/UTF-8/);
  });
});
