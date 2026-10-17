import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  asUnreadableDocument,
  convertThroughInterchange,
  interchangeNeeded,
  officeSuiteWritesTarget,
  retryRefusedLegacyDocument,
  type OfficeSuiteRequest,
  type OfficeSuiteRouteDeps,
} from '../src/worker/office-suite-route';
import { SandboxedProcessError } from '../src/lib/security/process-sandbox';
import { ConversionFailedError, CorruptStreamError, EngineUnavailableError, SandboxUnavailableError } from '../src/lib/types';
import { resolveLibreOfficeFilter } from '../src/worker/libreoffice-pool';
import { LegacyOfficeFormatError } from '../src/lib/conversions/office/legacy-office-errors';
import type { WorkerConversionResult, WorkerEngineOptions, WorkerVfsPayload } from '../src/worker/worker-types';

/**
 * The office-suite routes of the worker, run on stand-ins for the LibreOffice run and the in-process conversion, so that the
 * paths a request takes (where the intermediate file goes, what the next conversion receives, what is cleaned up, what is
 * answered when the suite is missing or fails) are checked without an installed office suite.
 */

function result(overrides: Partial<WorkerConversionResult> = {}): WorkerConversionResult {
  const buffer = Buffer.from('converted bytes');
  return { buffer, mimeType: 'application/octet-stream', filename: 'out.bin', size: buffer.length, engineUsed: 'native-soffice-pool', executionTimeMs: 1, ...overrides };
}

interface Calls {
  written: Array<{ input: Buffer | WorkerVfsPayload; src: string; target: string; options: WorkerEngineOptions; originalFilename: string }>;
  converted: Array<{ input: Buffer | WorkerVfsPayload; src: string; target: string; options: WorkerEngineOptions; originalFilename: string }>;
  discarded: Array<{ filePath: string | undefined; input: Buffer | WorkerVfsPayload; options: WorkerEngineOptions }>;
}

function standIns(behaviour: { write?: () => Promise<WorkerConversionResult | null>; convert?: () => Promise<WorkerConversionResult> } = {}): { deps: OfficeSuiteRouteDeps; calls: Calls } {
  const calls: Calls = { written: [], converted: [], discarded: [] };
  const deps: OfficeSuiteRouteDeps = {
    async writeWithOfficeSuite(input, src, target, options, originalFilename) {
      calls.written.push({ input, src, target, options, originalFilename });
      return behaviour.write ? behaviour.write() : result({ buffer: Buffer.from('interchange file'), filePath: '/tmp/interchange.docx' });
    },
    async convert(input, src, target, options, originalFilename) {
      calls.converted.push({ input, src, target, options, originalFilename });
      return behaviour.convert ? behaviour.convert() : result({ engineUsed: 'internal-fallback' });
    },
    discardOutput(filePath, input, options) {
      calls.discarded.push({ filePath, input, options });
    },
  };
  return { deps, calls };
}

function request(overrides: Partial<OfficeSuiteRequest> = {}): OfficeSuiteRequest {
  return { input: Buffer.from('source bytes'), src: 'wps', tgt: 'html', options: {}, originalFilename: 'letter.wps', ...overrides };
}

describe('the interchange file of a format only the office suite reads', () => {
  it('is written by the office suite and handed to the conversion of its own format', async () => {
    const { deps, calls } = standIns();
    const converted = await convertThroughInterchange(deps, request(), 'docx');
    expect(converted.engineUsed).toBe('internal-fallback');
    expect(calls.written).toHaveLength(1);
    expect(calls.written[0]).toMatchObject({ src: 'wps', target: 'docx', originalFilename: 'letter.wps' });
    expect(calls.written[0].options).toMatchObject({ throwOnUnavailable: true });
    expect(calls.converted).toHaveLength(1);
    expect(calls.converted[0]).toMatchObject({ src: 'docx', target: 'html', originalFilename: 'letter.wps' });
    expect(calls.converted[0].input).toEqual(Buffer.from('interchange file'));
  });

  it('never goes to the output path of the request, which only the final conversion writes', async () => {
    const { deps, calls } = standIns();
    const input: WorkerVfsPayload = { inputPath: '/in/letter.wps', outputPath: '/out/letter.html' };
    await convertThroughInterchange(deps, request({ input, options: { outputPath: '/out/letter.html' } as WorkerEngineOptions }), 'docx');
    expect(calls.written[0].input).toEqual({ inputPath: '/in/letter.wps', outputPath: undefined });
    expect((calls.written[0].options as { outputPath?: string }).outputPath).toBeUndefined();
    expect(calls.converted[0].input).toEqual({ inputBuffer: Buffer.from('interchange file'), outputPath: '/out/letter.html' });
  });

  it('lets the next conversion run in process: the fallback switch of the request is cleared', async () => {
    const { deps, calls } = standIns();
    await convertThroughInterchange(deps, request({ options: { inProcessFallback: false } }), 'docx');
    expect(calls.converted[0].options.inProcessFallback).toBeUndefined();
  });

  it('is the answer itself when the office suite writes the target, with the request’s output path and options', async () => {
    const { deps, calls } = standIns({ write: async () => result({ filePath: '/out/letter.txt', engineUsed: 'native-soffice' }) });
    const input: WorkerVfsPayload = { inputPath: '/in/letter.wps', outputPath: '/out/letter.txt' };
    const options = { outputPath: '/out/letter.txt' } as WorkerEngineOptions;
    const answer = await convertThroughInterchange(deps, request({ input, tgt: 'txt', options }), 'txt');
    expect(answer.filePath).toBe('/out/letter.txt');
    expect(calls.converted).toEqual([]);
    expect(calls.discarded).toEqual([]);
    expect(calls.written[0].input).toBe(input);
    expect((calls.written[0].options as { outputPath?: string }).outputPath).toBe('/out/letter.txt');
  });

  it('removes the intermediate file whether the conversion after it succeeds or fails', async () => {
    const ok = standIns();
    await convertThroughInterchange(ok.deps, request(), 'docx');
    expect(ok.calls.discarded).toHaveLength(1);
    expect(ok.calls.discarded[0].filePath).toBe('/tmp/interchange.docx');

    const failing = standIns({ convert: async () => Promise.reject(new Error('the writer failed')) });
    await expect(convertThroughInterchange(failing.deps, request(), 'docx')).rejects.toThrow('the writer failed');
    expect(failing.calls.discarded).toHaveLength(1);
    expect(failing.calls.discarded[0].filePath).toBe('/tmp/interchange.docx');
  });

  it('is an unavailable engine when the office suite wrote nothing', async () => {
    const { deps } = standIns({ write: async () => null });
    const failure = await convertThroughInterchange(deps, request(), 'docx').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as Error).message).toBe("Engine 'soffice' is unavailable: LibreOffice produced no .docx file for the .wps source");
  });

  it('answers a document the office suite stops on with the typed refusal, and an unavailable sandbox as it is', async () => {
    const stderr = 'Unspecified Application Error\n\nFatal exception: Signal 6';
    const stopped = standIns({ write: async () => Promise.reject(new SandboxedProcessError(`exit 134: ${stderr}`, 134, stderr, 'SIGABRT')) });
    const refusal = await convertThroughInterchange(stopped.deps, request({ src: 'wps' }), 'docx').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConversionFailedError);
    expect((refusal as Error).message).toMatch(/^LibreOffice stopped while reading the \.wps file/);

    const unavailable = new SandboxUnavailableError('no sandbox on this host');
    const missing = standIns({ write: async () => Promise.reject(unavailable) });
    await expect(convertThroughInterchange(missing.deps, request(), 'docx')).rejects.toBe(unavailable);
  });
});

/** The signature every OLE2 compound file starts with (MS-CFB section 2.2): the container of Word, Excel and PowerPoint 97-2003 files. */
const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** The start of a Word 5.0 for Macintosh file (a Word binary that is not an OLE2 compound file). */
const WORD_5_MACINTOSH_START = Buffer.from([0xfe, 0x37, 0x00, 0x23, 0x00, 0x00, 0x00, 0x00]);
const compoundFile = (): Buffer => Buffer.concat([OLE2_SIGNATURE, Buffer.from('the rest of the compound file')]);

describe('a legacy document the strict reader refused', () => {
  const refusal = new LegacyOfficeFormatError('Word document: the CLX holds an unknown entry type 0x0.');
  const legacy = (overrides: Partial<OfficeSuiteRequest>): OfficeSuiteRequest => request({ input: compoundFile(), ...overrides });

  it('is tried by the office suite, and the answer says why the reader gave it up', async () => {
    const { deps, calls } = standIns();
    const answer = await retryRefusedLegacyDocument(deps, legacy({ src: 'doc', tgt: 'html' }), refusal);
    expect(answer?.fallbackChain).toEqual(['in-process reader refused the document: Word document: the CLX holds an unknown entry type 0x0.']);
    expect(calls.written[0]).toMatchObject({ src: 'doc', target: 'docx' });
    expect(calls.converted[0]).toMatchObject({ src: 'docx', target: 'html' });
  });

  it('keeps the steps already in the fallback chain of the conversion it got', async () => {
    const { deps } = standIns({ convert: async () => result({ fallbackChain: ['native-soffice: unavailable'] }) });
    const answer = await retryRefusedLegacyDocument(deps, legacy({ src: 'doc', tgt: 'html' }), refusal);
    expect(answer?.fallbackChain).toEqual(['native-soffice: unavailable', 'in-process reader refused the document: Word document: the CLX holds an unknown entry type 0x0.']);
  });

  it('is read as text for a text target, so that text outside the body is not lost', async () => {
    const { deps, calls } = standIns({ write: async () => result({ filePath: '/out/x.txt' }) });
    await retryRefusedLegacyDocument(deps, legacy({ src: 'dot', tgt: 'txt' }), refusal);
    expect(calls.written[0]).toMatchObject({ src: 'dot', target: 'txt' });
    expect(calls.converted).toEqual([]);
  });

  it('accepts a corrupt compound file as a refusal too', async () => {
    const { deps, calls } = standIns();
    const answer = await retryRefusedLegacyDocument(deps, legacy({ src: 'xls', tgt: 'csv' }), new CorruptStreamError('Corrupt CFBF container'));
    expect(answer).toBeDefined();
    expect(calls.written[0]).toMatchObject({ src: 'xls', target: 'xlsx' });
  });

  it.each([
    ['a refusal of another kind', legacy({ src: 'doc', tgt: 'html' }), new Error('out of memory')],
    ['a format with no office-suite reader behind it', legacy({ src: 'docx', tgt: 'html' }), refusal],
    ['a request that was cancelled', legacy({ src: 'doc', tgt: 'html', options: { signal: AbortSignal.abort() } }), refusal],
  ])('is not retried for %s', async (_name, retried, error) => {
    const { deps, calls } = standIns();
    expect(await retryRefusedLegacyDocument(deps, retried, error)).toBeUndefined();
    expect(calls.written).toEqual([]);
  });

  it.each([
    ['an HTML page', '<html><body><img src="file:///etc/hostname"></body></html>'],
    ['an RTF document', '{\\rtf1\\ansi A letter.}'],
    ['plain text', 'A letter in plain words.'],
  ])('is not retried for %s under a legacy Office name, and its refusal stands', async (_name, body) => {
    const { deps, calls } = standIns();
    const answer = await retryRefusedLegacyDocument(deps, request({ input: Buffer.from(body), src: 'doc', tgt: 'html', originalFilename: 'letter.doc' }), refusal);
    expect(answer).toBeUndefined();
    expect(calls.written).toEqual([]);
  });

  it('is tried when the file is a Word 5.0 for Macintosh file, a Word binary that is no compound file', async () => {
    const { deps, calls } = standIns();
    const answer = await retryRefusedLegacyDocument(deps, request({ input: WORD_5_MACINTOSH_START, src: 'doc', tgt: 'html' }), refusal);
    expect(answer).toBeDefined();
    expect(calls.written[0]).toMatchObject({ src: 'doc', target: 'docx' });
  });

  it('reads the start of a file that is not in memory and is tried only when it is a compound file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-retry-'));
    try {
      const compound = path.join(dir, 'compound.doc');
      const html = path.join(dir, 'page.doc');
      fs.writeFileSync(compound, compoundFile());
      fs.writeFileSync(html, '<html><body>a page</body></html>');
      const tried = standIns();
      expect(await retryRefusedLegacyDocument(tried.deps, legacy({ input: { inputPath: compound }, src: 'doc', tgt: 'html' }), refusal)).toBeDefined();
      const skipped = standIns();
      expect(await retryRefusedLegacyDocument(skipped.deps, legacy({ input: { inputPath: html }, src: 'doc', tgt: 'html' }), refusal)).toBeUndefined();
      expect(skipped.calls.written).toEqual([]);
      const held = standIns();
      expect(await retryRefusedLegacyDocument(held.deps, legacy({ input: { inputBuffer: compoundFile() }, src: 'doc', tgt: 'html' }), refusal)).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the reader’s own refusal when the office suite cannot read the file either', async () => {
    const { deps } = standIns({ write: async () => Promise.reject(new Error('could not be loaded')) });
    expect(await retryRefusedLegacyDocument(deps, legacy({ src: 'doc', tgt: 'html' }), refusal)).toBeUndefined();
  });

  it('stops with the failure when the request is cancelled while the office suite runs', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    const { deps } = standIns({
      write: async () => {
        controller.abort();
        return Promise.reject(cancelled);
      },
    });
    await expect(retryRefusedLegacyDocument(deps, legacy({ src: 'doc', tgt: 'html', options: { signal: controller.signal } }), refusal)).rejects.toBe(cancelled);
  });
});

describe('which targets the office suite writes in one pass', () => {
  it.each([
    ['wps', 'pdf', true],
    ['wps', 'docx', true],
    ['wps', 'txt', true],
    ['wps', 'html', false],
    ['wps', 'xlsx', false],
    ['numbers', 'xlsx', true],
    ['numbers', 'csv', false],
    ['numbers', 'txt', false],
    ['sxi', 'pptx', true],
    ['sxi', 'docx', false],
    ['sxd', 'pdf', true],
    ['sxd', 'odp', false],
    ['vsd', 'pdf', true],
    ['vsd', 'svg', false],
    ['cdr', 'pdf', true],
    ['cdr', 'png', false],
    ['pub', 'txt', false],
    ['lrf', 'rtf', true],
    ['dot', 'docx', true],
    ['dot', 'txt', false],
    ['dot', 'html', false],
    ['pdf', 'docx', false],
    ['docm', 'odt', true],
    ['xlsm', 'docx', false],
    ['pptm', 'pptx', true],
    ['key', 'pptx', true],
    ['key', 'docx', false],
    ['odg', 'odt', false],
  ])('.%s to .%s: %s', (source, target, writes) => {
    expect(officeSuiteWritesTarget(source, target)).toBe(writes);
  });

  it.each([
    ['wps', 'html', false, 'docx'],
    ['wps', 'html', true, undefined],
    ['wps', 'pdf', false, undefined],
    ['lrf', 'azw3', false, 'txt'],
    ['lrf', 'epub', false, 'docx'],
    ['numbers', 'csv', false, 'xlsx'],
    ['pub', 'html', false, undefined],
    ['vsd', 'svg', true, undefined],
    ['cdr', 'eps', true, undefined],
    ['pdf', 'html', false, undefined],
  ])('.%s to .%s with page target %s goes through %s', (source, target, pageTarget, interchange) => {
    expect(interchangeNeeded(source, target, pageTarget)).toBe(interchange);
  });
});

describe('the answer for a file the office suite cannot read', () => {
  const wroteNothing = new Error('LibreOffice execution completed without producing expected output file for target format "txt"');

  it('is the error itself for a source the office suite does not read', () => {
    expect(asUnreadableDocument(wroteNothing, 'pdf')).toBe(wroteNothing);
  });

  it('leaves a typed error alone even when its words are the suite’s', () => {
    const typed = new ConversionFailedError(wroteNothing.message);
    expect(asUnreadableDocument(typed, 'wps')).toBe(typed);
  });

  it('is the original error when the failure is none of the three the suite makes', () => {
    const other = new SandboxedProcessError('exit 1: something else', 1, 'something else');
    expect(asUnreadableDocument(other, 'wps')).toBe(other);
    expect(asUnreadableDocument('not an error', 'wps')).toBe('not an error');
  });

  it('is not made for a plain Error that is not the suite’s empty output', () => {
    const plain = new Error('Source file could not be loaded');
    expect(asUnreadableDocument(plain, 'wps')).toBe(plain);
  });
});

describe('the export filter of the office suite for each source', () => {
  it.each([
    ['wps', 'writer_pdf_Export'],
    ['lrf', 'writer_pdf_Export'],
    ['sxw', 'writer_pdf_Export'],
    ['dot', 'writer_pdf_Export'],
    ['ott', 'writer_pdf_Export'],
    ['numbers', 'calc_pdf_Export'],
    ['xlt', 'calc_pdf_Export'],
    ['sxi', 'impress_pdf_Export'],
    ['pps', 'impress_pdf_Export'],
    ['otp', 'impress_pdf_Export'],
    ['pub', 'draw_pdf_Export'],
    ['sxd', 'draw_pdf_Export'],
    ['vsd', 'draw_pdf_Export'],
    ['cdr', 'draw_pdf_Export'],
    ['xlsx', 'calc_pdf_Export'],
    ['pptx', 'impress_pdf_Export'],
    ['odg', 'draw_pdf_Export'],
    ['docx', 'writer_pdf_Export'],
    ['dotx', 'writer_pdf_Export'],
    ['xlsm', 'calc_pdf_Export'],
    ['csv', 'calc_pdf_Export'],
    ['ppsx', 'impress_pdf_Export'],
    ['potx', 'impress_pdf_Export'],
    ['key', 'impress_pdf_Export'],
    ['odd', 'draw_pdf_Export'],
    ['txt', 'writer_pdf_Export'],
  ])('.%s is exported to PDF by %s', (source, filter) => {
    expect(resolveLibreOfficeFilter('pdf', source)).toMatch(new RegExp(`^pdf:${filter}:`));
  });

  it('writes plain text as UTF-8 with LF line ends and no byte order mark through the encoded text filter, and every other target under its own name', () => {
    expect(resolveLibreOfficeFilter('txt', 'wps')).toBe('txt:Text (encoded):UTF8,LF,,,false');
    expect(resolveLibreOfficeFilter('docx', 'wps')).toBe('docx');
    expect(resolveLibreOfficeFilter('odd', 'odd')).toBe('otg');
  });
});
