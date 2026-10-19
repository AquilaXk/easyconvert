import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  deletePdfPages,
  extractPdfPages,
  protectPdf,
  reorderPdfPages,
  rotatePdfPages,
  splitPdfPages,
  unlockPdf,
} from '../src/lib/conversions/pdf-postprocess';
import { sandboxLauncherState, startSandboxLauncher, stopSandboxLauncher } from '../src/lib/security/sandbox-launcher';
import { withDecryptedPdf } from '../src/worker/pdf-decrypt';
import {
  PdfPasswordRequiredError,
  PdfPermissionDeniedError,
} from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import {
  AES_256,
  containsEncryptKey,
  pdfinfoPages,
  plainPdf,
  qpdfCheckPasses,
  qpdfEncrypt,
  qpdfEncryptionReport,
  withTempDir,
} from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The PDF operations when qpdf is started through the launcher helper (src/lib/security/sandbox-launcher.ts), which is
 * what a worker of a few hundred megabytes does. The process reports a large resident size, as such a worker has, so
 * that the launcher is judged worth it; each test checks that the helper started the program (the count of launched
 * programs rises) and reads the result back with tools that share no code with the product: qpdf --check and
 * --json for structure and encryption, pdfinfo for page counts and rotation, pdftotext for the text of each page.
 */

const PAGE_TEXTS = ['Alpha page one', 'Bravo page two', 'Charlie page three', 'Delta page four', 'Echo page five'] as const;
const USER_PASSWORD = 'user-secret-695';
const OWNER_PASSWORD = 'owner-secret-695';
const FORM_FEED = '\f';
const LARGE_WORKER_BYTES = 1024 * 1024 * 1024;

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext', 'pdfinfo');

function pageTexts(pdf: Buffer): string[] {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const text = execFileSync(requireOracleTool('pdftotext'), [file, '-'], { encoding: 'utf-8' });
    return text.split(FORM_FEED).slice(0, -1).map((page) => page.trim());
  });
}

function pageRotations(pdf: Buffer): number[] {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const info = execFileSync(requireOracleTool('pdfinfo'), ['-f', '1', '-l', String(pdfinfoPages(pdf)), file], { encoding: 'utf-8' });
    return [...info.matchAll(/Page\s+\d+ rot:\s+(\d+)/g)].map((match) => Number.parseInt(match[1], 10));
  });
}

/** Whether this host lets an unprivileged process create a user and network namespace, which strict isolation needs. */
const canIsolateNetwork = process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0;

async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to be rejected, but it resolved');
}

/** The error name and message of a rejection, which a test compares as plain data. */
async function refusal(run: Promise<unknown>): Promise<{ name: string; message: string }> {
  const error = (await rejection(run)) as Error;
  return { name: error.name, message: error.message };
}

/** Runs `operation` and returns what it returned with the number of programs the helper started during it. */
async function launched<T>(operation: () => Promise<T>): Promise<{ value: T; programs: number }> {
  const before = sandboxLauncherState().launched;
  const value = await operation();
  return { value, programs: sandboxLauncherState().launched - before };
}

describe.skipIf(toolsMissing)('PDF operations through the launcher', () => {
  beforeAll(async () => {
    vi.spyOn(process.memoryUsage, 'rss').mockReturnValue(LARGE_WORKER_BYTES);
    expect(await startSandboxLauncher()).toBe(true);
  }, 60_000);

  afterAll(() => {
    vi.restoreAllMocks();
    stopSandboxLauncher();
  });

  const source = (): Promise<Buffer> => plainPdf([...PAGE_TEXTS]);

  it('extracts, reorders and deletes pages: the right pages in the right order, in a PDF qpdf accepts', async () => {
    const pdf = await source();
    const extracted = await launched(() => extractPdfPages(pdf, '4,2-3'));
    expect(extracted.programs).toBe(1);
    expect(qpdfCheckPasses(extracted.value)).toBe(true);
    expect(pageTexts(extracted.value)).toEqual([PAGE_TEXTS[3], PAGE_TEXTS[1], PAGE_TEXTS[2]]);

    const reordered = await launched(() => reorderPdfPages(pdf, { order: '5,1' }));
    expect(reordered.programs).toBe(1);
    expect(pageTexts(reordered.value)).toEqual([PAGE_TEXTS[4], PAGE_TEXTS[0], PAGE_TEXTS[1], PAGE_TEXTS[2], PAGE_TEXTS[3]]);

    // Delete runs the edit and, beside it, the page count that tells an emptied document from a result: two programs.
    const deleted = await launched(() => deletePdfPages(pdf, '2,4'));
    expect(deleted.programs).toBe(2);
    expect(qpdfCheckPasses(deleted.value)).toBe(true);
    expect(pageTexts(deleted.value)).toEqual([PAGE_TEXTS[0], PAGE_TEXTS[2], PAGE_TEXTS[4]]);
  });

  it('rotates the listed pages and leaves the others', async () => {
    const rotated = await launched(async () => rotatePdfPages(await source(), { rotation: 90, pages: '2-3' }));
    expect(rotated.programs).toBe(1);
    expect(qpdfCheckPasses(rotated.value)).toBe(true);
    expect(pageRotations(rotated.value)).toEqual([0, 90, 90, 0, 0]);
  });

  it('splits into one PDF per page, whichever of the parallel programs finishes first', async () => {
    const split = await launched(async () => splitPdfPages(await source(), { ranges: '1,2-3,5' }, {}, 'book'));
    expect(split.programs).toBe(3);
    const archive = await JSZip.loadAsync(split.value);
    const names = Object.keys(archive.files).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(['book-part001.pdf', 'book-part002.pdf', 'book-part003.pdf']);
    const texts: string[][] = [];
    for (const name of names) {
      texts.push(pageTexts(await archive.files[name].async('nodebuffer'))); // NOSONAR S9382 sequential
    }
    expect(texts).toEqual([[PAGE_TEXTS[0]], [PAGE_TEXTS[1], PAGE_TEXTS[2]], [PAGE_TEXTS[4]]]);

    // Delete counts the pages beside the edit, and the helper started both programs.
    const deleted = await launched(async () => deletePdfPages(await source(), '1'));
    expect(deleted.programs).toBe(2);
    expect(pageTexts(deleted.value)).toEqual(PAGE_TEXTS.slice(1));
  });

  it('protects with AES-256 and the requested rights, read back by qpdf under both passwords', async () => {
    const protectedPdf = await launched(async () => protectPdf(await source(), { userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, keyLength: 256 }));
    // The probe that asks qpdf for the pages (a looping tree is mended before encryption), then the encryption: two programs.
    expect(protectedPdf.programs).toBe(2);
    const asUser = qpdfEncryptionReport(protectedPdf.value, USER_PASSWORD);
    expect(asUser.encrypted).toBe(true);
    expect(asUser.R).toBe(AES_256.revision);
    expect(asUser.userPasswordMatched).toBe(true);
    expect(asUser.ownerPasswordMatched).toBe(false);
    expect(asUser.capabilities.modifyother).toBe(false);
    expect(asUser.capabilities.extract).toBe(false);
    expect(asUser.capabilities.printhigh).toBe(true);
    expect(qpdfEncryptionReport(protectedPdf.value, OWNER_PASSWORD).ownerPasswordMatched).toBe(true);
    expect(qpdfCheckPasses(protectedPdf.value, USER_PASSWORD)).toBe(true);
    expect(pdfinfoPages(protectedPdf.value, USER_PASSWORD)).toBe(PAGE_TEXTS.length);
  });

  it('unlocks a restricted file with its user password once the rights are confirmed, through the launched programs', async () => {
    const locked = qpdfEncrypt(await source(), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' });
    const unlocked = await launched(() => unlockPdf(locked, { password: USER_PASSWORD, confirmEditRights: true }));
    // The decryption, then the probe that asks qpdf for the pages (a looping tree is mended on the decrypted bytes): two programs.
    expect(unlocked.programs).toBe(2);
    expect(containsEncryptKey(unlocked.value)).toBe(false);
    expect(qpdfEncryptionReport(unlocked.value).encrypted).toBe(false);
    expect(pageTexts(unlocked.value)).toEqual([...PAGE_TEXTS]);
  });

  it('keeps the edit gate: restrictions need the confirmation or the owner password, and a wrong password is refused', async () => {
    const locked = qpdfEncrypt(await source(), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' });
    const denied = await rejection(rotatePdfPages(locked, { rotation: 90 }, { password: USER_PASSWORD }));
    expect(denied).toBeInstanceOf(PdfPermissionDeniedError);
    const wrong = await rejection(rotatePdfPages(locked, { rotation: 90 }, { password: 'wrong-guess' }));
    expect(wrong).toBeInstanceOf(PdfPasswordRequiredError);
    const missing = await rejection(extractPdfPages(locked, '1'));
    expect(missing).toBeInstanceOf(PdfPasswordRequiredError);
    // Two programs ask about the same file at once (the verdict and the decryption): both went through the helper.
    const before = sandboxLauncherState().launched;
    const byOwner = await rotatePdfPages(locked, { rotation: 90, pages: '1' }, { password: OWNER_PASSWORD });
    expect(sandboxLauncherState().launched - before).toBe(3);
    expect(qpdfCheckPasses(byOwner)).toBe(true);
    expect(pageRotations(byOwner)[0]).toBe(90);
    expect(containsEncryptKey(byOwner)).toBe(false);
  });

  it('decrypts to a file for the readers through the helper and removes the copy and the password file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-decrypt-'));
    try {
      const encrypted = qpdfEncrypt(await source(), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
      const inputPath = path.join(dir, 'in.pdf');
      fs.writeFileSync(inputPath, encrypted);
      const before = sandboxLauncherState().launched;
      let seen: string[] = [];
      const bytes = await withDecryptedPdf({ inputPath, tempDir: dir, password: USER_PASSWORD, timeoutMs: 60_000 }, (readable) => {
        seen = fs.readdirSync(dir);
        return Promise.resolve(fs.readFileSync(readable));
      });
      expect(sandboxLauncherState().launched - before).toBe(1);
      expect(seen.filter((name) => name.startsWith('decrypted-'))).toHaveLength(1);
      expect(qpdfEncryptionReport(bytes).encrypted).toBe(false);
      expect(pageTexts(bytes)).toEqual([...PAGE_TEXTS]);
      expect(fs.readdirSync(dir).sort()).toEqual(['in.pdf']);
      const wrong = await rejection(withDecryptedPdf({ inputPath, tempDir: dir, password: 'wrong-guess', timeoutMs: 60_000 }, () => Promise.resolve(1)));
      expect(wrong).toBeInstanceOf(PdfPasswordRequiredError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the page guards: a page past the end, an emptied document and a file that is no PDF are refused with the same typed errors', async () => {
    const pdf = await source();
    expect(await refusal(extractPdfPages(pdf, '9'))).toEqual({ name: 'InvalidPageRangeError', message: 'Page 9 is out of range: the document has fewer pages.' });
    expect(await refusal(deletePdfPages(pdf, '1-5'))).toEqual({
      name: 'PdfPostprocessError',
      message: 'Deleting the pages failed: the specification names every page, and a PDF needs at least one.',
    });
    expect(await refusal(extractPdfPages(Buffer.from('this is not a pdf at all'), '1'))).toEqual({
      name: 'CorruptStreamError',
      message: 'Invalid PDF document: missing %PDF- header',
    });
  });

  it('keeps the strict isolation: qpdf runs in an empty network namespace where the host can make one, and the request fails with the typed error, before qpdf starts, where it cannot', async () => {
    vi.stubEnv('STRICT_SANDBOX', 'true');
    try {
      const outcome = await extractPdfPages(await source(), '2').then(
        (out) => ({ ran: true, texts: pageTexts(out) }),
        (error: Error) => ({ ran: false, name: error.name })
      );
      expect(outcome).toEqual(canIsolateNetwork ? { ran: true, texts: [PAGE_TEXTS[1]] } : { ran: false, name: 'SandboxUnavailableError' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
