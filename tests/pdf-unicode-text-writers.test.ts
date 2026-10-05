import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { buildHwpCompoundFile } from '../src/lib/conversions/hwp';
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
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;
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

  oracleTest('settles thousands of distinct uncommon Han characters in seconds, without a font lookup per character', ['pdftotext'], async () => {
    const EXT_B_FIRST = 0x20000;
    const DISTINCT = 3000;
    const BUDGET_MS = 3000;
    let text = 'Han Extension B: ';
    for (let i = 0; i < DISTINCT; i++) text += String.fromCodePoint(EXT_B_FIRST + i);
    const started = Date.now();
    const { value, error } = await settle(convertFile(Buffer.from(text, 'utf-8'), 'txt', 'pdf', {}, 'ext-b.txt'));
    const elapsed = Date.now() - started;
    expect({ elapsedWithinBudget: elapsed < BUDGET_MS, elapsed }).toEqual({ elapsedWithinBudget: true, elapsed });
    if (value) {
      expect(withoutWhitespace(pdfText(value.buffer))).toBe(withoutWhitespace(text));
    } else {
      expect((error as Error).name).toBe('EngineUnavailableError');
      expect((error as EngineUnavailableError).engineName).toBe('unicode-font');
      const reported = Number.parseInt(/U\+([0-9A-F]{5})/.exec((error as Error).message)?.[1] ?? '0', 16);
      expect(reported >= EXT_B_FIRST && reported < EXT_B_FIRST + DISTINCT).toBe(true);
    }
  }, 60_000);

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
    const html = '<p>Clip below</p><video src="clip.mp4"></video>';
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

  oracleTest(
    'Korean-only txt routes to LibreOffice rather than the in-process writer',
    LIBREOFFICE_TOOLS,
    async () => {
      requireCoveringFonts(SAMPLES.korean.join(''));
      const result = await executeWorkerConversion(buildSource('txt', SAMPLES.korean), 'txt', 'pdf', {}, 'korean.txt');
      expect(result.engineUsed).toMatch(/^native-soffice/);
      expect(normalizeText(pdfText(result.buffer))).toBe(normalizeText(SAMPLES.korean.join(' ')));
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest('Korean txt falls back to the in-process writer, with fonts, when LibreOffice is absent', POPPLER_TOOLS, async () => {
    requireCoveringFonts(SAMPLES.korean.join(''));
    const result = await withMissingBinary('SOFFICE_PATH', () =>
      executeWorkerConversion(buildSource('txt', SAMPLES.korean), 'txt', 'pdf', {}, 'korean.txt')
    );
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.fallbackChain?.some((entry) => entry.startsWith('native-soffice'))).toBe(true);
    expect(normalizeText(pdfText(result.buffer))).toBe(normalizeText(SAMPLES.korean.join(' ')));
    expectEmbeddedFontsOnly(result.buffer);
  });
});
