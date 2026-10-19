import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deletePdfPages,
  extractPdfPages,
  protectPdf,
  reorderPdfPages,
  rotatePdfPages,
  splitPdfPages,
  unlockPdf,
  compressPdf,
} from '../src/lib/conversions/pdf-postprocess';
import {
  launchQpdf,
  qpdfRunnerState,
  QPDF_RUNNER_ENV,
  QPDF_RUNNER_LIB_ENV,
  QPDF_RUNNER_PATH_ENV,
  startQpdfRunner,
  stopQpdfRunner,
} from '../src/lib/conversions/pdf-postprocess/qpdf-runner';
import { executeSandboxedBinary, SandboxedProcessError, type SandboxedExecutionResult } from '../src/lib/security/process-sandbox';
import { buildPdf, type CraftObject } from './helpers/pdf-craft';
import { AES_256, pdfinfoPages, plainPdf, qpdfCheckPasses, qpdfEncrypt, qpdfEncryptionReport, qpdfPath } from './helpers/encrypted-pdf-fixtures';
import { requireOracleTool } from './helpers/differential-oracle';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * The runner against the qpdf program it stands in for, on the PDFs of the repository: the same arguments give the same bytes
 * on standard output, the same files, the same messages on standard error and the same exit status. Every comparison runs
 * the program the way the worker runs it (executeSandboxedBinary, in a namespace of its own) and the runner in turn, on the same file.
 * A run writes a trailer /ID that depends on the time unless asked not to, so the comparisons add `--deterministic-id`; the
 * encryption of a run is random by design and is compared by what qpdf reports about it.
 */

const C_COMPILER = process.env.CC ?? 'cc';
const toolsMissing = skipWithoutTools('qpdf', 'pdfinfo', 'pdftotext');
const compilerMissing = skipUnless('a C compiler (cc)', spawnSync(C_COMPILER, ['--version'], { stdio: 'ignore' }).status === 0);
const canIsolate = process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0;
const namespacesMissing = skipUnless('unprivileged user and network namespaces (unshare -r -n)', canIsolate);

const FIXTURE_DIRS = ['tests/fixtures/pdf-text', 'tests/fixtures/pdf-structure'];
const EXTRA_FILES = ['tests/fixtures/sample.pdf', 'public/sample.pdf', 'tests/fixtures/golden/document/differential-layout.pdf'];
const COMPACT = ['--object-streams=generate', '--compress-streams=y', '--deterministic-id'];
const USER_PASSWORD = 'runner-user-secret';
const OWNER_PASSWORD = 'runner-owner-secret';

let scratch: string;
let qpdf: string;
let corpus: string[];

function corpusFiles(): string[] {
  const files: string[] = [];
  for (const dir of FIXTURE_DIRS) {
    for (const name of fs.readdirSync(path.join(process.cwd(), dir)).sort((a, b) => a.localeCompare(b))) {
      if (name.endsWith('.pdf')) files.push(path.join(process.cwd(), dir, name));
    }
  }
  return [...files, ...EXTRA_FILES.map((file) => path.join(process.cwd(), file))];
}

type Outcome = { ok: true; stdout: Buffer; stderr: string } | { ok: false; exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; message: string };

async function outcome(running: Promise<SandboxedExecutionResult>): Promise<Outcome> {
  try {
    const result = await running;
    return { ok: true, stdout: result.stdout, stderr: result.stderr.toString('utf8') };
  } catch (error) {
    if (!(error instanceof SandboxedProcessError)) throw error;
    return { ok: false, exitCode: error.exitCode, signal: error.signal, stderr: error.stderr, message: error.message };
  }
}

const options = (extra: { stdin?: Buffer; cwd?: string } = {}) => ({ timeoutMs: 60_000, maxBuffer: 256 * 1024 * 1024, networkIsolated: true, cwd: extra.cwd ?? scratch, stdin: extra.stdin });
const viaProgram = (args: string[], extra?: { stdin?: Buffer; cwd?: string }): Promise<Outcome> => outcome(executeSandboxedBinary(qpdf, ['--warning-exit-0', ...args], options(extra)));
const viaRunner = (args: string[], extra?: { stdin?: Buffer; cwd?: string }): Promise<Outcome> => outcome(launchQpdf(qpdf, ['--warning-exit-0', ...args], options(extra)));

/** Both ways on the same arguments; the runner must have taken the job. */
async function same(args: string[], extra?: { stdin?: Buffer; cwd?: string }): Promise<Outcome> {
  const ranBefore = qpdfRunnerState().ran;
  const [program, runner] = [await viaProgram(args, extra), await viaRunner(args, extra)];
  expect(qpdfRunnerState().ran - ranBefore, `the runner took ${args.join(' ')}`).toBe(1);
  expect(runner).toEqual(program);
  return runner;
}

function ringPdf(): Buffer {
  const objects: CraftObject[] = [
    { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { id: 2, dict: '/Type /Pages /Kids [10 0 R] /Count 1' },
    { id: 4, dict: '/Type /Page /Parent 11 0 R /MediaBox [0 0 200 200]' },
    { id: 10, dict: '/Type /Pages /Parent 2 0 R /Kids [11 0 R] /Count 1' },
    { id: 11, dict: '/Type /Pages /Parent 2 0 R /Kids [10 0 R 4 0 R] /Count 1' },
  ];
  return buildPdf(objects, 1).buffer;
}

beforeAll(async () => {
  if (toolsMissing || compilerMissing) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qpdf-runner-qpdf-'));
  const runnerBinary = path.join(scratch, 'qpdf-runner');
  execFileSync(path.join(process.cwd(), 'native', 'qpdf-runner', 'build.sh'), [runnerBinary], { stdio: 'pipe' });
  const loadable = spawnSync(runnerBinary, ['--check'], { encoding: 'utf8' });
  expect(loadable.status, `libqpdf: ${loadable.stderr}`).toBe(0);
  process.env[QPDF_RUNNER_PATH_ENV] = runnerBinary;
  delete process.env[QPDF_RUNNER_LIB_ENV];
  delete process.env[QPDF_RUNNER_ENV];
  qpdf = qpdfPath();
  corpus = corpusFiles();
  if (canIsolate) expect(await startQpdfRunner()).toBe(true);
}, 120_000);

afterAll(() => {
  stopQpdfRunner();
  delete process.env[QPDF_RUNNER_PATH_ENV];
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(toolsMissing || compilerMissing || namespacesMissing)('the qpdf runner against the qpdf program', () => {
  it('loads the library of the program it stands in for', () => {
    const versionLine = execFileSync(qpdf, ['--version'], { encoding: 'utf8' }).split('\n')[0];
    expect(versionLine).toBe(`qpdf version ${qpdfRunnerState().version}`);
  });

  it('runs one job of its own end to end when asked to test itself, as the container check does', () => {
    const test = spawnSync(process.env[QPDF_RUNNER_PATH_ENV]!, ['--self-test'], { encoding: 'utf8' });
    expect({ status: test.status, out: test.stdout.trim(), err: test.stderr }).toEqual({ status: 0, out: 'self-test ok', err: '' });
  });

  it('writes the same bytes as the program for the page operations on every PDF of the repository', async () => {
    expect(corpus.length).toBeGreaterThan(30);
    for (const file of corpus) {
      for (const args of [
        [...COMPACT, file, '--pages', '.', '1', '--', '-'],
        [...COMPACT, '--rotate=+90:1', file, '-'],
        [...COMPACT, '--recompress-flate', '--compression-level=9', file, '-'],
        ['--show-npages', file],
        ['--show-pages', file],
        ['--check', file],
        ['--json=2', '--json-key=qpdf', '--json-stream-data=none', file],
      ]) {
        const result = await same(args); // NOSONAR S9382 sequential
        if (args.includes('--check') && result.ok) expect(result.stdout.toString('utf8')).toContain('No syntax or stream encoding errors');
      }
    }
  }, 300_000);

  it('writes the same files as the program for a split into one file per page', async () => {
    for (const name of ['multipage.pdf', 'two-column.pdf']) {
      const file = path.join(process.cwd(), 'tests/fixtures/pdf-text', name);
      const dirs = [fs.mkdtempSync(path.join(scratch, 'split-a-')), fs.mkdtempSync(path.join(scratch, 'split-b-'))];
      await viaProgram([...COMPACT, '--split-pages=1', file, 'part-%d.pdf'], { cwd: dirs[0] }); // NOSONAR S9382 sequential
      await viaRunner([...COMPACT, '--split-pages=1', file, 'part-%d.pdf'], { cwd: dirs[1] }); // NOSONAR S9382 sequential
      const names = fs.readdirSync(dirs[0]).sort((a, b) => a.localeCompare(b));
      expect(names.length).toBeGreaterThan(0);
      expect(fs.readdirSync(dirs[1]).sort((a, b) => a.localeCompare(b))).toEqual(names);
      for (const part of names) expect(fs.readFileSync(path.join(dirs[1], part)).equals(fs.readFileSync(path.join(dirs[0], part))), part).toBe(true);
    }
  });

  it('gives the same decryption, the same refusals and the same messages for passwords on standard input', async () => {
    const plain = await plainPdf(['Alpha', 'Bravo', 'Charlie']);
    const locked = path.join(scratch, 'locked.pdf');
    fs.writeFileSync(locked, qpdfEncrypt(plain, { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' }));
    const decrypted = await same(['--password-file=-', ...COMPACT, '--decrypt', locked, '-'], { stdin: Buffer.from(USER_PASSWORD) });
    expect(decrypted.ok).toBe(true);
    const wrong = await same(['--password-file=-', '--decrypt', locked, '-'], { stdin: Buffer.from('not the password') });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok ? '' : wrong.stderr).toContain('invalid password');
    await same(['--password-file=-', '--json=2', '--json-key=encrypt', locked], { stdin: Buffer.from(OWNER_PASSWORD) });
    await same(['--password-file=-', '--show-encryption', locked], { stdin: Buffer.from(USER_PASSWORD) });
  });

  it('gives the same exit status and the same message for the documents it cannot read and the pages that are not there', async () => {
    const good = path.join(process.cwd(), 'tests/fixtures/pdf-text/multipage.pdf');
    const files: Record<string, string> = {
      missing: path.join(scratch, 'not-there.pdf'),
      empty: path.join(scratch, 'empty.pdf'),
      text: path.join(scratch, 'text.pdf'),
      truncated: path.join(scratch, 'truncated.pdf'),
      ring: path.join(scratch, 'ring.pdf'),
    };
    fs.writeFileSync(files.empty, '');
    fs.writeFileSync(files.text, 'this is not a pdf at all');
    fs.writeFileSync(files.truncated, fs.readFileSync(good).subarray(0, 9000));
    fs.writeFileSync(files.ring, ringPdf());
    for (const [label, file] of Object.entries(files)) {
      for (const args of [[...COMPACT, file, '--pages', '.', '1', '--', '-'], ['--show-npages', file], ['--check', file]]) {
        const result = await same(args); // NOSONAR S9382 sequential
        expect(result.ok || result.exitCode === 2 || result.exitCode === 3, `${label}: ${args.join(' ')}`).toBe(true);
      }
    }
    const outOfRange = await same([...COMPACT, good, '--pages', '.', '9', '--', '-']);
    expect(outOfRange.ok ? '' : outOfRange.stderr).toMatch(/number 9 out of range/);
    const loop = await same(['--show-pages', files.ring]);
    expect(loop.ok ? '' : loop.stderr).toContain('Loop detected in /Pages structure');
    // The one difference: for an argument qpdf does not know, the program prints the pointer to its help after the message (its main
    // does; the library entry point does not). The message, which is what the product reads, and the status are the same.
    const [programUsage, runnerUsage] = [await viaProgram(['--no-such-option']), await viaRunner(['--no-such-option'])];
    expect(programUsage.ok || runnerUsage.ok).toBe(false);
    const firstLine = (result: Outcome): string => (result.ok ? '' : (result.stderr.trim().split('\n')[0] ?? ''));
    expect(firstLine(runnerUsage)).toBe('qpdf: unrecognized argument --no-such-option');
    expect(firstLine(runnerUsage)).toBe(firstLine(programUsage));
    expect(runnerUsage.ok ? 0 : runnerUsage.exitCode).toBe(programUsage.ok ? 0 : programUsage.exitCode);
  });

  it('does not repeat itself: encryptions of the same document by different jobs differ, as runs of the program do', async () => {
    const source = path.join(process.cwd(), 'tests/fixtures/pdf-text/multipage.pdf');
    const args = ['--encrypt', 'u', 'o', '256', '--', source, '-'];
    const outputs: Buffer[] = [];
    for (let i = 0; i < 6; i++) {
      const result = await viaRunner(args); // NOSONAR S9382 sequential
      expect(result.ok).toBe(true);
      if (result.ok) outputs.push(result.stdout);
    }
    expect(new Set(outputs.map((out) => out.toString('base64'))).size).toBe(outputs.length);
    const [first] = outputs;
    expect(qpdfCheckPasses(first, 'u')).toBe(true);
    expect(qpdfEncryptionReport(first, 'u').R).toBe(AES_256.revision);
    const keys = outputs.map((out) => /\/O\s*<([0-9a-fA-F]+)>/.exec(out.toString('latin1'))?.[1] ?? 'no /O in the clear');
    expect(new Set(keys).size).toBe(outputs.length);
  });

  describe('the PDF operations of the product', () => {
    const PAGE_TEXTS = ['Alpha page one', 'Bravo page two', 'Charlie page three', 'Delta page four', 'Echo page five'];

    function pageTexts(pdf: Buffer): string[] {
      const file = path.join(scratch, `read-${process.hrtime.bigint()}.pdf`);
      fs.writeFileSync(file, pdf);
      const text = execFileSync(requireOracleTool('pdftotext'), [file, '-'], { encoding: 'utf8' });
      fs.rmSync(file, { force: true });
      return text.split('\f').slice(0, -1).map((page) => page.trim());
    }

    it('are served by the runner and read back by tools that share no code with it', async () => {
      const pdf = await plainPdf(PAGE_TEXTS);
      const ranBefore = qpdfRunnerState().ran;
      const fallbacksBefore = qpdfRunnerState().fallbacks;
      const extracted = await extractPdfPages(pdf, '4,2-3');
      expect(qpdfCheckPasses(extracted)).toBe(true);
      expect(pageTexts(extracted)).toEqual([PAGE_TEXTS[3], PAGE_TEXTS[1], PAGE_TEXTS[2]]);
      expect(pageTexts(await reorderPdfPages(pdf, { order: '5,1' }))).toEqual([PAGE_TEXTS[4], PAGE_TEXTS[0], PAGE_TEXTS[1], PAGE_TEXTS[2], PAGE_TEXTS[3]]);
      expect(pageTexts(await deletePdfPages(pdf, '2,4'))).toEqual([PAGE_TEXTS[0], PAGE_TEXTS[2], PAGE_TEXTS[4]]);
      expect(pageTexts(await deletePdfPages(pdf, '1'))).toEqual(PAGE_TEXTS.slice(1));
      await expect(deletePdfPages(pdf, '1-5')).rejects.toThrow(/every page/);
      const rotatedFile = path.join(scratch, 'rotated.pdf');
      fs.writeFileSync(rotatedFile, await rotatePdfPages(pdf, { rotation: 90, pages: '2-3' }));
      const info = execFileSync(requireOracleTool('pdfinfo'), ['-f', '1', '-l', '5', rotatedFile], { encoding: 'utf8' });
      expect([...info.matchAll(/Page\s+\d+ rot:\s+(\d+)/g)].map((match) => Number(match[1]))).toEqual([0, 90, 90, 0, 0]);
      const archive = await JSZip.loadAsync(await splitPdfPages(pdf, { ranges: '1,2-3,5' }, {}, 'book'));
      expect(Object.keys(archive.files)).toHaveLength(3);
      const protectedPdf = await protectPdf(pdf, { userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, keyLength: 256 });
      expect(qpdfEncryptionReport(protectedPdf, USER_PASSWORD).R).toBe(AES_256.revision);
      expect(pdfinfoPages(protectedPdf, USER_PASSWORD)).toBe(PAGE_TEXTS.length);
      const locked = qpdfEncrypt(pdf, { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' });
      expect(pageTexts(await unlockPdf(locked, { password: USER_PASSWORD, confirmEditRights: true }))).toEqual(PAGE_TEXTS);
      const compressed = await compressPdf(pdf, { profile: 'archive' });
      expect(qpdfCheckPasses(compressed.buffer)).toBe(true);
      expect(qpdfRunnerState().ran - ranBefore).toBeGreaterThanOrEqual(12);
      expect(qpdfRunnerState().fallbacks).toBe(fallbacksBefore);
    }, 120_000);
  });
});
