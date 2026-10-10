import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ConversionFailedError, EngineUnavailableError, UnsupportedTargetError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { extractTextWithExternalPdftotext, requireOracleTool } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
import { flatOdg, flatOdgWithRectangle, normalizeWhitespace, sofficeConvert } from './helpers/soffice-office';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const RED_MIN = 200;
const OTHER_MAX = 60;
const RGB_CHANNELS = 3;
const NATIVE_TIMEOUT_MS = 240_000;

const PAGES: string[][] = [
  ['Drawing page one', 'Café 한국어 日本語'],
  ['Drawing page two', 'Second “page” – text'],
];

function pdfPageCount(pdf: Buffer): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odg-pages-'));
  try {
    fs.writeFileSync(path.join(dir, 'd.pdf'), pdf);
    const info = execFileSync(requireOracleTool('pdfinfo'), [path.join(dir, 'd.pdf')], { encoding: 'utf-8' });
    return Number(/Pages:\s+(\d+)/.exec(info)?.[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function redPixelCount(png: Buffer): Promise<number> {
  const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += RGB_CHANNELS) {
    if (data[i] >= RED_MIN && data[i + 1] <= OTHER_MAX && data[i + 2] <= OTHER_MAX) count++;
  }
  return count;
}

describe('OpenDocument drawings render through LibreOffice', () => {
  oracleTest('odg -> pdf keeps every page and its text, as the LibreOffice render of the same drawing', ['soffice', 'pdftotext', 'pdfinfo'], async () => {
    const odg = sofficeConvert(flatOdg(PAGES), 'fodg', 'odg', 'odg');
    const result = await dispatchConversion(odg, 'odg', 'pdf', {}, 'drawing.odg');
    expect(result.buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
    expect(result.mimeType).toBe('application/pdf');
    expect(result.filename).toBe('drawing.pdf');
    expect(pdfPageCount(result.buffer)).toBe(PAGES.length);
    expect(normalizeWhitespace(extractTextWithExternalPdftotext(result.buffer) ?? '')).toBe(normalizeWhitespace(PAGES.flat().join(' ')));
  }, NATIVE_TIMEOUT_MS);

  oracleTest('odg -> png draws the shapes, not only the text', ['soffice', 'pdftoppm'], async () => {
    const odg = sofficeConvert(flatOdgWithRectangle(['Rectangle below'], '#ff0000'), 'fodg', 'odg', 'odg');
    const result = await dispatchConversion(odg, 'odg', 'png', {}, 'shapes.odg');
    expect(result.mimeType).toBe('image/png');
    expect(result.filename).toBe('shapes.png');
    expect(result.buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);
    expect((await sharp(result.buffer).metadata()).format).toBe('png');
    expect(await redPixelCount(result.buffer)).toBeGreaterThan(1000);
  }, NATIVE_TIMEOUT_MS);

  oracleTest('odg -> jpg is a JPEG with the extension and MIME type of its bytes', ['soffice', 'pdftoppm'], async () => {
    const odg = sofficeConvert(flatOdg([PAGES[0]]), 'fodg', 'odg', 'odg');
    const result = await dispatchConversion(odg, 'odg', 'jpg', {}, 'drawing.odg');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.filename).toBe('drawing.jpg');
    expect(result.buffer.subarray(0, JPEG_SOI.length).equals(JPEG_SOI)).toBe(true);
    expect((await sharp(result.buffer).metadata()).format).toBe('jpeg');
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a drawing template (odd) renders to pdf too', ['soffice', 'pdftotext'], async () => {
    const template = sofficeConvert(flatOdg([PAGES[0]]), 'fodg', 'otg', 'otg');
    const result = await dispatchConversion(template, 'odd', 'pdf', {}, 'template.odd');
    expect(normalizeWhitespace(extractTextWithExternalPdftotext(result.buffer) ?? '')).toBe(normalizeWhitespace(PAGES[0].join(' ')));
  }, NATIVE_TIMEOUT_MS);
});

describe('OpenDocument drawings fail closed', () => {
  const drawing = () => sofficeConvert(flatOdg([PAGES[0]]), 'fodg', 'odg', 'odg');

  it.each([['docx'], ['svg']])('refuses the unlisted target %s with a typed 400 error', async (target) => {
    const input = Buffer.from('PK\u0003\u0004 not a drawing', 'latin1');
    const run = dispatchConversion(input, 'odg', target, {}, 'drawing.odg');
    await expect(run).rejects.toBeInstanceOf(UnsupportedTargetError);
    await expect(run).rejects.toMatchObject({ message: `Unsupported conversion from .odg to .${target}: the pair is not offered` });
  });

  oracleTest('answers a missing LibreOffice with a typed 503 error, never with text under another format', ['soffice'], async () => {
    const odg = drawing();
    const run = withMissingBinary('SOFFICE_PATH', () => dispatchConversion(odg, 'odg', 'pdf', {}, 'drawing.odg'));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'soffice' });
  }, NATIVE_TIMEOUT_MS);

  it('refuses a file that is not an OpenDocument package with a typed 400 error', async () => {
    const run = convertFile(Buffer.from('<?xml version="1.0"?><drawing>text</drawing>', 'utf-8'), 'odg', 'pdf', {}, 'bad.odg');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.not.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ message: 'The ODG file is not a valid OpenDocument package.' });
  });
});
