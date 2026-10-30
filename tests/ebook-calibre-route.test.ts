import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requiresNativeEngine } from '../src/lib/conversions/native-engine-pairs';
import { CALIBRE_EBOOK_TARGETS } from '../src/lib/conversions/calibre-ebook-targets';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { convertWithCalibre, type CalibreDeps, type CalibreRequest } from '../src/worker/ebook-calibre';
import {
  ConversionFailedError,
  CpuTaskTimeoutError,
  EncryptedOfficeDocumentError,
  EngineMissingError,
  EngineUnavailableError,
  InvalidConversionOutputError,
  PayloadLimitError,
} from '../src/lib/types';
import { withMissingBinary } from './helpers/native-tools';

/**
 * The route of the calibre targets (MOBI, AZW3, PDB, LRF, OEB) without calibre: the typed answer of a worker that lacks
 * the program, the in-process engine that has no writer, and the route itself against small stand-in programs that record
 * how they were started (arguments, environment, working directory) and write what a test needs them to. The files that
 * the real program writes are read back by tests/ebook-calibre-writers.test.ts.
 */

const TARGETS = [...CALIBRE_EBOOK_TARGETS].sort();
const PLAIN_TEXT = Buffer.from('A short book.\n\nWith two paragraphs.\n', 'utf-8');
const HANGUL = '안녕하세요 한글 문장입니다.';
const FAKE_TEXT_NAME = 'fake-text.txt';
const TIME_LIMIT_MS = 1500;
const PROCESS_END_WAIT_MS = 3000;
const PROCESS_POLL_MS = 50;
const SRC_ROOT = path.join(__dirname, '..', 'src');

let workDir: string;
let logPath: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibre-route-test-'));
  logPath = path.join(workDir, 'runs.jsonl');
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

interface Run {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

/**
 * A stand-in for `ebook-convert`, a Node script that appends how it was started to a log and then runs `behavior`, a body that
 * sees `input`, `output`, `rest` (the arguments after the two paths) and `fs`.
 */
function fakeProgram(behavior: string): string {
  const program = path.join(workDir, 'ebook-convert');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const [input, output, ...rest] = process.argv.slice(2);
const env = Object.fromEntries(['HOME', 'TMPDIR', 'CALIBRE_CONFIG_DIRECTORY', 'CALIBRE_CACHE_DIRECTORY', 'CALIBRE_TEMP_DIR', 'QT_QPA_PLATFORM', 'HTTPS_PROXY', 'EBOOK_CONVERT_PATH', 'DATABASE_URL', 'SECRET_TOKEN'].map((name) => [name, process.env[name]]));
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env }) + '\\n');
${behavior}
`;
  fs.writeFileSync(program, script, { mode: 0o755 });
  return program;
}

function runsOf(): Run[] {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Run) : [];
}

/** What a stand-in writes for the target: the head a Palm database of the format starts with, the LRF magic, an OEB folder, or the text of the scan. */
function validOutput(): string {
  return `
const heads = { mobi: [60, 'BOOKMOBI'], azw3: [60, 'BOOKMOBI'], pdb: [60, 'TEXtREAd'] };
const target = output.split('.').pop();
if (target === 'txt') fs.copyFileSync(${JSON.stringify(fakeTextPath())}, output);
else if (target === 'oeb') { fs.mkdirSync(output + '/OEBPS', { recursive: true }); fs.writeFileSync(output + '/content.opf', '<package/>'); fs.writeFileSync(output + '/OEBPS/c1.xhtml', '<html/>'); }
else if (target === 'lrf') fs.writeFileSync(output, Buffer.from([0x4c, 0, 0x52, 0, 0x46, 0, 0, 0, 1, 2, 3]));
else { const [at, magic] = heads[target]; const book = Buffer.alloc(80); book.write(magic, at, 'latin1'); fs.writeFileSync(output, book); }
`;
}

function fakeTextPath(): string {
  return path.join(workDir, FAKE_TEXT_NAME);
}

function setScannedText(text: string): void {
  fs.writeFileSync(fakeTextPath(), text);
}

function deps(epub: Buffer = Buffer.from('epub bytes')): CalibreDeps & { converted: Array<{ src: string; tgt: string }>; discarded: Array<string | undefined> } {
  const converted: Array<{ src: string; tgt: string }> = [];
  const discarded: Array<string | undefined> = [];
  return {
    converted,
    discarded,
    async convert(_input, src, target) {
      converted.push({ src, tgt: target });
      return { buffer: epub, mimeType: 'application/epub+zip', filename: 'book.epub', size: epub.length, engineUsed: 'internal-fallback', executionTimeMs: 0 };
    },
    discardOutput(filePath) {
      discarded.push(filePath);
    },
  };
}

function request(src: string, tgt: string, input: Buffer = PLAIN_TEXT, options: CalibreRequest['options'] = {}): CalibreRequest {
  return { input, src, tgt, options, originalFilename: `book.${src}` };
}

/** Whether the process is gone or only waits to be reaped (a zombie still answers a signal of 0, `ps` lists it as Z). */
function hasEnded(pid: number): boolean {
  const listed = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' });
  const state = listed.stdout.trim();
  return listed.status !== 0 || state === '' || state.startsWith('Z');
}

async function endsWithin(pid: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (!hasEnded(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
  return hasEnded(pid);
}

describe('a worker without ebook-convert', () => {
  it.each(TARGETS)('answers an unavailable engine for .%s and never writes a file of its own', async (target) => {
    const run = withMissingBinary('EBOOK_CONVERT_PATH', () => dispatchConversion(PLAIN_TEXT, 'txt', target, {}, 'book.txt'));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'ebook-convert' });
    await expect(run).rejects.toBeInstanceOf(EngineMissingError);
  });

  it.each(TARGETS)('does not read the source of a .%s conversion before it knows the program is missing', async (target) => {
    const unread = deps();
    await expect(convertWithCalibre(unread, request('txt', target), null)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(unread.converted).toEqual([]);
  });

  it.each(TARGETS)('has no in-process writer for .%s', async (target) => {
    const failure = await convertFile(PLAIN_TEXT, 'txt', target, {}, 'book.txt').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as Error).message).toBe(`Engine 'ebook-convert' is unavailable: Writing .${target} needs the native ebook-convert (calibre) engine; the in-process engine has no writer for it.`);
  });

  it('marks every pair that ends in a calibre target as native-engine only, for every source the registry advertises', () => {
    const pairs = Object.entries(FORMAT_REGISTRY).flatMap(([source, def]) => def.targetFormats.filter((target) => CALIBRE_EBOOK_TARGETS.has(target)).map((target) => [source, target] as const));
    expect(pairs.length).toBeGreaterThan(CALIBRE_EBOOK_TARGETS.size);
    expect(pairs.filter(([source, target]) => !requiresNativeEngine(source, target))).toEqual([]);
  });

  it('keeps no placeholder text in the sources', () => {
    const found: string[] = [];
    const pending = [SRC_ROOT];
    while (pending.length > 0) {
      const dir = pending.pop() as string;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else if (/\.tsx?$/.test(entry.name) && fs.readFileSync(full, 'utf-8').includes('Extracted content from')) found.push(path.relative(SRC_ROOT, full));
      }
    }
    expect(found).toEqual([]);
  });
});

describe('the calibre route against a stand-in program', () => {
  it.each([
    ['mobi', ['--mobi-file-type', 'old', '--no-inline-toc']],
    ['azw3', ['--no-inline-toc']],
    ['lrf', []],
    ['oeb', []],
  ])('starts ebook-convert for .%s with the options of the target', async (target, options) => {
    setScannedText('unused');
    const program = fakeProgram(validOutput());
    const result = await convertWithCalibre(deps(), request('txt', target), program);
    const [run] = runsOf();
    expect(runsOf()).toHaveLength(1);
    expect(path.basename(run.args[0])).toBe('book.epub');
    expect(path.basename(run.args[1])).toBe(`converted.${target}`);
    expect(run.args.slice(2)).toEqual(options);
    expect(result.engineUsed).toBe('native-calibre');
    expect(result.filename).toBe(`book.${target}`);
    fs.rmSync(result.filePath as string, { force: true });
  });

  it('writes the source as EPUB with the project converters unless calibre reads the source itself', async () => {
    const program = fakeProgram(validOutput());
    setScannedText('unused');
    const converters = deps();
    const results = [];
    for (const src of ['txt', 'html', 'pdf', 'docx', 'rb']) results.push(await convertWithCalibre(converters, request(src, 'mobi'), program));
    expect(converters.converted).toEqual(['txt', 'html', 'pdf', 'docx', 'rb'].map((src) => ({ src, tgt: 'epub' })));
    expect(converters.discarded).toHaveLength(5);
    expect(runsOf().map((run) => path.basename(run.args[0]))).toEqual(Array(5).fill('book.epub'));
    for (const result of results) fs.rmSync(result.filePath as string, { force: true });
  });

  it.each(['mobi', 'azw', 'azw3', 'pdb', 'lrf', 'fb2'])('hands a .%s book to calibre as it is, under a name with its extension', async (src) => {
    const program = fakeProgram(validOutput());
    setScannedText('unused');
    const converters = deps();
    const book = Buffer.from(`${src} book bytes`);
    const result = await convertWithCalibre(converters, request(src, src === 'mobi' ? 'azw3' : 'mobi', book), program);
    expect(converters.converted).toEqual([]);
    const [run] = runsOf();
    expect(path.basename(run.args[0])).toBe(`book.${src}`);
    fs.rmSync(result.filePath as string, { force: true });
  });

  it('gives calibre a configuration, cache and temporary directory of the job, no network and no secret of the worker', async () => {
    const program = fakeProgram(validOutput());
    setScannedText('unused');
    process.env.SECRET_TOKEN = 'must-not-reach-calibre';
    process.env.DATABASE_URL = 'postgres://must-not-reach-calibre';
    try {
      const first = await convertWithCalibre(deps(), request('txt', 'mobi'), program);
      const second = await convertWithCalibre(deps(), request('txt', 'mobi'), program);
      const [a, b] = runsOf();
      for (const run of [a, b]) {
        const jobDir = path.dirname(run.args[0]);
        expect(path.basename(jobDir)).toMatch(/^easyconvert-calibre-/);
        expect(jobDir.startsWith(os.tmpdir())).toBe(true);
        for (const name of ['HOME', 'TMPDIR', 'CALIBRE_CONFIG_DIRECTORY', 'CALIBRE_CACHE_DIRECTORY', 'CALIBRE_TEMP_DIR'] as const) {
          expect(run.env[name]?.startsWith(jobDir + path.sep), name).toBe(true);
        }
        expect(run.env.QT_QPA_PLATFORM).toBe('offscreen');
        expect(run.env.HTTPS_PROXY).toBe('http://127.0.0.1:0');
        expect(run.env.SECRET_TOKEN).toBeUndefined();
        expect(run.env.DATABASE_URL).toBeUndefined();
      }
      expect(path.dirname(a.args[0])).not.toBe(path.dirname(b.args[0]));
      expect(a.env.CALIBRE_CONFIG_DIRECTORY).not.toBe(b.env.CALIBRE_CONFIG_DIRECTORY);
      expect(fs.existsSync(path.dirname(a.args[0]))).toBe(false);
      for (const result of [first, second]) fs.rmSync(result.filePath as string, { force: true });
    } finally {
      delete process.env.SECRET_TOKEN;
      delete process.env.DATABASE_URL;
    }
  });

  it('packs the OEB folder as a ZIP with its OPF package and XHTML', async () => {
    const program = fakeProgram(validOutput());
    const result = await convertWithCalibre(deps(), request('txt', 'oeb'), program);
    expect(result.mimeType).toBe('application/zip');
    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files).sort()).toEqual(['OEBPS/', 'OEBPS/c1.xhtml', 'content.opf'].filter((name) => !name.endsWith('/')));
    fs.rmSync(result.filePath as string, { force: true });
  });

  it.each([
    ['A short book with café and naïve.', 'cp1252'],
    [HANGUL, 'utf-8'],
    ['Euro € and “quotes” — all in Windows-1252', 'cp1252'],
    ['An emoji 😀 is past U+FFFF', 'utf-8'],
  ])('writes a PalmDOC book in an encoding that keeps the text of %j (%s)', async (text, encoding) => {
    setScannedText(text);
    const program = fakeProgram(validOutput());
    const result = await convertWithCalibre(deps(), request('txt', 'pdb'), program);
    const [scan, write] = runsOf();
    expect(path.basename(scan.args[1])).toBe('text-scan.txt');
    expect(scan.args.slice(2)).toEqual([]);
    expect(write.args.slice(2)).toEqual(['--format', 'doc', '--pdb-output-encoding', encoding]);
    fs.rmSync(result.filePath as string, { force: true });
  });

  it('answers a book protected by DRM with the typed 422 error', async () => {
    const program = fakeProgram(`process.stderr.write('Traceback...\\ncalibre.ebooks.DRMError: This book is locked by DRM\\n'); process.exit(1);`);
    const error = await convertWithCalibre(deps(), request('mobi', 'azw3', Buffer.from('book')), program).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EncryptedOfficeDocumentError);
    expect(error).not.toBeInstanceOf(EngineMissingError);
    expect(error).toMatchObject({ status: 422, message: 'The .mobi book is protected by DRM and cannot be converted.' });
  });

  it('answers a failed run with a typed error that names the last line calibre printed and not the job directory', async () => {
    const program = fakeProgram(`process.stderr.write('Traceback (most recent call last):\\n  File "x"\\nValueError: bad record at ' + input + '\\n'); process.exit(1);`);
    const error = await convertWithCalibre(deps(), request('mobi', 'azw3', Buffer.from('book')), program).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error).not.toBeInstanceOf(EngineMissingError);
    const message = (error as Error).message;
    expect(message).toContain('ValueError: bad record at <tmp>');
    expect(message).not.toContain(os.tmpdir());
  });

  it.each([
    ['mobi', 'writes a file that is not a Palm database', `fs.writeFileSync(output, 'plain text');`],
    ['lrf', 'writes a file without the LRF magic', `fs.writeFileSync(output, 'plain text, not a BBeB book');`],
    ['pdb', 'writes a Mobipocket book for a PalmDOC target', `const book = Buffer.alloc(80); book.write('BOOKMOBI', 60, 'latin1'); fs.writeFileSync(output, book);`],
  ])('refuses a .%s that calibre %s', async (target, _what, behavior) => {
    setScannedText('text');
    const program = fakeProgram(`if (output.endsWith('.txt')) fs.copyFileSync(${JSON.stringify(fakeTextPath())}, output); else { ${behavior} }`);
    const failure = await convertWithCalibre(deps(), request('txt', target), program).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InvalidConversionOutputError);
    expect((failure as Error).message).toBe(`The conversion of the .txt file to .${target} produced bytes that are not a .${target} file.`);
  });

  it('refuses a run that wrote no file, and an OEB folder with no package', async () => {
    const quiet = fakeProgram('process.exit(0);');
    const nothing = await convertWithCalibre(deps(), request('txt', 'mobi'), quiet).catch((error: unknown) => error);
    expect(nothing).toBeInstanceOf(ConversionFailedError);
    expect((nothing as Error).message).toBe('calibre wrote no .mobi file for the .txt file.');
    const folderOnly = fakeProgram(`fs.mkdirSync(output); fs.writeFileSync(output + '/notes.txt', 'no package');`);
    const noPackage = await convertWithCalibre(deps(), request('txt', 'oeb'), folderOnly).catch((error: unknown) => error);
    expect(noPackage).toBeInstanceOf(InvalidConversionOutputError);
    expect((noPackage as Error).message).toBe('The conversion of the .txt file to .oeb produced bytes that are not a .oeb file.');
  });

  it('refuses an e-book larger than a document may be before calibre starts', async () => {
    const program = fakeProgram(validOutput());
    const oversized = { inputPath: path.join(workDir, 'huge.mobi') };
    fs.writeFileSync(oversized.inputPath, '');
    fs.truncateSync(oversized.inputPath, 257 * 1024 * 1024);
    const error = await convertWithCalibre(deps(), { ...request('mobi', 'azw3'), input: oversized }, program).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(runsOf()).toEqual([]);
  });

  it('refuses an EPUB whose archive holds an entry that climbs out of the package, or the same entry twice', async () => {
    const program = fakeProgram(validOutput());
    const climbing = new JSZip();
    climbing.file('mimetype', 'application/epub+zip');
    climbing.file('../escape.xhtml', '<html/>');
    const error = await convertWithCalibre(deps(), request('epub', 'mobi', await climbing.generateAsync({ type: 'nodebuffer' })), program).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(runsOf()).toEqual([]);
  });
});

describe('the calibre route stops a run that outlasts its limit', () => {
  it('kills the program and its child and answers CpuTaskTimeoutError', async () => {
    const pidFile = path.join(workDir, 'pids');
    const program = fakeProgram(`
const { spawn } = require('node:child_process');
const child = spawn('sleep', ['60'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);
setInterval(() => undefined, 1000);
`);
    const error = await convertWithCalibre(deps(), request('mobi', 'azw3', Buffer.from('book'), { timeoutMs: TIME_LIMIT_MS }), program).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CpuTaskTimeoutError);
    const pids = fs.readFileSync(pidFile, 'utf-8').split(' ').map(Number);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(await endsWithin(pid, PROCESS_END_WAIT_MS), `pid ${pid} has ended`).toBe(true);
  }, 30_000);
});
