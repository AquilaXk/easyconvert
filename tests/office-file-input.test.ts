import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, describe, expect, it } from 'vitest';
import { LibreOfficePoolManager } from '../src/worker/libreoffice-pool';
import { convertWithHeadlessOffice } from '../src/worker/engines';
import { officeInputWithoutMacros } from '../src/worker/office-input-checks';
import { craftDocx, paragraph } from './helpers/docx-craft';
import { sofficeConvert } from './helpers/soffice-convert';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The queue workers hand the office suite a file of the store (`{ inputPath }`, named by a digest and `.bin` or `.staged`), not a
 * buffer. The suite names its output after the file it was given, so the run has to be given a file called `input.<format>`: the output
 * is looked for by that name, and the suite picks its filters for text-like formats by the extension.
 */

const sofficeMissing = skipWithoutTools('soffice');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'office-file-input-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function storedFile(bytes: Buffer, extension = 'bin'): string {
  const file = path.join(scratch, `${crypto.randomBytes(32).toString('hex')}.${extension}`);
  fs.writeFileSync(file, bytes);
  return file;
}

/** A runner that behaves like `soffice --convert-to`: it writes `<name of the input file>.<target>` to the output directory. */
function sofficeLikeRunner(seen: string[]) {
  return async (_bin: string, args: string[], options?: { cwd?: string }) => {
    const outdir = args[args.indexOf('--outdir') + 1];
    const input = args[args.length - 1];
    if (args.includes('--convert-to')) {
      seen.push(input);
      const target = args[args.indexOf('--convert-to') + 1].split(':')[0];
      fs.writeFileSync(path.join(outdir ?? options?.cwd ?? scratch, `${path.parse(input).name}.${target}`), Buffer.from('%PDF-1.7 produced'));
    }
    return { stdout: Buffer.from(''), stderr: Buffer.from(''), exitCode: 0, durationMs: 1, sandboxed: true, sandboxType: 'host' as const };
  };
}

describe('the office suite pool given a file of the store', () => {
  it.each([
    ['docx', 'bin'],
    ['doc', 'staged'],
  ])('finds the output of a .%s held as <digest>.%s, keeps the stored file and honours the output path', async (format, extension) => {
    const seen: string[] = [];
    const pool = new LibreOfficePoolManager({ maxWorkers: 1, sofficePath: '/usr/bin/soffice', enabled: true, executor: sofficeLikeRunner(seen) });
    try {
      const stored = storedFile(Buffer.from(`stored ${format}`), extension);
      const outputPath = path.join(scratch, `out-${format}.pdf`);
      const result = await pool.convert({ inputPath: stored, outputPath }, format, 'pdf', { timeoutMs: 5000 }, `report.${format}`);
      expect(result?.filePath).toBe(outputPath);
      expect(fs.readFileSync(outputPath, 'utf8')).toBe('%PDF-1.7 produced');
      expect(seen).toHaveLength(1);
      expect(path.basename(seen[0])).toBe(`input.${format}`);
      expect(fs.readFileSync(stored, 'utf8')).toBe(`stored ${format}`);
      expect(fs.readdirSync(scratch).filter((name) => name.startsWith(path.parse(stored).name))).toEqual([path.basename(stored)]);
    } finally {
      await pool.shutdown();
    }
  });

  it('does not lose the output of a conversion to the format of its source', async () => {
    const seen: string[] = [];
    const pool = new LibreOfficePoolManager({ maxWorkers: 1, sofficePath: '/usr/bin/soffice', enabled: true, executor: sofficeLikeRunner(seen) });
    try {
      const stored = storedFile(Buffer.from('stored odd'));
      const result = await pool.convert({ inputPath: stored }, 'odd', 'odd', { timeoutMs: 5000 }, 'drawing.odd');
      expect(result?.buffer.toString()).toBe('%PDF-1.7 produced');
      expect(fs.readFileSync(stored, 'utf8')).toBe('stored odd');
    } finally {
      await pool.shutdown();
    }
  });
});

describe.skipIf(sofficeMissing)('the real office suite given a file of the store', () => {
  const REAL_TIMEOUT_MS = 180_000;
  const docx = async () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.docx'));

  it.each([
    ['the pool', {}],
    ['a run of its own', { keepEmbeddedExcelObjects: true }],
  ])('converts a .docx held as <digest>.bin through %s', async (_name, options) => {
    const result = await convertWithHeadlessOffice({ inputPath: storedFile(await docx()) }, 'docx', 'pdf', { ...options, throwOnUnavailable: true }, 'letter.docx');
    expect(result?.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    if (result?.filePath) fs.rmSync(result.filePath, { force: true });
  }, REAL_TIMEOUT_MS);

  it('converts a .doc held as <digest>.staged', async () => {
    const doc = sofficeConvert(await docx(), 'seed.docx', 'doc:MS Word 97', (output) => output.read());
    const result = await convertWithHeadlessOffice({ inputPath: storedFile(doc, 'staged') }, 'doc', 'pdf', { throwOnUnavailable: true }, 'old.doc');
    expect(result?.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    if (result?.filePath) fs.rmSync(result.filePath, { force: true });
  }, REAL_TIMEOUT_MS);
});

describe('the macros of a file input', () => {
  it('are removed from the bytes handed over without losing the output path', async () => {
    const zip = await JSZip.loadAsync(await craftDocx({ body: paragraph('with macros') }));
    zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'));
    zip.file('word/vbaProject.bin', Buffer.from('never read'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const outputPath = path.join(scratch, 'kept.pdf');
    const handed = await officeInputWithoutMacros({ inputPath: storedFile(bytes), outputPath });
    expect(Buffer.isBuffer(handed)).toBe(false);
    expect((handed as { outputPath?: string }).outputPath).toBe(outputPath);
    const names = Object.keys((await JSZip.loadAsync((handed as { inputBuffer: Buffer }).inputBuffer)).files);
    expect(names.filter((name) => name.includes('vba'))).toEqual([]);
  });
});
