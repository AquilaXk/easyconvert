import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { encodeBmp8 } from '../src/lib/conversions/bmp';
import { stageHtmlForNativeEngine } from '../src/lib/conversions/html-native-staging';
import { ConversionFailedError } from '../src/lib/types';
import { executeWorkerConversion, libreOfficePool } from '../src/worker/engines';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool, type ExternalOracleTool } from './helpers/differential-oracle';

const LIBREOFFICE_TOOLS: ExternalOracleTool[] = ['soffice', 'pdfimages', 'pdftotext', 'pdfinfo'];
const LIBREOFFICE_TIMEOUT_MS = 180_000;

function poppler(tool: ExternalOracleTool, args: string[], pdf: Buffer): string {
  const binary = requireOracleTool(tool);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-bmp-oracle-'));
  const file = path.join(dir, 'output.pdf');
  try {
    fs.writeFileSync(file, pdf);
    const trailing = tool === 'pdftotext' ? [file, '-'] : [file];
    return execFileSync(binary, [...args, ...trailing], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function embeddedImageCount(pdf: Buffer): number {
  return poppler('pdfimages', ['-list'], pdf)
    .split('\n')
    .slice(2)
    .filter((line) => line.trim().length > 0 && line.trim().split(/\s+/)[2] === 'image').length;
}

function smallBmpBuffer(width = 6, height = 4): Buffer {
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < indices.length; i++) indices[i] = i & 1;
  return encodeBmp8(indices, [{ r: 20, g: 80, b: 200 }, { r: 240, g: 180, b: 40 }], width, height);
}

function oversizedHeaderBmp(width: number, height: number): Buffer {
  const buf = Buffer.alloc(58);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  return buf;
}

describe('HWP with embedded BMP BinData and raster data: URIs in LibreOffice HTML staging', () => {
  let poolWasEnabled = false;

  beforeAll(() => {
    poolWasEnabled = libreOfficePool.isEnabled();
    libreOfficePool.disable();
  });

  afterAll(() => {
    if (poolWasEnabled) libreOfficePool.enable();
  });

  oracleTest(
    'converts basics-report.hwp (with embedded BMP BinData) to PDF via the native LibreOffice route',
    LIBREOFFICE_TOOLS,
    async () => {
      const hwpPath = path.join(__dirname, 'fixtures', 'hwp', 'basics-report.hwp');
      const refPath = path.join(__dirname, 'fixtures', 'hwp', 'basics-report.reference.json');
      const hwpBytes = fs.readFileSync(hwpPath);
      const reference = JSON.parse(fs.readFileSync(refPath, 'utf-8')) as { paragraphs: { text: string }[] };

      const result = await executeWorkerConversion(hwpBytes, 'hwp', 'pdf', {}, 'basics-report.hwp');
      expect(result.engineUsed).toMatch(/^native-soffice/);

      const info = poppler('pdfinfo', [], result.buffer);
      const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? '0');
      expect(pages).toBeGreaterThanOrEqual(1);
      expect(embeddedImageCount(result.buffer)).toBeGreaterThanOrEqual(1);

      const extractedText = poppler('pdftotext', ['-enc', 'UTF-8'], result.buffer).normalize('NFC');
      const sampleParagraph = reference.paragraphs.find((p) => p.text.trim().length > 4)?.text.normalize('NFC');
      expect(sampleParagraph).toBeDefined();
      expect(extractedText.replace(/\s+/g, '')).toContain(sampleParagraph!.replace(/\s+/g, '').slice(0, 12));
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  it('transcodes valid embedded BMP, WebP, and TIFF data: images in <img> and CSS url() to PNG', async () => {
    const bmpUri = `data:image/bmp;base64,${smallBmpBuffer(8, 6).toString('base64')}`;
    const webpBytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: { r: 30, g: 160, b: 90 } } }).webp().toBuffer();
    const webpUri = `data:image/webp;base64,${webpBytes.toString('base64')}`;
    const tiffBytes = await sharp({ create: { width: 5, height: 5, channels: 3, background: { r: 180, g: 50, b: 120 } } }).tiff().toBuffer();
    const tiffUri = `data:image/tiff;base64,${tiffBytes.toString('base64')}`;

    const html =
      `<style>.hero { background-image: url("${bmpUri}") }</style>` +
      `<p class="hero">Raster formats</p>` +
      `<img src="${bmpUri}" alt="bmp"><img src="${webpUri}" alt="webp"><img src="${tiffUri}" alt="tiff">`;

    const staged = await stageHtmlForNativeEngine(html);
    expect(staged.warnings).toEqual([]);
    expect(staged.html).not.toMatch(/data:image\/(?:bmp|webp|tiff)/i);
    const pngMatches = staged.html.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? [];
    expect(pngMatches).toHaveLength(4);
    expect(pngMatches[0]).toBe(pngMatches[1]);
  });

  oracleTest(
    'renders HTML with embedded BMP, WebP, and TIFF data: images to PDF through LibreOffice',
    LIBREOFFICE_TOOLS,
    async () => {
      const bmpUri = `data:image/bmp;base64,${smallBmpBuffer(10, 8).toString('base64')}`;
      const webpBytes = await sharp({ create: { width: 10, height: 8, channels: 3, background: { r: 10, g: 120, b: 60 } } }).webp().toBuffer();
      const tiffBytes = await sharp({ create: { width: 10, height: 8, channels: 3, background: { r: 140, g: 40, b: 90 } } }).tiff().toBuffer();
      const html =
        `<p>Embedded rasters</p>` +
        `<img src="${bmpUri}"><img src="data:image/webp;base64,${webpBytes.toString('base64')}">` +
        `<img src="data:image/tiff;base64,${tiffBytes.toString('base64')}">`;

      const result = await executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'rasters.html');
      expect(result.engineUsed).toMatch(/^native-soffice/);
      expect(embeddedImageCount(result.buffer)).toBe(3);
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  it('fails closed (400 ConversionFailedError) on malformed, oversized-header, or SVG data: images', async () => {
    const truncatedBmp = smallBmpBuffer(8, 8).subarray(0, 30).toString('base64');
    const bombBmp = oversizedHeaderBmp(6000, 6000).toString('base64');
    const fakeWebp = Buffer.from('RIFF\x10\x00\x00\x00WEBPbad!', 'latin1').toString('base64');
    const fakeTiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0xff, 0xff, 0xff, 0x7f]).toString('base64');

    const cases: Array<[string, RegExp]> = [
      [`data:image/bmp;base64,${truncatedBmp}`, /HTML embedded image could not be read: Invalid BMP/],
      [`data:image/bmp;base64,${bombBmp}`, /HTML embedded image could not be read: .*25,?000,?000|36,?000,?000/i],
      [`data:image/webp;base64,${fakeWebp}`, /HTML embedded image/],
      [`data:image/tiff;base64,${fakeTiff}`, /HTML embedded image/],
      ['data:image/svg+xml;base64,PHN2Zy8+', /is not embedded base64 PNG, JPEG or GIF data/],
    ];

    for (const [uri, expectedMessage] of cases) {
      const failure = await stageHtmlForNativeEngine(`<img src="${uri}">`).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).name).toBe('ConversionFailedError');
      expect((failure as Error).message).toMatch(expectedMessage);
    }
  });
});
