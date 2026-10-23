import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { PdfPasswordRequiredError } from '../src/lib/types';
import { convertPdfPagesWithNativeTools } from '../src/worker/engines';
import { PDF_PASSWORD_REJECTED_MESSAGE } from '../src/worker/pdf-decrypt';
import { BITMAP_FONT_TEXT, bitmapFontPdf } from './helpers/bitmap-font-pdf';
import { getOracleToolPath } from './helpers/differential-oracle';
import { readDxf } from './helpers/dxf-reader';
import { oracleTest } from './helpers/oracle-test';

/**
 * A password-protected PDF set in a bitmap font converts to DXF with the right password (#783).
 *
 * Poppler draws the characters of such a font as pictures, so the DXF writer sets them as TEXT from the PDF's text layer,
 * which is read in the process. That reader must get the same decrypted bytes Poppler gets, not the encrypted input: it
 * refuses a document that needs a password, and without the fix the right password was refused for DXF.
 *
 * The fixture is a Type 3 bitmap-font PDF encrypted with the qpdf CLI, and the expected text is the one the font's
 * ToUnicode map holds, not anything the converter wrote.
 */

const USER_PASSWORD = 'Canary-7f3a "q" $H;#1';
const OWNER_PASSWORD = 'Owner-Canary-91bd';
const KEY_LENGTH_BITS = '256';
const TEST_TIMEOUT_MS = 60_000;

const workDirs: string[] = [];
afterAll(() => {
  for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function encryptedBitmapFontPdf(): Buffer {
  const qpdf = getOracleToolPath('qpdf');
  if (!qpdf) throw new Error('oracle tool qpdf is not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-dxfpw-fixture-'));
  workDirs.push(dir);
  const plainPath = path.join(dir, 'plain.pdf');
  const encryptedPath = path.join(dir, 'encrypted.pdf');
  fs.writeFileSync(plainPath, bitmapFontPdf());
  execFileSync(qpdf, ['--encrypt', USER_PASSWORD, OWNER_PASSWORD, KEY_LENGTH_BITS, '--', plainPath, encryptedPath]);
  return fs.readFileSync(encryptedPath);
}

async function toDxf(pdf: Buffer, password?: string): Promise<string> {
  const result = await convertPdfPagesWithNativeTools(pdf, 'dxf', { password, throwOnUnavailable: true }, 'bitmap.pdf');
  expect(result?.filename.endsWith('.dxf')).toBe(true);
  return result!.buffer.toString('utf-8');
}

const REQUIRED_TOOLS = ['qpdf', 'pdftocairo'] as const;

describe('a bitmap-font PDF to DXF', () => {
  oracleTest('without a password: the characters are TEXT from the text layer', [...REQUIRED_TOOLS], async () => {
    expect(readDxf(await toDxf(bitmapFontPdf())).texts.map((text) => text.value)).toEqual([BITMAP_FONT_TEXT]);
  }, TEST_TIMEOUT_MS);

  oracleTest('with the right password: the same TEXT, read from the decrypted document', [...REQUIRED_TOOLS], async () => {
    expect(readDxf(await toDxf(encryptedBitmapFontPdf(), USER_PASSWORD)).texts.map((text) => text.value)).toEqual([BITMAP_FONT_TEXT]);
  }, TEST_TIMEOUT_MS);

  oracleTest('with the owner password: the same TEXT', [...REQUIRED_TOOLS], async () => {
    expect(readDxf(await toDxf(encryptedBitmapFontPdf(), OWNER_PASSWORD)).texts.map((text) => text.value)).toEqual([BITMAP_FONT_TEXT]);
  }, TEST_TIMEOUT_MS);

  oracleTest('with a wrong password: the typed password error, without the password in it', [...REQUIRED_TOOLS], async () => {
    const wrong = 'Wrong-Canary-0000';
    const error = await toDxf(encryptedBitmapFontPdf(), wrong).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PdfPasswordRequiredError);
    expect((error as Error).message).toBe(PDF_PASSWORD_REJECTED_MESSAGE);
    expect((error as Error).message).not.toContain(wrong);
  }, TEST_TIMEOUT_MS);

  oracleTest('without a password: the typed password error', [...REQUIRED_TOOLS], async () => {
    const error = await toDxf(encryptedBitmapFontPdf()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PdfPasswordRequiredError);
    expect((error as Error).message).toBe(PDF_PASSWORD_REJECTED_MESSAGE);
  }, TEST_TIMEOUT_MS);
});
