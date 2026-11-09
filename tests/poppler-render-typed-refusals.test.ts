import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, expect } from 'vitest';
import { PAGE_IMAGE_MAX_PAGES } from '../src/lib/conversions/page-range';
import { convertPdfPagesWithNativeTools } from '../src/worker/engines';
import { captureError } from './helpers/capture-error';
import { type ExternalOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * A refusal with a code of its own is answered whether or not the caller asked for errors on a missing tool
 * (`throwOnUnavailable`): the Poppler render does not turn it into "nothing converted" for the next engine to try.
 * Oracle: qpdf writes the encrypted file, pdf-lib the long one with a known page count.
 */

const TOOLS: ExternalOracleTool[] = ['pdftoppm', 'pdfinfo', 'qpdf'];
const TEST_TIMEOUT_MS = 120_000;
const HTTP_PAYLOAD_TOO_LARGE = 413;

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppler-refusals-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function pdfWithPages(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pageCount; index++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

oracleTest('a PDF that needs a password is refused as such, not answered with nothing', TOOLS, async () => {
  const plain = path.join(workDir, 'plain.pdf');
  const encrypted = path.join(workDir, 'encrypted.pdf');
  fs.writeFileSync(plain, await pdfWithPages(1));
  execFileSync('qpdf', ['--encrypt', 'user-secret', 'owner-secret', '256', '--', plain, encrypted]);
  const error = await captureError(() => convertPdfPagesWithNativeTools(fs.readFileSync(encrypted), 'png', {}, 'locked.pdf'));
  expect(error).toMatchObject({ name: 'PdfPasswordRequiredError', refusalCode: 'password_required' });
}, TEST_TIMEOUT_MS);

oracleTest(`${PAGE_IMAGE_MAX_PAGES + 1} selected pages are refused with the typed 413 without throwOnUnavailable`, TOOLS, async () => {
  const longer = await pdfWithPages(PAGE_IMAGE_MAX_PAGES + 1);
  const error = await captureError(() => convertPdfPagesWithNativeTools(longer, 'png', {}, 'long.pdf'));
  expect(error).toMatchObject({ name: 'PayloadLimitError', status: HTTP_PAYLOAD_TOO_LARGE });
}, TEST_TIMEOUT_MS);
