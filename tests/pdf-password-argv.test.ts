import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ConversionFailedError } from '../src/lib/types';
import { executeWorkerConversion, getPdfPageCount } from '../src/worker/engines';
import { withDecryptedPdf } from '../src/worker/pdf-decrypt';
import { getOracleToolPath, type ExternalOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Issue #450: a PDF password must never appear in the argument vector of any spawned process,
 * because argv is readable by every local user through /proc/<pid>/cmdline.
 *
 * Oracle design:
 *  - The recorder wraps `child_process.spawn` (the single call every sandboxed binary goes through)
 *    and delegates to the real implementation, so the binaries really run and the argv is captured
 *    exactly as the kernel receives it, including any prlimit/unshare wrapper.
 *  - The encrypted fixture is produced by the qpdf CLI, and every expected value (page count,
 *    raster dimensions, raster bytes, text) comes from the poppler CLIs run on the unencrypted
 *    original, never from the module under test.
 */

interface SpawnRecord {
  command: string;
  args: string[];
  cwd: string | undefined;
  /** State of the file named by `--password-file=` captured at the instant of the spawn. */
  passwordFile?: { filePath: string; mode: number; bytes: Buffer };
}

const spawnRecorder = vi.hoisted(() => ({
  active: false,
  calls: [] as Array<{
    command: string;
    args: string[];
    cwd: string | undefined;
    passwordFile?: { filePath: string; mode: number; bytes: Buffer };
  }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const nodeFs = await import('node:fs');
  const PASSWORD_FILE_FLAG = '--password-file=';
  const recordingSpawn = ((command: string, argsOrOptions?: unknown, maybeOptions?: unknown) => {
    if (spawnRecorder.active) {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions.map(String) : [];
      const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) as
        | { cwd?: string }
        | undefined;
      const record: (typeof spawnRecorder.calls)[number] = { command, args, cwd: options?.cwd };
      const flag = args.find((a) => a.startsWith(PASSWORD_FILE_FLAG));
      if (flag) {
        const filePath = flag.slice(PASSWORD_FILE_FLAG.length);
        try {
          record.passwordFile = {
            filePath,
            mode: nodeFs.statSync(filePath).mode & 0o777,
            bytes: nodeFs.readFileSync(filePath),
          };
        } catch {
          // Leave passwordFile undefined: the assertions below then fail on the missing capture.
        }
      }
      spawnRecorder.calls.push(record);
    }
    return (actual.spawn as (...a: unknown[]) => unknown)(command, argsOrOptions, maybeOptions);
  }) as typeof actual.spawn;
  return { ...actual, spawn: recordingSpawn, default: { ...actual, spawn: recordingSpawn } };
});

/** Shell-hostile but within the 32-byte limit of poppler's own `-upw` buffer, so the CLI oracle can read it. */
const USER_PASSWORD = `Canary-7f3a "q" 'x' $H;#1`;
const OWNER_PASSWORD = 'Owner-Canary-91bd';
const PASSWORD_CORE = 'Canary-7f3a';
const UNICODE_PASSWORD = 'Canary-ünï-7f3a-密码';
/** Longer than poppler's 32-byte `-upw` buffer, which silently truncates it: only a non-argv route can open it. */
const LONG_PASSWORD_PADDING_LENGTH = 40;
const LONG_PASSWORD = `${PASSWORD_CORE}-${'x'.repeat(LONG_PASSWORD_PADDING_LENGTH)}`;
const PAGE_COUNT = 3;
const PAGE_WIDTH_PT = 300;
const PAGE_HEIGHT_PT = 200;
const RASTER_DPI = 100;
const TEST_TIMEOUT_MS = 60_000;
const PDF_TOOL_TIMEOUT_MS = 20_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;
const KEY_LENGTH_BITS = '256';
const PASSWORD_FILE_MODE = 0o600;
const POPPLER_SANDBOX_PREFIX = 'easyconvert-poppler-';
const REQUIRED_TOOLS: ExternalOracleTool[] = ['qpdf', 'pdfinfo', 'pdftoppm', 'pdftocairo', 'pdftotext'];

const workDirs: string[] = [];
const producedFiles: string[] = [];

afterAll(() => {
  for (const file of producedFiles) fs.rmSync(file, { force: true });
  for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tool(name: ExternalOracleTool): string {
  const resolved = getOracleToolPath(name);
  if (!resolved) throw new Error(`oracle tool ${name} is not installed`);
  return resolved;
}

function makeWorkDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  workDirs.push(dir);
  return dir;
}

interface Fixture {
  dir: string;
  plainPath: string;
  encryptedPath: string;
  encrypted: Buffer;
  plain: Buffer;
  unicodeEncryptedPath: string;
  longEncryptedPath: string;
}

let fixturePromise: Promise<Fixture> | undefined;

/** Builds the page content with pdf-lib, then encrypts it with the qpdf CLI (the independent oracle). */
function getFixture(): Promise<Fixture> {
  fixturePromise ??= (async () => {
    const dir = makeWorkDir('easyconvert-pdfpw-fixture-');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let page = 1; page <= PAGE_COUNT; page++) {
      doc.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]).drawText(`Protected page ${page} token ZEBRA${page}`, {
        x: 20,
        y: 100,
        size: 14,
        font,
      });
    }
    const plainPath = path.join(dir, 'plain.pdf');
    fs.writeFileSync(plainPath, await doc.save());

    const encryptedPath = path.join(dir, 'encrypted.pdf');
    execFileSync(tool('qpdf'), ['--encrypt', USER_PASSWORD, OWNER_PASSWORD, KEY_LENGTH_BITS, '--', plainPath, encryptedPath]);
    const unicodeEncryptedPath = path.join(dir, 'encrypted-unicode.pdf');
    execFileSync(tool('qpdf'), ['--encrypt', UNICODE_PASSWORD, OWNER_PASSWORD, KEY_LENGTH_BITS, '--', plainPath, unicodeEncryptedPath]);
    const longEncryptedPath = path.join(dir, 'encrypted-long.pdf');
    execFileSync(tool('qpdf'), ['--encrypt', LONG_PASSWORD, OWNER_PASSWORD, KEY_LENGTH_BITS, '--', plainPath, longEncryptedPath]);
    return {
      dir,
      plainPath,
      encryptedPath,
      unicodeEncryptedPath,
      longEncryptedPath,
      plain: fs.readFileSync(plainPath),
      encrypted: fs.readFileSync(encryptedPath),
    };
  })();
  return fixturePromise;
}

async function recordSpawns<T>(
  operation: () => Promise<T>
): Promise<{ outcome: PromiseSettledResult<T>; calls: SpawnRecord[] }> {
  spawnRecorder.calls = [];
  spawnRecorder.active = true;
  let outcome: PromiseSettledResult<T>;
  try {
    outcome = { status: 'fulfilled', value: await operation() };
  } catch (reason) {
    outcome = { status: 'rejected', reason };
  } finally {
    spawnRecorder.active = false;
  }
  return { outcome, calls: [...spawnRecorder.calls] };
}

function fulfilled<T>(outcome: PromiseSettledResult<T>): T {
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}

function binariesSpawned(calls: SpawnRecord[]): Set<string> {
  return new Set(calls.flatMap((c) => [c.command, ...c.args]).map((token) => path.basename(token)));
}

/** Every argv token that carries the password, or a flag that would carry it. */
function passwordLeaks(calls: SpawnRecord[], ...secrets: string[]): string[] {
  const leaks: string[] = [];
  for (const call of calls) {
    for (const token of [call.command, ...call.args]) {
      const carriesSecret = secrets.some((s) => token.includes(s)) || token.includes(PASSWORD_CORE);
      const isPasswordFlag = /^(-upw|-opw|--password(=.*)?)$/.test(token);
      if (carriesSecret || isPasswordFlag) {
        leaks.push(`${path.basename(call.command)}: ${token}`);
      }
    }
  }
  return leaks;
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
  return { width: png.readUInt32BE(PNG_IHDR_WIDTH_OFFSET), height: png.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET) };
}

function oraclePageCount(pdfPath: string, password?: string): number {
  const args = password === undefined ? [pdfPath] : ['-upw', password, pdfPath];
  const out = execFileSync(tool('pdfinfo'), args, { encoding: 'utf-8' });
  const match = /^Pages:\s+(\d+)/m.exec(out);
  if (!match) throw new Error(`pdfinfo reported no page count for ${pdfPath}`);
  return Number.parseInt(match[1], 10);
}

function oracleRasterPage(pdfPath: string, page: number): Buffer {
  const dir = makeWorkDir('easyconvert-pdfpw-oracle-png-');
  const prefix = path.join(dir, 'out');
  execFileSync(tool('pdftoppm'), ['-r', String(RASTER_DPI), '-png', '-f', String(page), '-l', String(page), '-singlefile', pdfPath, prefix]);
  return fs.readFileSync(`${prefix}.png`);
}

function trackOutput(result: { filePath?: string }): void {
  if (result.filePath) producedFiles.push(result.filePath);
}

describe('PDF password is never passed on the command line (issue #450)', () => {
  describe('fixture sanity (qpdf encrypted, poppler reads it only with the password)', () => {
    oracleTest('is encrypted: poppler rejects a missing and a wrong password and accepts the right one', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      expect(oraclePageCount(fixture.encryptedPath, USER_PASSWORD)).toBe(PAGE_COUNT);
      expect(() => oraclePageCount(fixture.encryptedPath)).toThrow();
      expect(() => oraclePageCount(fixture.encryptedPath, 'definitely-wrong')).toThrow();
      expect(fixture.encrypted.includes(Buffer.from('/Encrypt'))).toBe(true);
      expect(fixture.encrypted.includes(Buffer.from('ZEBRA1'))).toBe(false);
    });
  });

  describe('no spawned argv carries the password', () => {
    oracleTest('rasterizes one page to PNG matching the poppler oracle, with the password absent from argv', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const { outcome, calls } = await recordSpawns(() =>
        executeWorkerConversion(fixture.encrypted, 'pdf', 'png', { password: USER_PASSWORD, pages: '2', dpi: RASTER_DPI }, 'secret.pdf')
      );
      const result = fulfilled(outcome);
      trackOutput(result);

      expect(passwordLeaks(calls, USER_PASSWORD, OWNER_PASSWORD)).toEqual([]);
      const spawned = binariesSpawned(calls);
      expect(spawned.has('pdftoppm')).toBe(true);
      expect(spawned.has('pdfinfo')).toBe(true);

      expect(result.engineUsed).toBe('native-poppler');
      const oracle = oracleRasterPage(fixture.plainPath, 2);
      expect(pngDimensions(result.buffer)).toEqual(pngDimensions(oracle));
      expect(pngDimensions(result.buffer).width).toBe(Math.ceil((PAGE_WIDTH_PT * RASTER_DPI) / 72));
      expect(result.buffer.equals(oracle)).toBe(true);
    }, TEST_TIMEOUT_MS);

    oracleTest('rasterizes every page to a ZIP whose entry count equals the pdfinfo page count', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const { outcome, calls } = await recordSpawns(() =>
        executeWorkerConversion(fixture.encrypted, 'pdf', 'png', { password: USER_PASSWORD, dpi: RASTER_DPI }, 'secret.pdf')
      );
      const result = fulfilled(outcome);
      trackOutput(result);

      expect(passwordLeaks(calls, USER_PASSWORD, OWNER_PASSWORD)).toEqual([]);
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toHaveLength(oraclePageCount(fixture.encryptedPath, USER_PASSWORD));
      for (const [index, name] of names.entries()) {
        const entry = await zip.files[name].async('nodebuffer');
        expect(entry.equals(oracleRasterPage(fixture.plainPath, index + 1))).toBe(true);
      }
    }, TEST_TIMEOUT_MS);

    oracleTest('renders SVG through pdftocairo with the password absent from argv', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const { outcome, calls } = await recordSpawns(() =>
        executeWorkerConversion(fixture.encrypted, 'pdf', 'svg', { password: USER_PASSWORD, pages: '3' }, 'secret.pdf')
      );
      const result = fulfilled(outcome);
      trackOutput(result);

      expect(passwordLeaks(calls, USER_PASSWORD, OWNER_PASSWORD)).toEqual([]);
      expect(binariesSpawned(calls).has('pdftocairo')).toBe(true);

      const oracleDir = makeWorkDir('easyconvert-pdfpw-oracle-svg-');
      const oracleSvg = path.join(oracleDir, 'page.svg');
      execFileSync(tool('pdftocairo'), ['-svg', '-f', '3', '-l', '3', fixture.plainPath, oracleSvg]);
      const svg = result.buffer.toString('utf-8');
      const widthOf = (text: string) => /<svg[^>]*\swidth="([\d.]+)/.exec(text)?.[1];
      expect(svg.startsWith('<?xml')).toBe(true);
      expect(widthOf(svg)).toBe(PAGE_WIDTH_PT.toString());
      expect(widthOf(svg)).toBe(widthOf(fs.readFileSync(oracleSvg, 'utf-8')));
    }, TEST_TIMEOUT_MS);

    oracleTest('extracts the exact pdftotext content of a protected PDF with the password absent from argv', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const { outcome, calls } = await recordSpawns(() =>
        executeWorkerConversion(fixture.encrypted, 'pdf', 'txt', { password: USER_PASSWORD }, 'secret.pdf')
      );
      const result = fulfilled(outcome);
      trackOutput(result);

      expect(passwordLeaks(calls, USER_PASSWORD, OWNER_PASSWORD)).toEqual([]);
      expect(binariesSpawned(calls).has('pdftotext')).toBe(true);
      expect(result.engineUsed).toBe('native-poppler');

      const oracleText = execFileSync(tool('pdftotext'), ['-layout', fixture.plainPath, '-'], { encoding: 'utf-8' });
      const text = result.buffer.toString('utf-8');
      expect(text).toBe(oracleText);
      for (let page = 1; page <= PAGE_COUNT; page++) {
        expect(text).toContain(`Protected page ${page} token ZEBRA${page}`);
      }
    }, TEST_TIMEOUT_MS);

    oracleTest('counts pages of a protected PDF with the password absent from argv', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const jobDir = makeWorkDir('easyconvert-pdfpw-count-');
      const { outcome, calls } = await recordSpawns(() =>
        getPdfPageCount(fixture.encryptedPath, jobDir, PDF_TOOL_TIMEOUT_MS, undefined, undefined, USER_PASSWORD)
      );

      expect(fulfilled(outcome)).toBe(oraclePageCount(fixture.encryptedPath, USER_PASSWORD));
      expect(passwordLeaks(calls, USER_PASSWORD, OWNER_PASSWORD)).toEqual([]);
      expect(binariesSpawned(calls).has('pdfinfo')).toBe(true);
      expect(fs.readdirSync(jobDir)).toEqual([]);
    }, TEST_TIMEOUT_MS);

    oracleTest('opens PDFs protected by non-ASCII and over-long passwords byte-exactly', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const cases = [
        { filePath: fixture.unicodeEncryptedPath, password: UNICODE_PASSWORD },
        { filePath: fixture.longEncryptedPath, password: LONG_PASSWORD },
      ];
      for (const { filePath, password } of cases) {
        const jobDir = makeWorkDir('easyconvert-pdfpw-bytes-');
        const { outcome, calls } = await recordSpawns(() =>
          getPdfPageCount(filePath, jobDir, PDF_TOOL_TIMEOUT_MS, undefined, undefined, password)
        );

        // qpdf reads the same password from its own file: an oracle that never sees argv limits.
        const passwordFile = path.join(jobDir, 'oracle-password.txt');
        fs.writeFileSync(passwordFile, password, { mode: PASSWORD_FILE_MODE });
        const qpdfPages = execFileSync(tool('qpdf'), ['--show-npages', `--password-file=${passwordFile}`, filePath], {
          encoding: 'utf-8',
        });
        expect(fulfilled(outcome)).toBe(Number.parseInt(qpdfPages, 10));
        expect(fulfilled(outcome)).toBe(PAGE_COUNT);
        expect(passwordLeaks(calls, password)).toEqual([]);
      }
    }, TEST_TIMEOUT_MS);
  });

  describe('password file lifecycle', () => {
    oracleTest('hands qpdf a 0600 password file with the exact bytes inside the job sandbox, deleted afterwards', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const { outcome, calls } = await recordSpawns(() =>
        executeWorkerConversion(fixture.encrypted, 'pdf', 'png', { password: USER_PASSWORD, pages: '1', dpi: RASTER_DPI }, 'secret.pdf')
      );
      trackOutput(fulfilled(outcome));

      const qpdfCalls = calls.filter((c) => binariesSpawned([c]).has('qpdf'));
      expect(qpdfCalls.length).toBeGreaterThan(0);
      for (const call of qpdfCalls) {
        const passwordFile = call.passwordFile;
        expect(passwordFile).toBeTruthy();
        expect(passwordFile!.mode).toBe(PASSWORD_FILE_MODE);
        expect(passwordFile!.bytes.equals(Buffer.from(USER_PASSWORD, 'utf-8'))).toBe(true);
        // Inside the private per-job sandbox directory, which no longer exists once the job ended.
        expect(path.dirname(passwordFile!.filePath)).toBe(call.cwd);
        expect(path.basename(call.cwd!).startsWith(POPPLER_SANDBOX_PREFIX)).toBe(true);
        expect(fs.existsSync(passwordFile!.filePath)).toBe(false);
        expect(fs.existsSync(call.cwd!)).toBe(false);
      }
    }, TEST_TIMEOUT_MS);

    oracleTest('exposes a 0600 decrypted copy to the operation and removes it and the password file afterwards', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const jobDir = makeWorkDir('easyconvert-pdfpw-lifecycle-');
      let seenInside: string[] = [];
      let decryptedMode = 0;
      let decryptedHead = '';

      await withDecryptedPdf(
        { inputPath: fixture.encryptedPath, tempDir: jobDir, password: USER_PASSWORD, timeoutMs: PDF_TOOL_TIMEOUT_MS },
        async (readablePath) => {
          seenInside = fs.readdirSync(jobDir);
          decryptedMode = fs.statSync(readablePath).mode & 0o777;
          decryptedHead = fs.readFileSync(readablePath).subarray(0, 5).toString('latin1');
          // The decrypted copy is readable without any password: the independent oracle proves it.
          expect(oraclePageCount(readablePath)).toBe(PAGE_COUNT);
        }
      );

      expect(seenInside).toHaveLength(1);
      expect(seenInside[0].startsWith('qpdf-password')).toBe(false);
      expect(decryptedMode).toBe(PASSWORD_FILE_MODE);
      expect(decryptedHead).toBe('%PDF-');
      expect(fs.readdirSync(jobDir)).toEqual([]);
    }, TEST_TIMEOUT_MS);

    oracleTest('removes every temporary file when the operation throws', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const jobDir = makeWorkDir('easyconvert-pdfpw-throw-');
      const boom = new Error('operation failed');

      await expect(
        withDecryptedPdf(
          { inputPath: fixture.encryptedPath, tempDir: jobDir, password: USER_PASSWORD, timeoutMs: PDF_TOOL_TIMEOUT_MS },
          async () => {
            expect(fs.readdirSync(jobDir)).toHaveLength(1);
            throw boom;
          }
        )
      ).rejects.toBe(boom);
      expect(fs.readdirSync(jobDir)).toEqual([]);
    }, TEST_TIMEOUT_MS);

    oracleTest('removes every temporary file when the job is aborted before qpdf starts', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const jobDir = makeWorkDir('easyconvert-pdfpw-preabort-');
      const controller = new AbortController();
      const reason = new Error('client went away');
      controller.abort(reason);

      await expect(
        withDecryptedPdf(
          { inputPath: fixture.encryptedPath, tempDir: jobDir, password: USER_PASSWORD, timeoutMs: PDF_TOOL_TIMEOUT_MS, signal: controller.signal },
          async () => 'unreachable'
        )
      ).rejects.toBe(reason);
      expect(fs.readdirSync(jobDir)).toEqual([]);
    }, TEST_TIMEOUT_MS);

    oracleTest('removes the decrypted copy when the job is aborted while the operation runs', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const jobDir = makeWorkDir('easyconvert-pdfpw-midabort-');
      const controller = new AbortController();
      const reason = new Error('client went away mid-render');

      await expect(
        withDecryptedPdf(
          { inputPath: fixture.encryptedPath, tempDir: jobDir, password: USER_PASSWORD, timeoutMs: PDF_TOOL_TIMEOUT_MS, signal: controller.signal },
          (readablePath) =>
            new Promise<string>((_resolve, reject) => {
              expect(fs.existsSync(readablePath)).toBe(true);
              controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
              setImmediate(() => controller.abort(reason));
            })
        )
      ).rejects.toBe(reason);
      expect(fs.readdirSync(jobDir)).toEqual([]);
    }, TEST_TIMEOUT_MS);
  });

  describe('fails closed with the typed conversion error', () => {
    oracleTest('rejects a wrong password with ConversionFailedError, leaking neither the password nor temp files', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const wrongPassword = 'Wrong-Canary-0000';
      const { outcome, calls } = await recordSpawns(() =>
        executeWorkerConversion(fixture.encrypted, 'pdf', 'png', { password: wrongPassword, dpi: RASTER_DPI }, 'secret.pdf')
      );

      expect(outcome.status).toBe('rejected');
      const error = (outcome as PromiseRejectedResult).reason as Error;
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect(error.message).toMatch(/password/i);
      expect(error.message).not.toContain(wrongPassword);
      expect(passwordLeaks(calls, wrongPassword)).toEqual([]);
      expect(binariesSpawned(calls).has('pdftoppm')).toBe(false);
      for (const call of calls) {
        if (call.cwd?.includes(POPPLER_SANDBOX_PREFIX)) expect(fs.existsSync(call.cwd)).toBe(false);
      }
    }, TEST_TIMEOUT_MS);

    oracleTest('rejects a missing password on an encrypted PDF with ConversionFailedError', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const { outcome } = await recordSpawns(() =>
        executeWorkerConversion(fixture.encrypted, 'pdf', 'png', { dpi: RASTER_DPI }, 'secret.pdf')
      );

      expect(outcome.status).toBe('rejected');
      const error = (outcome as PromiseRejectedResult).reason as Error;
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect(error.message).toMatch(/password/i);
    }, TEST_TIMEOUT_MS);

    oracleTest('rejects a password containing a newline instead of silently truncating it, before spawning anything', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const { outcome, calls } = await recordSpawns(() =>
        executeWorkerConversion(fixture.encrypted, 'pdf', 'png', { password: `${USER_PASSWORD}\nsecond line` }, 'secret.pdf')
      );

      expect(outcome.status).toBe('rejected');
      const error = (outcome as PromiseRejectedResult).reason as Error;
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect(error.message).toMatch(/newline|null/i);
      expect(calls).toEqual([]);
    }, TEST_TIMEOUT_MS);

    oracleTest('rejects a malformed PDF submitted with a password instead of emitting output', REQUIRED_TOOLS, async () => {
      const jobDir = makeWorkDir('easyconvert-pdfpw-malformed-');
      const malformed = path.join(jobDir, 'malformed.pdf');
      fs.writeFileSync(malformed, '%PDF-1.7\nthis is not a real pdf body\n');

      const { outcome } = await recordSpawns(() =>
        withDecryptedPdf(
          { inputPath: malformed, tempDir: jobDir, password: USER_PASSWORD, timeoutMs: PDF_TOOL_TIMEOUT_MS },
          async () => 'unreachable'
        )
      );

      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(ConversionFailedError);
      expect(fs.readdirSync(jobDir)).toEqual(['malformed.pdf']);
    }, TEST_TIMEOUT_MS);
  });

  describe('behaviour that must not change', () => {
    oracleTest('still converts an unprotected PDF without invoking qpdf when no password is supplied', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const { outcome, calls } = await recordSpawns(() =>
        executeWorkerConversion(fixture.plain, 'pdf', 'png', { pages: '1', dpi: RASTER_DPI }, 'open.pdf')
      );
      const result = fulfilled(outcome);
      trackOutput(result);

      expect(binariesSpawned(calls).has('qpdf')).toBe(false);
      expect(result.buffer.equals(oracleRasterPage(fixture.plainPath, 1))).toBe(true);
    }, TEST_TIMEOUT_MS);

    oracleTest('still converts an unprotected PDF when a password is supplied anyway', REQUIRED_TOOLS, async () => {
      const fixture = await getFixture();
      const { outcome, calls } = await recordSpawns(() =>
        executeWorkerConversion(fixture.plain, 'pdf', 'png', { password: USER_PASSWORD, pages: '1', dpi: RASTER_DPI }, 'open.pdf')
      );
      const result = fulfilled(outcome);
      trackOutput(result);

      expect(passwordLeaks(calls, USER_PASSWORD)).toEqual([]);
      expect(result.buffer.equals(oracleRasterPage(fixture.plainPath, 1))).toBe(true);
    }, TEST_TIMEOUT_MS);
  });
});
