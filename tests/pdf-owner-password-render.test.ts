import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, expect, vi } from 'vitest';
import { inspectPdfEncryption } from '../src/lib/conversions/pdf-encryption';
import { openPdfPageRenderer } from '../src/lib/conversions/pdf-page-render';
import { convertPdfPagesWithNativeTools } from '../src/worker/engines';
import { withDecryptedPdf } from '../src/worker/pdf-decrypt';
import { captureError } from './helpers/capture-error';
import { AES_256, plainPdf, qpdfEncrypt, RC4_128 } from './helpers/encrypted-pdf-fixtures';
import { oracleTest } from './helpers/oracle-test';
import { type CraftObject, buildPdf } from './helpers/pdf-craft';

/**
 * A PDF that restricts what the reader may do but opens with an empty password (only an owner password set) is read by every
 * Poppler route as a plain file. The tools of the worker therefore see a decrypted copy of it, as they do for a file opened with a
 * password: the size guards read the plaintext of its streams (the page of a JBIG2 stream is declared in the stream, which an
 * encrypted file holds as ciphertext), and the fallback page counter never mistakes the open file for one that needs a password.
 * Oracle: qpdf writes the encrypted files; the JBIG2 header bytes are those of the pdf.js file `bomb_giant.pdf` (T.88 section 7.4.8).
 */

const TOOLS = ['qpdf', 'pdftoppm', 'pdfinfo'];
const TEST_TIMEOUT_MS = 120_000;
const HTTP_PAYLOAD_TOO_LARGE = 413;
/** Segment 0, type 48 (page information), page 1, 19 data bytes, 100000 x 100000 pixels. */
const BOMB_PAGE_INFORMATION = Buffer.from('0000000030000100000013000186a0000186a00000000000000000010000', 'hex');

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-password-render-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());

function jbig2BombPdf(): Buffer {
  const objects: CraftObject[] = [
    { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
    { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >>' },
    { id: 4, dict: '/Filter /JBIG2Decode', stream: BOMB_PAGE_INFORMATION },
  ];
  return buildPdf(objects, 1).buffer;
}

function write(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

for (const variant of [RC4_128, AES_256]) {
  oracleTest(`${variant.name}: a JBIG2 page of 1.25 GB in a file with only an owner password is refused with the 413 of the plain file`, TOOLS, async () => {
    const locked = qpdfEncrypt(jbig2BombPdf(), { variant, userPassword: '', ownerPassword: 'owner-secret-1', modify: 'none' });
    expect(inspectPdfEncryption(locked).encrypted).toBe(true);
    const error = await captureError(() =>
      withDecryptedPdf({ inputPath: write(`bomb-${variant.name}.pdf`, locked), tempDir: workDir, timeoutMs: TEST_TIMEOUT_MS }, async () => 'reached the tool')
    );
    expect(error).toMatchObject({ name: 'DecompressionLimitError', status: HTTP_PAYLOAD_TOO_LARGE });
  }, TEST_TIMEOUT_MS);
}

oracleTest('a file with only an owner password reaches the tools as a decrypted copy, and a plain file as itself', TOOLS, async () => {
  const plain = await plainPdf(['Locked body']);
  const locked = qpdfEncrypt(plain, { variant: AES_256, userPassword: '', ownerPassword: 'owner-secret-1', modify: 'none' });
  const plainPath = write('plain.pdf', plain);
  const lockedPath = write('locked.pdf', locked);
  const readable = await withDecryptedPdf({ inputPath: lockedPath, tempDir: workDir, timeoutMs: TEST_TIMEOUT_MS }, async (file) => ({
    file,
    encrypted: inspectPdfEncryption(fs.readFileSync(file)).encrypted,
  }));
  expect(readable.file).not.toBe(lockedPath);
  expect(readable.encrypted).toBe(false);
  expect(fs.existsSync(readable.file)).toBe(false);
  expect(await withDecryptedPdf({ inputPath: plainPath, tempDir: workDir, timeoutMs: TEST_TIMEOUT_MS }, async (file) => file)).toBe(plainPath);
}, TEST_TIMEOUT_MS);

oracleTest('a file that needs a user password is still refused as such when none is given', TOOLS, async () => {
  const locked = qpdfEncrypt(await plainPdf(['Locked body']), { variant: AES_256, userPassword: 'user-secret-1', ownerPassword: 'owner-secret-1' });
  const error = await captureError(() => withDecryptedPdf({ inputPath: write('needs-password.pdf', locked), tempDir: workDir, timeoutMs: TEST_TIMEOUT_MS }, async () => 'reached the tool'));
  expect(error).toMatchObject({ name: 'PdfPasswordRequiredError', refusalCode: 'password_required' });
}, TEST_TIMEOUT_MS);

oracleTest('the page counter that reads the file itself (no pdfinfo) opens a file with only an owner password', TOOLS, async () => {
  vi.stubEnv('PDFINFO_PATH', path.join(workDir, 'no-pdfinfo'));
  const locked = qpdfEncrypt(await plainPdf(['One', 'Two']), { variant: AES_256, userPassword: '', ownerPassword: 'owner-secret-1', modify: 'none' });
  const rendered = await convertPdfPagesWithNativeTools(locked, 'png', {}, 'locked.pdf');
  expect(rendered).not.toBeNull();
  expect(rendered!.mimeType).toBe('application/zip');
}, TEST_TIMEOUT_MS);

oracleTest('the pages rendered for OCR are refused for a JBIG2 page of 1.25 GB in a file with only an owner password', TOOLS, async () => {
  const locked = qpdfEncrypt(jbig2BombPdf(), { variant: AES_256, userPassword: '', ownerPassword: 'owner-secret-1', modify: 'none' });
  const error = await captureError(() => openPdfPageRenderer(locked, undefined, undefined));
  expect(error).toMatchObject({ name: 'DecompressionLimitError', status: HTTP_PAYLOAD_TOO_LARGE });
}, TEST_TIMEOUT_MS);
