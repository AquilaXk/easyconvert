import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  asUnreadableDocument,
  convertThroughInterchange,
  convertXlsTarget,
  interchangeNeeded,
  officeSuiteReadsInput,
  officeSuiteWritesTarget,
  retryRefusedLegacyDocument,
  withMetafileFrame,
  withMetafileInk,
  type OfficeSuiteRequest,
  type OfficeSuiteRouteDeps,
} from '../src/worker/office-suite-route';
import { emf, wmf } from './helpers/metafile-headers';
import { SandboxedProcessError } from '../src/lib/security/process-sandbox';
import { CompoundFileStructureError, ConversionFailedError, CorruptStreamError, DataParseError, EngineUnavailableError, PayloadLimitError, SandboxUnavailableError, SheetLimitError } from '../src/lib/types';
import { CFBF_MAX_FILE_BYTES } from '../src/lib/compound-file-kind';
import { writeXlsx } from '../src/lib/conversions/xlsx-writer';
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

  it('is written without the export filter of the request, which names the target and not the interchange format', async () => {
    const { deps, calls } = standIns();
    const options = { libreOfficeFilter: 'writer_pdf_Export' };
    await convertThroughInterchange(deps, request({ options }), 'docx');
    expect(calls.written[0].options.libreOfficeFilter).toBeUndefined();
    expect(options).toEqual({ libreOfficeFilter: 'writer_pdf_Export' });

    const own = standIns({ write: async () => result({ filePath: '/out/letter.pdf', engineUsed: 'native-soffice' }) });
    await convertThroughInterchange(own.deps, request({ tgt: 'pdf', options }), 'pdf');
    expect(own.calls.written[0].options.libreOfficeFilter).toBe('writer_pdf_Export');
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
    ['a destroyed directory or mini FAT, which the suite would write as text', legacy({ src: 'xls', tgt: 'csv' }), new CompoundFileStructureError('Corrupt CFBF container: the sector chain starting at sector 4078 reaches sector 1419968535, which the file does not hold.')],
    ['a destroyed structure that a reader reports with its label', legacy({ src: 'ppt', tgt: 'pdf' }), new LegacyOfficeFormatError('PowerPoint presentation: the compound file is malformed (Corrupt CFBF container: its directory holds no entry.).', { cause: new CompoundFileStructureError('Corrupt CFBF container: its directory holds no entry.') })],
  ])('is not retried for %s', async (_name, retried, error) => {
    const { deps, calls } = standIns();
    expect(await retryRefusedLegacyDocument(deps, retried, error)).toBeUndefined();
    expect(calls.written).toEqual([]);
  });

  describe('whose destroyed structure a reader wrapped in other errors', () => {
    const MAX_CAUSE_DEPTH = 8;
    const destroyed = (): CompoundFileStructureError => new CompoundFileStructureError('Corrupt CFBF container: its directory holds no entry.');
    /** The structure error under `wrappers` readers' errors, each the `cause` of the one above. */
    const underWrappers = (wrappers: number): Error => {
      let error: Error = destroyed();
      for (let level = 0; level < wrappers; level++) error = new LegacyOfficeFormatError(`wrapper ${level}`, { cause: error });
      return error;
    };

    it.each([1, 2, MAX_CAUSE_DEPTH])('is not retried when %i wrappers stand over it', async (wrappers) => {
      const { deps, calls } = standIns();
      expect(await retryRefusedLegacyDocument(deps, legacy({ src: 'ppt', tgt: 'pdf' }), underWrappers(wrappers))).toBeUndefined();
      expect(calls.written).toEqual([]);
    });

    it('is retried when the structure error lies deeper than the readers add, so that a chain of causes is read to a bound', async () => {
      const { deps, calls } = standIns();
      const answer = await retryRefusedLegacyDocument(deps, legacy({ src: 'ppt', tgt: 'pdf' }), underWrappers(MAX_CAUSE_DEPTH + 1));
      expect(answer).toBeDefined();
      expect(calls.written[0]).toMatchObject({ src: 'ppt' });
    });

    it('ends on a chain of causes that returns to an error it has seen, and retries a refusal that holds no destroyed structure', async () => {
      const first = new LegacyOfficeFormatError('PowerPoint presentation: the compound file is malformed.');
      const second = new CorruptStreamError('Corrupt CFBF container: a stream returns to its first sector.');
      first.cause = second;
      second.cause = first;
      const { deps, calls } = standIns();
      expect(await retryRefusedLegacyDocument(deps, legacy({ src: 'ppt', tgt: 'pdf' }), first)).toBeDefined();
      expect(calls.written[0]).toMatchObject({ src: 'ppt' });
    });
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
    ['emf', 'pdf', true],
    ['emf', 'wmf', false],
    ['cgm', 'pdf', true],
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
    ['lrf', 'xps', false, 'txt'],
    ['lrf', 'epub', false, 'docx'],
    ['numbers', 'csv', false, 'xlsx'],
    ['pub', 'html', false, undefined],
    ['vsd', 'svg', true, undefined],
    ['cdr', 'eps', true, undefined],
    ['emf', 'jpg', true, undefined],
    ['cgm', 'wmf', true, undefined],
    ['pdf', 'html', false, undefined],
  ])('.%s to .%s with page target %s goes through %s', (source, target, pageTarget, interchange) => {
    expect(interchangeNeeded(source, target, pageTarget)).toBe(interchange);
  });
});

describe('which inputs the office suite reads', () => {
  const BINARY_CGM = Buffer.from([0x00, 0x34, 0x13, 0x43, 0x49, 0x52, 0x43, 0x4c, 0x45]);

  it.each([
    ['vsd', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), true],
    ['emf', Buffer.alloc(88), true],
    ['docx', Buffer.from('PK'), true],
    ['pdf', Buffer.from('%PDF-1.7'), false],
    ['cgm', BINARY_CGM, true],
    ['cgm', Buffer.from('BEGMF "drawing";\n'), false],
    ['cgm', Buffer.from('\n  begmf "drawing";\n'), false],
    ['cgm', Buffer.from('BEGMFX is no command'), true],
  ])('.%s that starts %j: %s', (source, head, reads) => {
    expect(officeSuiteReadsInput(source, head)).toBe(reads);
  });

  it('reads the start of a file that is not in memory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-reads-'));
    try {
      const clearText = path.join(dir, 'clear.cgm');
      const binary = path.join(dir, 'binary.cgm');
      fs.writeFileSync(clearText, 'BEGMF "drawing";\nENDMF;\n');
      fs.writeFileSync(binary, BINARY_CGM);
      expect(officeSuiteReadsInput('cgm', { inputPath: clearText })).toBe(false);
      expect(officeSuiteReadsInput('cgm', { inputPath: binary })).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    ['emf', 'draw_pdf_Export'],
    ['wmf', 'draw_pdf_Export'],
    ['cgm', 'impress_pdf_Export'],
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

describe('the page a metafile is drawn on by the office suite', () => {
  type Run = Parameters<typeof withMetafileFrame>[0];
  interface RunCall {
    input: Buffer | WorkerVfsPayload;
    src: string;
    target: string;
    options?: WorkerEngineOptions;
    originalFilename?: string;
  }

  function recordingRun(calls: RunCall[], answer: WorkerConversionResult | null = result({ mimeType: 'application/pdf' })): Run {
    return async (input, src, target, options, originalFilename) => {
      calls.push({ input, src, target, options, originalFilename });
      return answer;
    };
  }

  const THIRTY_BY_TWENTY_MM = emf({ frame: [0, 0, 2999, 1999] });
  const POINTS_PER_MM = 72 / 25.4;

  async function stagedDrawing(staged: Buffer | WorkerVfsPayload): Promise<{ zip: JSZip; styles: string; content: string }> {
    const bytes = Buffer.isBuffer(staged) ? staged : staged.inputBuffer!;
    const zip = await JSZip.loadAsync(bytes);
    return { zip, styles: await zip.file('styles.xml')!.async('string'), content: await zip.file('content.xml')!.async('string') };
  }

  function lengthInPoints(xml: string, attribute: string): number {
    const match = new RegExp(`${attribute}="(-?[0-9.]+)pt"`).exec(xml);
    expect(match, attribute).not.toBeNull();
    return Number(match![1]);
  }

  it('is the frame of the EMF header: the office suite opens a drawing of that page that holds the file as it is', async () => {
    const calls: RunCall[] = [];
    const options = { timeoutMs: 5000 } as WorkerEngineOptions;
    const answer = await withMetafileFrame(recordingRun(calls))(THIRTY_BY_TWENTY_MM, 'emf', 'pdf', options, 'logo.emf');
    expect(answer).toMatchObject({ mimeType: 'application/pdf' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ src: 'odg', target: 'pdf', options, originalFilename: 'logo.emf' });
    const { zip, styles, content } = await stagedDrawing(calls[0].input);
    expect(lengthInPoints(styles, 'fo:page-width')).toBeCloseTo(30 * POINTS_PER_MM, 2);
    expect(lengthInPoints(styles, 'fo:page-height')).toBeCloseTo(20 * POINTS_PER_MM, 2);
    expect(styles).toMatch(/fo:margin-top="0pt"[^>]*fo:margin-bottom="0pt"[^>]*fo:margin-left="0pt"[^>]*fo:margin-right="0pt"/);
    expect(lengthInPoints(content, 'svg:width')).toBeCloseTo(30 * POINTS_PER_MM, 2);
    expect(lengthInPoints(content, 'svg:height')).toBeCloseTo(20 * POINTS_PER_MM, 2);
    expect(lengthInPoints(content, 'svg:x')).toBe(0);
    expect(lengthInPoints(content, 'svg:y')).toBe(0);
    const pictures = Object.keys(zip.files).filter((name) => name.startsWith('Pictures/') && !zip.files[name].dir);
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toMatch(/\.emf$/);
    expect(await zip.file(pictures[0])!.async('nodebuffer')).toEqual(THIRTY_BY_TWENTY_MM);
    expect(content).toContain(pictures[0]);
  });

  it('is the box of the WMF header over its unit', async () => {
    const calls: RunCall[] = [];
    const metafile = wmf({ placeable: { box: [0, 0, 1439, 719], inch: 1440 } });
    await withMetafileFrame(recordingRun(calls))(metafile, 'wmf', 'pdf', {}, 'plan.wmf');
    const { zip, styles } = await stagedDrawing(calls[0].input);
    expect(lengthInPoints(styles, 'fo:page-width')).toBeCloseTo(72, 2);
    expect(lengthInPoints(styles, 'fo:page-height')).toBeCloseTo(36, 2);
    expect(Object.keys(zip.files).some((name) => /^Pictures\/[^/]+\.wmf$/.test(name))).toBe(true);
  });

  it('is written as an OpenDocument package, whose first entry is the stored media type', async () => {
    const calls: RunCall[] = [];
    await withMetafileFrame(recordingRun(calls))(THIRTY_BY_TWENTY_MM, 'emf', 'pdf', {}, 'logo.emf');
    const bytes = calls[0].input as Buffer;
    expect(bytes.subarray(30, 38).toString('latin1')).toBe('mimetype');
    expect(bytes.subarray(38, 38 + 'application/vnd.oasis.opendocument.graphics'.length).toString('latin1')).toBe('application/vnd.oasis.opendocument.graphics');
    const { zip } = await stagedDrawing(bytes);
    const manifest = await zip.file('META-INF/manifest.xml')!.async('string');
    for (const part of ['content.xml', 'styles.xml']) expect(manifest).toContain(`manifest:full-path="${part}"`);
  });

  it('keeps the output path of a file that is not in memory, and reads the header from the file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metafile-frame-'));
    try {
      const inputPath = path.join(dir, 'logo.emf');
      fs.writeFileSync(inputPath, THIRTY_BY_TWENTY_MM);
      const calls: RunCall[] = [];
      await withMetafileFrame(recordingRun(calls))({ inputPath, outputPath: '/out/logo.pdf' }, 'emf', 'pdf', {}, 'logo.emf');
      expect(calls[0].src).toBe('odg');
      const staged = calls[0].input as WorkerVfsPayload;
      expect(staged.outputPath).toBe('/out/logo.pdf');
      expect(staged.inputPath).toBeUndefined();
      expect(lengthInPoints((await stagedDrawing(staged)).styles, 'fo:page-width')).toBeCloseTo(30 * POINTS_PER_MM, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores the picture part and deflates the XML parts, so a large metafile is not compressed in JavaScript', async () => {
    const calls: RunCall[] = [];
    await withMetafileFrame(recordingRun(calls))(THIRTY_BY_TWENTY_MM, 'emf', 'pdf', {}, 'logo.emf');
    const bytes = calls[0].input as Buffer;
    const LOCAL_HEADER_BYTES = 30;
    const METHOD_OFFSET = 8;
    const method = (name: string): number => bytes.readUInt16LE(bytes.indexOf(name, 0, 'latin1') - LOCAL_HEADER_BYTES + METHOD_OFFSET);
    const STORED = 0;
    const DEFLATED = 8;
    expect({ picture: method('Pictures/metafile.emf'), content: method('content.xml') }).toEqual({ picture: STORED, content: DEFLATED });
  });

  it('stops before and after it builds the package when the request is cancelled, and never runs the office suite then', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const before: RunCall[] = [];
    await expect(withMetafileFrame(recordingRun(before))(THIRTY_BY_TWENTY_MM, 'emf', 'pdf', { signal: aborted.signal }, 'logo.emf')).rejects.toBe(aborted.signal.reason);
    expect(before).toHaveLength(0);

    let checks = 0;
    const cancelledWhileBuilding = {
      throwIfAborted: () => {
        if (++checks === 2) throw new Error('cancelled while the package was built');
      },
    } as unknown as AbortSignal;
    const after: RunCall[] = [];
    await expect(withMetafileFrame(recordingRun(after))(THIRTY_BY_TWENTY_MM, 'emf', 'pdf', { signal: cancelledWhileBuilding }, 'logo.emf')).rejects.toThrow('cancelled while the package was built');
    expect({ checks, runs: after.length }).toEqual({ checks: 2, runs: 0 });
  });

  it('reads no more of a file on disk than the header takes to find its page, and the whole file only once it has one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metafile-frame-'));
    const readWhole = vi.spyOn(fs, 'readFileSync');
    try {
      const notAMetafile = path.join(dir, 'large.emf');
      fs.writeFileSync(notAMetafile, Buffer.alloc(3 * 1024 * 1024, 0x41));
      const metafile = path.join(dir, 'logo.emf');
      fs.writeFileSync(metafile, THIRTY_BY_TWENTY_MM);
      const calls: RunCall[] = [];
      await withMetafileFrame(recordingRun(calls))({ inputPath: notAMetafile, outputPath: '/out/large.pdf' }, 'emf', 'pdf', {}, 'large.emf');
      expect(readWhole.mock.calls.filter(([file]) => file === notAMetafile)).toHaveLength(0);
      expect(calls[0]).toMatchObject({ src: 'emf', input: { inputPath: notAMetafile } });
      await withMetafileFrame(recordingRun(calls))({ inputPath: metafile, outputPath: '/out/logo.pdf' }, 'emf', 'pdf', {}, 'logo.emf');
      expect(readWhole.mock.calls.filter(([file]) => file === metafile)).toHaveLength(1);
      expect(calls[1].src).toBe('odg');
    } finally {
      readWhole.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves everything the frame does not decide to the office suite: other sources, other targets, and a header with no usable frame', async () => {
    const unusable = emf({ frame: [0, 0, 2147483647, 2147483647] });
    const cases: Array<[Buffer, string, string]> = [
      [THIRTY_BY_TWENTY_MM, 'emf', 'odg'],
      [THIRTY_BY_TWENTY_MM, 'cgm', 'pdf'],
      [Buffer.from('PK plain document'), 'docx', 'pdf'],
      [unusable, 'emf', 'pdf'],
      [Buffer.from('not a metafile, only text'), 'wmf', 'pdf'],
    ];
    for (const [input, src, target] of cases) {
      const calls: RunCall[] = [];
      await withMetafileFrame(recordingRun(calls))(input, src, target, {}, `file.${src}`);
      expect({ src: calls[0].src, target: calls[0].target, sameInput: calls[0].input === input }).toEqual({ src, target, sameInput: true });
    }
  });

  it('answers what the office suite answers: no output, and its failure', async () => {
    expect(await withMetafileFrame(recordingRun([], null))(THIRTY_BY_TWENTY_MM, 'emf', 'pdf', {}, 'logo.emf')).toBeNull();
    const failing: Run = async () => {
      throw new SandboxedProcessError('exit 1: source file could not be loaded', 1, 'source file could not be loaded');
    };
    await expect(withMetafileFrame(failing)(THIRTY_BY_TWENTY_MM, 'emf', 'pdf', {}, 'logo.emf')).rejects.toThrow('source file could not be loaded');
  });
});

describe('a metafile that the office suite draws as a blank page', () => {
  type Run = Parameters<typeof withMetafileInk>[0];
  const PDF = result({ mimeType: 'application/pdf', filePath: '/tmp/drawn-metafile.pdf' });
  const PDFTOPPM = '/usr/bin/pdftoppm';

  function setUp(drawn: boolean | Error, answer: WorkerConversionResult | null = PDF, pdftoppm: string | null = PDFTOPPM) {
    const probed: Array<{ pdf: WorkerConversionResult; pdftoppm: string }> = [];
    const discarded: Array<string | undefined> = [];
    const run: Run = async () => answer;
    const wrapped = withMetafileInk(
      run,
      () => pdftoppm,
      (filePath) => void discarded.push(filePath),
      async (pdf, program) => {
        probed.push({ pdf, pdftoppm: program });
        if (drawn instanceof Error) throw drawn;
        return drawn;
      }
    );
    return { wrapped, probed, discarded };
  }

  it.each(['emf', 'wmf'])('refuses a .%s file whose PDF has no ink with a typed error and leaves no output behind', async (src) => {
    const { wrapped, probed, discarded } = setUp(false);
    const refusal = wrapped(Buffer.from('metafile'), src, 'pdf', {}, `junk.${src}`);
    await expect(refusal).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(refusal).rejects.toThrow(new RegExp(`The \\.${src} file draws nothing`));
    expect(probed).toEqual([{ pdf: PDF, pdftoppm: PDFTOPPM }]);
    expect(discarded).toEqual([PDF.filePath]);
  });

  it.each([
    ['emf', emf({ frame: [0, 0, 2999, 1999] })],
    ['wmf', wmf({})],
  ] as const)('hands on the PDF of a .%s file that is a header and its end record without a look, as the reference writes an empty page for it', async (src, bytes) => {
    const { wrapped, probed, discarded } = setUp(false);
    expect(await wrapped(bytes, src, 'pdf', {}, `empty.${src}`)).toBe(PDF);
    expect(await wrapped({ inputBuffer: bytes, outputPath: '/tmp/out.pdf' }, src, 'pdf', {}, `empty.${src}`)).toBe(PDF);
    expect(probed).toEqual([]);
    expect(discarded).toEqual([]);
  });

  it('hands on the PDF of an empty .emf file held on disk, and refuses a file of the same header with junk after it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-empty-'));
    try {
      const empty = emf({ frame: [0, 0, 2999, 1999] });
      const emptyPath = path.join(dir, 'empty.emf');
      const junkPath = path.join(dir, 'junk.emf');
      fs.writeFileSync(emptyPath, empty);
      fs.writeFileSync(junkPath, Buffer.concat([empty.subarray(0, 88), Buffer.alloc(40, 0x5a)]));
      const kept = setUp(false);
      expect(await kept.wrapped({ inputPath: emptyPath, outputPath: '/tmp/out.pdf' }, 'emf', 'pdf', {}, 'empty.emf')).toBe(PDF);
      expect(kept.probed).toEqual([]);
      const refused = setUp(false);
      await expect(refused.wrapped({ inputPath: junkPath, outputPath: '/tmp/out.pdf' }, 'emf', 'pdf', {}, 'junk.emf')).rejects.toBeInstanceOf(ConversionFailedError);
      expect(refused.probed).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hands on the PDF of a metafile that draws something, unchanged', async () => {
    const { wrapped, discarded } = setUp(true);
    expect(await wrapped(Buffer.from('metafile'), 'emf', 'pdf', {}, 'logo.emf')).toBe(PDF);
    expect(discarded).toEqual([]);
  });

  it('looks at nothing else: other sources, other targets and a run that wrote no output', async () => {
    for (const [src, target] of [['docx', 'pdf'], ['cgm', 'pdf'], ['emf', 'odg'], ['wmf', 'png']] as const) {
      const { wrapped, probed } = setUp(false);
      expect(await wrapped(Buffer.from('x'), src, target, {}, `file.${src}`)).toBe(PDF);
      expect(probed).toEqual([]);
    }
    const none = setUp(false, null);
    expect(await none.wrapped(Buffer.from('x'), 'emf', 'pdf', {}, 'logo.emf')).toBeNull();
    expect(none.probed).toEqual([]);
  });

  it('does not take a PDF it could not look at for a PDF with ink: the failure of the look stands and the output is discarded', async () => {
    const { wrapped, discarded } = setUp(new SandboxedProcessError('exit 1: Syntax Error', 1, 'Syntax Error'));
    await expect(wrapped(Buffer.from('x'), 'emf', 'pdf', {}, 'logo.emf')).rejects.toBeInstanceOf(SandboxedProcessError);
    expect(discarded).toEqual([PDF.filePath]);
  });

  it('answers an unavailable engine, naming pdftoppm, when the worker has none, and looks at nothing', async () => {
    const { wrapped, probed, discarded } = setUp(true, PDF, null);
    const refusal = wrapped(Buffer.from('x'), 'emf', 'pdf', {}, 'logo.emf');
    await expect(refusal).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(refusal).rejects.toMatchObject({ engineName: 'pdftoppm' });
    expect(probed).toEqual([]);
    expect(discarded).toEqual([PDF.filePath]);
  });
});

describe('an .xls written from a table the in-process engine reads', () => {
  const exported = (): WorkerConversionResult => result({ buffer: Buffer.from('BIFF8 file'), filePath: '/out/table.xls', engineUsed: 'native-soffice-pool' });
  const unused = (): Promise<WorkerConversionResult> => Promise.reject(new Error('this conversion must not run'));
  const csvRequest = (overrides: Partial<OfficeSuiteRequest> = {}): OfficeSuiteRequest =>
    request({ src: 'csv', tgt: 'xls', originalFilename: 'table.csv', input: Buffer.from('a,b\n1,2\n'), ...overrides });

  it('has the engine write an XLSX workbook of the table and the office suite export it as .xls', async () => {
    const { deps, calls } = standIns({ write: async () => exported() });
    const answer = await convertXlsTarget(deps, csvRequest(), unused);
    expect(answer.filePath).toBe('/out/table.xls');
    expect(calls.converted).toEqual([]);
    expect(calls.written).toHaveLength(1);
    expect(calls.written[0]).toMatchObject({ src: 'xlsx', target: 'xls', originalFilename: 'table.csv' });
    expect(calls.written[0].options).toMatchObject({ throwOnUnavailable: true });
    const handed = await JSZip.loadAsync(calls.written[0].input as Buffer);
    expect(await handed.file('xl/worksheets/sheet1.xml')!.async('text')).toContain('<c r="A2"><v>1</v></c>');
  });

  it('keeps the workbook off the output path of the request, which only the export writes', async () => {
    const { deps, calls } = standIns({ write: async () => exported() });
    const input: WorkerVfsPayload = { inputBuffer: Buffer.from('a,b\n1,2\n'), outputPath: '/out/table.xls' };
    await convertXlsTarget(deps, csvRequest({ input }), unused);
    expect((calls.written[0].input as WorkerVfsPayload).outputPath).toBe('/out/table.xls');
    expect(Buffer.isBuffer((calls.written[0].input as WorkerVfsPayload).inputBuffer)).toBe(true);
  });

  it('answers an unavailable engine when the office suite wrote nothing, and an unavailable sandbox as it is', async () => {
    const none = standIns({ write: async () => null });
    const failure = await convertXlsTarget(none.deps, csvRequest(), unused).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as Error).message).toBe("Engine 'soffice' is unavailable: LibreOffice produced no .xls file for the .csv source");

    const unavailable = new SandboxUnavailableError('no sandbox on this host');
    const missing = standIns({ write: async () => Promise.reject(unavailable) });
    await expect(convertXlsTarget(missing.deps, csvRequest(), unused)).rejects.toBe(unavailable);
  });

  it('refuses a table the engine could not read before the office suite starts', async () => {
    const { deps, calls } = standIns();
    await expect(convertXlsTarget(deps, csvRequest({ input: Buffer.from('a,b\n1,"two\n') }), unused)).rejects.toBeInstanceOf(DataParseError);
    expect(calls.written).toEqual([]);
  });

  it.each([
    ['more than 65,536 rows', 65_537, 1, /rows/],
    ['more than 256 columns', 2, 257, /columns/],
  ])('refuses a table of %s with a 413 before the office suite can cut it', async (_name, rows, width, message) => {
    const { deps, calls } = standIns({ write: async () => exported() });
    const table = Buffer.from(`${Array.from({ length: rows }, () => Array.from({ length: width }, () => 'x').join(',')).join('\n')}\n`);
    const failure = await convertXlsTarget(deps, csvRequest({ input: table }), unused).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as SheetLimitError).status).toBe(413);
    expect((failure as Error).message).toMatch(message);
    expect(calls.written).toEqual([]);
  });

  it('hands a table that reaches row 65,536 and column 256 to the office suite', async () => {
    const table = Buffer.from(`${Array.from({ length: 256 }, () => 'x').join(',')}\n${'x\n'.repeat(65_535)}`);
    const { deps, calls } = standIns({ write: async () => exported() });
    await convertXlsTarget(deps, csvRequest({ input: table }), unused);
    expect(calls.written).toHaveLength(1);
  });
});

describe('the conversion of a request that targets .xls', () => {
  const unused = (): Promise<WorkerConversionResult> => Promise.reject(new Error('this conversion must not run'));

  it('checks a workbook the office suite reads against the BIFF8 sheet, and converts it directly when it fits', async () => {
    const { deps, calls } = standIns();
    const direct = result({ filePath: '/out/book.xls' });
    for (const src of ['xlsx', 'xlsm']) {
      expect(await convertXlsTarget(deps, request({ src, tgt: 'xls', input: await realWorkbookBytes(10, 3) }), async () => direct)).toBe(direct);
      await expect(convertXlsTarget(deps, request({ src, tgt: 'xls', input: await realWorkbookBytes(65_537, 1) }), unused)).rejects.toBeInstanceOf(SheetLimitError);
    }
    expect(calls.converted).toEqual([]);
  });

  it('has the office suite write an ODS or Numbers source as XLSX first, and checks that workbook before the export', async () => {
    for (const src of ['ods', 'numbers']) {
      const wide = standIns({ write: async () => result({ buffer: await realWorkbookBytes(2, 257), filePath: '/tmp/suite.xlsx' }) });
      const failure = await convertXlsTarget(wide.deps, request({ src, tgt: 'xls', input: Buffer.from('source') }), unused).catch((error: unknown) => error);
      expect(failure, src).toBeInstanceOf(SheetLimitError);
      expect(wide.calls.written.map((call) => `${call.src}->${call.target}`)).toEqual([`${src}->xlsx`]);
      expect(wide.calls.discarded.map((call) => call.filePath)).toEqual(['/tmp/suite.xlsx']);

      let runs = 0;
      const fits = standIns({ write: async () => (++runs === 1 ? result({ buffer: await realWorkbookBytes(3, 3), filePath: '/tmp/suite.xlsx' }) : result({ filePath: '/out/book.xls' })) });
      const answer = await convertXlsTarget(fits.deps, request({ src, tgt: 'xls', input: Buffer.from('source') }), unused);
      expect(answer.filePath).toBe('/out/book.xls');
      expect(fits.calls.written.map((call) => `${call.src}->${call.target}`)).toEqual([`${src}->xlsx`, 'xlsx->xls']);
    }
  });

  it('keeps a libreOfficeFilter off the XLSX pass of an ODS or Numbers source and on the .xls export', async () => {
    for (const src of ['ods', 'numbers']) {
      let runs = 0;
      const { deps, calls } = standIns({ write: async () => (++runs === 1 ? result({ buffer: await realWorkbookBytes(3, 3), filePath: '/tmp/suite.xlsx' }) : result({ filePath: '/out/book.xls' })) });
      const options = { libreOfficeFilter: 'MS Excel 97' };
      await convertXlsTarget(deps, request({ src, tgt: 'xls', input: Buffer.from('source'), options }), unused);
      expect(calls.written.map((call) => `${call.src}->${call.target}`)).toEqual([`${src}->xlsx`, 'xlsx->xls']);
      expect(calls.written[0].options.libreOfficeFilter, `${src} to xlsx`).toBeUndefined();
      expect(calls.written[1].options.libreOfficeFilter, 'xlsx to xls').toBe('MS Excel 97');
      expect(options).toEqual({ libreOfficeFilter: 'MS Excel 97' });
    }
  });

  it('leaves a request for any other target to the direct conversion', async () => {
    const { deps, calls } = standIns();
    const direct = result({ filePath: '/out/table.xlsx' });
    expect(await convertXlsTarget(deps, request({ src: 'csv', tgt: 'xlsx' }), async () => direct)).toBe(direct);
    expect(calls.converted).toEqual([]);
    expect(calls.written).toEqual([]);
  });
});

describe('the extent of an OOXML workbook the office suite exports as .xls', () => {
  const unused = (): Promise<WorkerConversionResult> => Promise.reject(new Error('this conversion must not run'));
  const xlsxRequest = (input: Buffer | WorkerVfsPayload): OfficeSuiteRequest => request({ src: 'xlsx', tgt: 'xls', input, originalFilename: 'book.xlsx' });

  async function withDimension(xlsx: Buffer, dimension: string): Promise<Buffer> {
    const zip = await JSZip.loadAsync(xlsx);
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
    zip.file('xl/worksheets/sheet1.xml', sheet.replace(/<dimension [^>]*\/>/, dimension));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  async function expectSheetLimit(input: Buffer | WorkerVfsPayload): Promise<void> {
    const { deps, calls } = standIns();
    const failure = await convertXlsTarget(deps, xlsxRequest(input), unused).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as PayloadLimitError).status).toBe(413);
    expect(calls.written).toEqual([]);
  }

  it('is read from the cells when the worksheet declares no dimension', async () => {
    await expectSheetLimit(await withDimension(await realWorkbookBytes(2, 257), ''));
  });

  it('is read from the cells when the declared dimension is smaller than they are', async () => {
    await expectSheetLimit(await withDimension(await realWorkbookBytes(65_537, 1), '<dimension ref="A1:A2"/>'));
    await expectSheetLimit(await withDimension(await realWorkbookBytes(2, 257), '<dimension ref="A1:B2"/>'));
  });

  async function withSheetAt(xlsx: Buffer, part: string, listed: boolean): Promise<Buffer> {
    const zip = await JSZip.loadAsync(xlsx);
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
    zip.remove('xl/worksheets/sheet1.xml');
    zip.file(part, sheet);
    zip.file('xl/_rels/workbook.xml.rels', (await zip.file('xl/_rels/workbook.xml.rels')!.async('text')).replace('worksheets/sheet1.xml', part.replace(/^xl\//, '')));
    const types = await zip.file('[Content_Types].xml')!.async('text');
    zip.file('[Content_Types].xml', listed ? types.replace('/xl/worksheets/sheet1.xml', `/${part}`) : types.replace(/<Override PartName="\/xl\/worksheets\/sheet1.xml"[^>]*\/>/, ''));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  it('is read from the sheet the workbook names, at a part no content type lists and outside xl/worksheets', async () => {
    await expectSheetLimit(await withSheetAt(await realWorkbookBytes(65_537, 1), 'xl/sheets/data.xml', false));
  });

  it('fits a workbook whose short sheet sits at such a part', async () => {
    const { deps } = standIns();
    const direct = result({ filePath: '/out/book.xls' });
    const input = await withSheetAt(await realWorkbookBytes(3, 3), 'xl/sheets/data.xml', false);
    expect(await convertXlsTarget(deps, xlsxRequest(input), async () => direct)).toBe(direct);
  });

  it('counts a tall worksheet part that nothing references, which no producer writes: a 413 on the safe side', async () => {
    const tall = await JSZip.loadAsync(await realWorkbookBytes(65_537, 1));
    const sheet = await tall.file('xl/worksheets/sheet1.xml')!.async('text');
    const orphans: Array<[string, boolean]> = [['xl/worksheets/orphan.xml', false], ['xl/orphans/typed.xml', true]];
    for (const [part, typed] of orphans) {
      const book = await JSZip.loadAsync(await realWorkbookBytes(3, 3));
      book.file(part, sheet);
      if (typed) {
        const types = await book.file('[Content_Types].xml')!.async('text');
        book.file('[Content_Types].xml', types.replace('</Types>', `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`));
      }
      await expectSheetLimit(await book.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    }
  });

  async function withoutWorksheets(): Promise<Buffer> {
    const zip = await JSZip.loadAsync(await realWorkbookBytes(3, 3));
    zip.remove('xl/worksheets/sheet1.xml');
    zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml')!.async('text')).replace(/<sheet [^>]*\/>/, ''));
    zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('text')).replace(/<Override PartName="\/xl\/worksheets\/sheet1.xml"[^>]*\/>/, ''));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  it.each([
    ['a package that holds the names of an XLSX and no sheet', async () => fs.readFileSync(path.join(__dirname, 'fixtures/zip-packages/xlsx-names-only.xlsx'))],
    ['a workbook whose sheet list and sheet part are gone', withoutWorksheets],
  ])('refuses %s as the reader does, instead of passing it to the export', async (_name, build) => {
    const { deps, calls } = standIns();
    const failure = await convertXlsTarget(deps, xlsxRequest(await build()), unused).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toBe('Invalid XLSX workbook: no worksheets found in archive.');
    expect(calls.written).toEqual([]);
  });

  it('refuses a source that is not a ZIP package instead of passing it on unchecked', async () => {
    const { deps } = standIns();
    const failure = await convertXlsTarget(deps, xlsxRequest(Buffer.from('not a zip')), unused).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).not.toBe('this conversion must not run');
  });

  it('refuses a source file too large to read for the check instead of passing it on unchecked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xls-bound-'));
    try {
      const inputPath = path.join(dir, 'huge.xlsx');
      fs.writeFileSync(inputPath, '');
      fs.truncateSync(inputPath, CFBF_MAX_FILE_BYTES + 1);
      await expectSheetLimit({ inputPath, outputPath: path.join(dir, 'huge.xls') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function realWorkbookBytes(rowCount: number, width: number): Promise<Buffer> {
  return writeXlsx(Array.from({ length: rowCount }, () => Array.from({ length: width }, () => 'x')), 'verbatim');
}
