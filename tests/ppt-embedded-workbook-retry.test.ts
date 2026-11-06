import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { ConversionFailedError } from '../src/lib/types';
import { readPptSlides } from '../src/lib/conversions/office/ppt-reader';
import { SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError, SandboxedTimeoutError } from '../src/worker/sandbox';
import { executeWorkerConversion, convertWithHeadlessOffice } from '../src/worker/engines';
import { withEmbeddedWorkbookRetry, type OfficeSuiteRun } from '../src/worker/office-suite-route';
import { writeKeepExcelObjectsSetting } from '../src/worker/libreoffice-profile';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A PowerPoint 97-2003 presentation with Excel charts in it: the office suite converts each chart to a Calc chart on import, and a chart
 * whose series name whole columns gets an internal table of 1,048,578 rows (770 MB of `content.xml` for each of the two charts of
 * `govdocs1-001020.ppt`). On LibreOffice 25.2.3.2 the ODP of that file fails to store after 13 s; on 24.2.7 it takes 21 to 29 s and the
 * nightly run hit the 45 s stage limit. The second run leaves the Excel objects as objects (`ExcelToCalc` off), which takes under a second
 * (docs/policy-decisions.md entry 164).
 */

const LIBREOFFICE_TIMEOUT_MS = 300_000;
const FILE = 'govdocs1-001020.ppt';
/** Slides in the file, as the PowerPoint 97-2003 reader of this repository counts them from the slide records (the office suite prints 53 pages of it too). */
const SLIDES = 53;
const MAX_ODP_BYTES = 64 * 1024 * 1024;
/** What the first run, which fails, may leave of its temporary files in the shared temporary directory. */
const MAX_LEFTOVER_BYTES = 100 * 1024 * 1024;

afterAll(() => vi.restoreAllMocks());

/** Bytes of the office suite's temporary files (`lu*.tmp`, a file or a directory) in the shared temporary directory. */
function suiteTemporaryBytes(): number {
  const sizeOf = (entry: string): number => {
    const stat = fs.statSync(entry, { throwIfNoEntry: false });
    if (!stat) return 0;
    return stat.isDirectory() ? fs.readdirSync(entry).reduce((total, name) => total + sizeOf(path.join(entry, name)), 0) : stat.size;
  };
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => /^lu.*\.tmp$/.test(name))
    .reduce((total, name) => total + sizeOf(path.join(os.tmpdir(), name)), 0);
}

const OK = { buffer: Buffer.from('ok') } as unknown as Awaited<ReturnType<OfficeSuiteRun>>;
const noOutput = () => new Error('LibreOffice execution completed without producing expected output file for target format "odp"');

/** A run that fails with `errors` one after the other and then converts; returns the options each call got. */
function runner(...errors: unknown[]): { run: OfficeSuiteRun; calls: Array<Record<string, unknown> | undefined> } {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const pending = [...errors];
  const run: OfficeSuiteRun = async (_input, _source, _target, options) => {
    calls.push(options as Record<string, unknown> | undefined);
    if (pending.length > 0) throw pending.shift();
    return OK;
  };
  return { run, calls };
}

describe('the second run of a presentation the first run ended without a verdict on', () => {
  it.each([
    ['a time-out', new SandboxedTimeoutError(45_000)],
    ['an abort', new SandboxedProcessError('soffice exited with signal SIGABRT', null, 'double free or corruption', 'SIGABRT')],
    ['a memory limit', new SandboxedMemoryLimitError(2048, 'SIGSEGV')],
    ['an output limit', new SandboxedBufferLimitError(100, 'file-size')],
    ['no output file', noOutput()],
  ])('keeps the Excel objects after %s', async (_name, failure) => {
    const { run, calls } = runner(failure);
    expect(await withEmbeddedWorkbookRetry(run)(Buffer.from('x'), 'ppt', 'odp', { timeoutMs: 1000 }, 'a.ppt')).toBe(OK);
    expect(calls).toEqual([{ timeoutMs: 1000 }, { timeoutMs: 1000, keepEmbeddedExcelObjects: true }]);
  });

  it.each(['ppt', 'pps', 'pot'])('is also run for a .%s file', async (source) => {
    const { run, calls } = runner(new SandboxedTimeoutError(1));
    await withEmbeddedWorkbookRetry(run)(Buffer.from('x'), source, 'pdf', {}, `a.${source}`);
    expect(calls).toHaveLength(2);
  });

  it('is not run when the first run converted', async () => {
    const { run, calls } = runner();
    await withEmbeddedWorkbookRetry(run)(Buffer.from('x'), 'ppt', 'odp', {}, 'a.ppt');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['a Word file', 'doc'],
    ['a PowerPoint 2007 file', 'pptx'],
    ['an OpenDocument presentation', 'odp'],
    ['a workbook', 'xls'],
  ])('is not run for %s', async (_name, source) => {
    const { run, calls } = runner(new SandboxedTimeoutError(1));
    await expect(withEmbeddedWorkbookRetry(run)(Buffer.from('x'), source, 'pdf', {}, `a.${source}`)).rejects.toBeInstanceOf(SandboxedTimeoutError);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['a file the suite could not load', new SandboxedProcessError('Error: source file could not be loaded', 1, 'source file could not be loaded')],
    ['a typed failure', new ConversionFailedError('The file is encrypted.')],
    ['a plain error of the program lookup', new Error('spawn soffice ENOENT')],
  ])('is not run after %s', async (_name, failure) => {
    const { run, calls } = runner(failure);
    await expect(withEmbeddedWorkbookRetry(run)(Buffer.from('x'), 'ppt', 'odp', {}, 'a.ppt')).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });

  it('is not run for a cancelled job, and is not run twice', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = runner(new SandboxedTimeoutError(1));
    await expect(withEmbeddedWorkbookRetry(cancelled.run)(Buffer.from('x'), 'ppt', 'odp', { signal: controller.signal }, 'a.ppt')).rejects.toBeInstanceOf(SandboxedTimeoutError);
    expect(cancelled.calls).toHaveLength(1);
    const again = runner(new SandboxedTimeoutError(1));
    await expect(withEmbeddedWorkbookRetry(again.run)(Buffer.from('x'), 'ppt', 'odp', { keepEmbeddedExcelObjects: true }, 'a.ppt')).rejects.toBeInstanceOf(SandboxedTimeoutError);
    expect(again.calls).toHaveLength(1);
  });

  it('answers with the first failure when the second run fails too', async () => {
    const first = new SandboxedTimeoutError(45_000);
    const { run, calls } = runner(first, new SandboxedProcessError('soffice failed', 1, 'other'));
    await expect(withEmbeddedWorkbookRetry(run)(Buffer.from('x'), 'ppt', 'odp', {}, 'a.ppt')).rejects.toBe(first);
    expect(calls).toHaveLength(2);
  });
});

describe('the profile of a run that keeps the Excel objects', () => {
  it('holds the one setting, in the file the office suite reads', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-excel-'));
    try {
      writeKeepExcelObjectsSetting(root);
      const settings = fs.readFileSync(path.join(root, 'user', 'registrymodifications.xcu'), 'utf-8');
      expect(settings).toContain('oor:path="/org.openoffice.Office.Common/Filter/Microsoft/Import"');
      expect(settings.match(/<prop /g)).toHaveLength(1);
      expect(settings).toMatch(/oor:name="ExcelToCalc"[^>]*><value>false<\/value>/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is the profile the office suite is started with, in a run of its own', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-soffice-'));
    const seen = path.join(dir, 'seen.txt');
    const stub = path.join(dir, 'soffice');
    fs.writeFileSync(
      stub,
      [
        '#!/bin/sh',
        'case "$*" in *--help*) exit 0;; esac',
        'outdir=""; input=""; profile=""',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in -env:UserInstallation=file://*) profile="${1#-env:UserInstallation=file://}";; esac',
        '  if [ "$1" = "--outdir" ]; then outdir="$2"; fi',
        '  input="$1"',
        '  shift',
        'done',
        `grep -o 'ExcelToCalc[^>]*><value>[a-z]*' "$profile/user/registrymodifications.xcu" >> '${seen}' 2>/dev/null || echo none >> '${seen}'`,
        `echo "tmp=$TMPDIR home=$HOME" >> '${seen}'`,
        'echo odp > "$outdir/input.odp"',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    const previous = process.env.SOFFICE_PATH;
    process.env.SOFFICE_PATH = stub;
    try {
      await convertWithHeadlessOffice(Buffer.from('x'), 'ppt', 'odp', { keepEmbeddedExcelObjects: true, throwOnUnavailable: true }, 'a.ppt');
      const [setting, directories] = fs.readFileSync(seen, 'utf-8').trim().split('\n');
      expect(setting).toBe('ExcelToCalc" oor:op="fuse"><value>false');
      // The suite's temporary files are written next to its home, in the directory of the run, and not in the shared temporary directory.
      const [, tmp, home] = /^tmp=(\S+) home=(\S+)$/.exec(directories) ?? [];
      expect({ same: tmp === home, inRunDirectory: path.basename(tmp).startsWith('easyconvert-office-') }).toEqual({ same: true, inRunDirectory: true });
    } finally {
      if (previous === undefined) delete process.env.SOFFICE_PATH;
      else process.env.SOFFICE_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a real presentation with two Excel charts of whole columns', () => {
  oracleTest(
    `${FILE} is converted to ODP with all ${SLIDES} slides, in the size of a presentation`,
    ['soffice'],
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, FILE);
      const slidesInFile = readPptSlides(bytes).length;
      const leftBefore = suiteTemporaryBytes();
      const result = await executeWorkerConversion(bytes, 'ppt', 'odp', {}, FILE);
      const zip = await JSZip.loadAsync(result.buffer);
      const content = await zip.file('content.xml')!.async('string');
      expect({
        mimetype: await zip.file('mimetype')!.async('string'),
        slides: (content.match(/<draw:page /g) ?? []).length,
        slidesInFile,
        small: result.buffer.length < MAX_ODP_BYTES,
        leftOver: suiteTemporaryBytes() - leftBefore < MAX_LEFTOVER_BYTES,
      }).toEqual({ mimetype: 'application/vnd.oasis.opendocument.presentation', slides: SLIDES, slidesInFile: SLIDES, small: true, leftOver: true });
    },
    LIBREOFFICE_TIMEOUT_MS
  );
});
