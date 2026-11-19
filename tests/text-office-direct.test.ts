import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import iconv from 'iconv-lite';
import { afterEach, describe, expect, it } from 'vitest';
import { CFBF_MAGIC, startsWithBytes } from '../src/lib/format-signatures';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { executeWorkerConversion } from '../src/worker/engines';
import {
  TEXT_DIRECT_MIN_BYTES,
  TEXT_IMPORT_FILTER,
  convertBridgedTarget,
  type OfficeSuiteRequest,
  type OfficeSuiteRouteDeps,
} from '../src/worker/office-suite-route';
import type { WorkerConversionResult, WorkerEngineOptions, WorkerVfsPayload } from '../src/worker/worker-types';
import { HEARTBEAT_INTERVAL_MS, STALL_TIMEOUT_MS } from '../src/lib/queue/bullmq-engine';
import { oracleTest } from './helpers/oracle-test';

/**
 * A plain text file of 128 KiB or more written as `.doc` or `.rtf` goes to the office suite as it is, read with its text filter. Written
 * as a DOCX first (entries 158 and 283), a text with long runs of lines between blank lines is one paragraph of thousands of line breaks
 * that the suite lays out in time growing faster than the text: 1.2 MB took 46 s, the file read directly 2.2 s. A shorter file keeps the DOCX.
 */

const SCRATCH_PREFIX = 'text-office-direct-';
const STAND_IN_STAGE_TURNS = 20;
const NS_PER_MS = 1e6;
/** The longest hold of the event loop that still lets the next heartbeat of a running job (every HEARTBEAT_INTERVAL_MS) reach Redis before its key expires. */
const MAX_LOOP_HOLD_MS = STALL_TIMEOUT_MS - HEARTBEAT_INTERVAL_MS;
const HISTOGRAM_RESOLUTION_MS = 10;
const REAL_CONVERSION_TIMEOUT_MS = 240_000;
const DOCX_FORMAT = 'docx';
const WORD_TARGET = 'doc';
const RTF_TARGET = 'rtf';

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
  scratchDirs.push(dir);
  return dir;
}

function written(overrides: Partial<WorkerConversionResult> = {}): WorkerConversionResult {
  const buffer = Buffer.from('converted bytes');
  return { buffer, mimeType: 'application/octet-stream', filename: 'out.bin', size: buffer.length, engineUsed: 'native-soffice-pool', executionTimeMs: 1, ...overrides };
}

interface SuiteCall {
  input: Buffer | WorkerVfsPayload;
  src: string;
  target: string;
  options: WorkerEngineOptions;
}

function standIns(suite: () => Promise<WorkerConversionResult | null> = async () => written({ filePath: '/out/text.doc' })): {
  deps: OfficeSuiteRouteDeps;
  suiteCalls: SuiteCall[];
  converted: { src: string; target: string }[];
  discarded: (string | undefined)[];
} {
  const suiteCalls: SuiteCall[] = [];
  const converted: { src: string; target: string }[] = [];
  const discarded: (string | undefined)[] = [];
  const deps: OfficeSuiteRouteDeps = {
    async writeWithOfficeSuite(input, src, target, options) {
      suiteCalls.push({ input, src, target, options });
      return suite();
    },
    async convert(_input, src, target) {
      converted.push({ src, target });
      return written({ buffer: Buffer.from('the package'), filePath: '/tmp/text.docx', engineUsed: 'internal-fallback' });
    },
    discardOutput(filePath) {
      discarded.push(filePath);
    },
  };
  return { deps, suiteCalls, converted, discarded };
}

const SAMPLE_BYTES = 128 * 1024;
const textOf = (bytes: number): Buffer => Buffer.from('a line of plain text\n'.repeat(Math.ceil(Math.max(bytes, 1) / 21)).slice(0, bytes));
const request = (overrides: Partial<OfficeSuiteRequest> = {}): OfficeSuiteRequest => ({
  input: textOf(SAMPLE_BYTES),
  src: 'txt',
  tgt: WORD_TARGET,
  options: {},
  originalFilename: 'notes.txt',
  ...overrides,
});
const neverDirectly = async (): Promise<WorkerConversionResult> => {
  throw new Error('the in-process route must not run');
};

describe('the route of a plain text file written as Word 97-2003 or RTF', () => {
  it.each([WORD_TARGET, RTF_TARGET])('hands a plain text file of any size to the office suite as it is for %s, with the text filter, and writes no DOCX', async (target) => {
    for (const size of [0, 12, 4096, SAMPLE_BYTES - 1, SAMPLE_BYTES]) {
      const { deps, suiteCalls, converted, discarded } = standIns();
      const input = textOf(size);
      const answer = await convertBridgedTarget(deps, request({ input, tgt: target }), neverDirectly);
      expect(answer.filePath).toBe('/out/text.doc');
      expect(converted).toEqual([]);
      expect(discarded).toEqual([]);
      expect(suiteCalls).toHaveLength(1);
      expect(suiteCalls[0].input).toBe(input);
      expect(suiteCalls[0]).toMatchObject({ src: 'txt', target, options: { officeImportFilter: TEXT_IMPORT_FILTER, throwOnUnavailable: true } });
    }
    expect(TEXT_DIRECT_MIN_BYTES).toBe(0);
  });

  it('names the text filter and its UTF-8 option as the load properties of a .txt file in JODConverter', () => {
    expect(TEXT_IMPORT_FILTER).toBe('Text (encoded):utf8');
  });

  it('measures a file on disk by its size, and passes the output path of the request on to the suite', async () => {
    const dir = scratch();
    const inputPath = path.join(dir, 'big.txt');
    fs.writeFileSync(inputPath, textOf(SAMPLE_BYTES));
    const { deps, suiteCalls, converted } = standIns();
    const payload: WorkerVfsPayload = { inputPath, outputPath: path.join(dir, 'out.doc') };
    await convertBridgedTarget(deps, request({ input: payload }), neverDirectly);
    expect(converted).toEqual([]);
    expect(suiteCalls[0].input).toBe(payload);
  });

  const KOREAN_LINES = '대한민국은 민주공화국이다. 대한민국의 주권은 국민에게 있고, 모든 권력은 국민으로부터 나온다.\n'.repeat(8);

  it.each([WORD_TARGET, RTF_TARGET])('writes the DOCX of a CP949 text first for %s, since the text filter reads UTF-8', async (target) => {
    const { deps, suiteCalls, converted } = standIns();
    await convertBridgedTarget(deps, request({ input: iconv.encode(KOREAN_LINES, 'cp949'), tgt: target }), neverDirectly);
    expect(converted).toEqual([{ src: 'txt', target: DOCX_FORMAT }]);
    expect(suiteCalls[0]).toMatchObject({ src: DOCX_FORMAT, target });
    expect(suiteCalls[0].options.officeImportFilter).toBeUndefined();
  });

  it('writes the DOCX of a CP949 text on disk first, and hands UTF-8, UTF-16 and BOM text on disk to the suite as they are', async () => {
    const dir = scratch();
    const files: Array<[string, Buffer, boolean]> = [
      ['cp949.txt', iconv.encode(KOREAN_LINES, 'cp949'), true],
      ['utf8.txt', Buffer.from(KOREAN_LINES), false],
      ['bom.txt', Buffer.from('\uFEFF' + KOREAN_LINES), false],
      ['utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(KOREAN_LINES, 'utf16le')]), false],
    ];
    for (const [name, bytes, legacy] of files) {
      const inputPath = path.join(dir, name);
      fs.writeFileSync(inputPath, bytes);
      const { deps, converted } = standIns();
      await convertBridgedTarget(deps, request({ input: { inputPath, outputPath: path.join(dir, `${name}.doc`) } }), neverDirectly);
      expect(converted, name).toEqual(legacy ? [{ src: 'txt', target: DOCX_FORMAT }] : []);
    }
  });

  it.each(['md', 'rst', 'html', 'htm'])('leaves a long %s source on the DOCX route', async (src) => {
    const { deps, suiteCalls, converted } = standIns();
    await convertBridgedTarget(deps, request({ src, input: textOf(SAMPLE_BYTES * 2) }), neverDirectly);
    expect(converted).toEqual([{ src, target: DOCX_FORMAT }]);
    expect(suiteCalls[0]).toMatchObject({ src: DOCX_FORMAT });
  });

  it('leaves the other targets of a long text file to the converter', async () => {
    const { deps, suiteCalls, converted } = standIns();
    const answer = await convertBridgedTarget(deps, request({ tgt: 'docx' }), async () => written({ engineUsed: 'internal-fallback' }));
    expect(answer.engineUsed).toBe('internal-fallback');
    expect(suiteCalls).toEqual([]);
    expect(converted).toEqual([]);
  });

  it('refuses a binary container behind the name .txt before the suite sees it', async () => {
    const { deps, suiteCalls } = standIns();
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), textOf(SAMPLE_BYTES)]);
    await expect(convertBridgedTarget(deps, request({ input: zip }), neverDirectly)).rejects.toBeInstanceOf(ConversionFailedError);
    expect(suiteCalls).toEqual([]);
  });

  it('refuses a file with a null byte in its first 4 KiB', async () => {
    const { deps, suiteCalls } = standIns();
    const input = textOf(SAMPLE_BYTES);
    input[100] = 0;
    await expect(convertBridgedTarget(deps, request({ input }), neverDirectly)).rejects.toThrow(/Binary null bytes/);
    expect(suiteCalls).toEqual([]);
  });

  it('reads a file with a UTF-16 mark as text and refuses binary data behind that mark', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(textOf(SAMPLE_BYTES).toString('utf8'), 'utf16le')]);
    const accepted = standIns();
    await convertBridgedTarget(accepted.deps, request({ input: utf16 }), neverDirectly);
    expect(accepted.suiteCalls).toHaveLength(1);

    const binary = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(SAMPLE_BYTES)]);
    const refused = standIns();
    await expect(convertBridgedTarget(refused.deps, request({ input: binary }), neverDirectly)).rejects.toThrow(/Binary null bytes/);
    expect(refused.suiteCalls).toEqual([]);
  });

  it('answers an unavailable engine when the suite writes nothing, and passes a failure of the run on', async () => {
    const missing = standIns(async () => null);
    await expect(convertBridgedTarget(missing.deps, request(), neverDirectly)).rejects.toBeInstanceOf(EngineUnavailableError);
    const failing = standIns(async () => {
      throw new ConversionFailedError('the suite stopped');
    });
    await expect(convertBridgedTarget(failing.deps, request(), neverDirectly)).rejects.toThrow('the suite stopped');
  });

  it('holds the event loop for no longer than an idle loop does while it waits for the suite, whatever the size of the text', async () => {
    const dir = scratch();
    const inputPath = path.join(dir, 'four-megabytes.txt');
    fs.writeFileSync(inputPath, textOf(4 * 1024 * 1024));
    const suiteTurns = async (): Promise<WorkerConversionResult> => {
      for (let turn = 0; turn < STAND_IN_STAGE_TURNS; turn++) await new Promise((resolve) => setTimeout(resolve, HISTOGRAM_RESOLUTION_MS));
      return written();
    };
    const { deps } = standIns(suiteTurns);
    const route = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
    route.enable();
    await new Promise((resolve) => setTimeout(resolve, HISTOGRAM_RESOLUTION_MS * 3));
    try {
      await convertBridgedTarget(deps, request({ input: { inputPath } }), neverDirectly);
    } finally {
      route.disable();
    }
    const idle = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
    idle.enable();
    await suiteTurns();
    idle.disable();
    // The route reads 64 KiB of the file and starts the suite: it adds no turn of the loop that an idle wait would not have.
    expect((route.max - idle.max) / NS_PER_MS).toBeLessThan(MAX_LOOP_HOLD_MS);
  });
});

/** Words of a text, in order, as the round trip through the suite preserves them. */
const wordsOf = (text: string): string[] => text.split(/\s+/).filter((word) => word !== '');

/** A text of `lines` lines with no blank line, the shape that is one paragraph when written as a DOCX. */
function runOfLines(lines: number, words = 8): string {
  return Array.from({ length: lines }, (_, index) => `line ${index} of the text ${'word '.repeat(words)}`.trimEnd()).join('\n') + '\n';
}

describe('LibreOffice reads the result', () => {
  oracleTest(
    'a long text file with no blank line is a Word 97-2003 file and an RTF file that read back as its words, in order',
    ['soffice'],
    async () => {
      const text = runOfLines(4000);
      expect(Buffer.byteLength(text)).toBeGreaterThanOrEqual(TEXT_DIRECT_MIN_BYTES);
      const doc = await executeWorkerConversion(Buffer.from(text), 'txt', WORD_TARGET, {}, 'run.txt');
      expect(startsWithBytes(doc.buffer, CFBF_MAGIC)).toBe(true);
      const rtf = await executeWorkerConversion(Buffer.from(text), 'txt', RTF_TARGET, {}, 'run.txt');
      expect(rtf.buffer.subarray(0, 5).toString('latin1')).toBe('{\\rtf');
      for (const result of [doc, rtf]) {
        const back = await executeWorkerConversion(result.buffer, result === doc ? WORD_TARGET : RTF_TARGET, 'txt', {}, `run.${result === doc ? WORD_TARGET : RTF_TARGET}`);
        expect(wordsOf(back.buffer.toString('utf8'))).toEqual(wordsOf(text));
      }
    },
    REAL_CONVERSION_TIMEOUT_MS
  );

  oracleTest(
    'Hangul text, a UTF-8 byte order mark and UTF-16 text keep their letters',
    ['soffice'],
    async () => {
      const hangul = '한글 문서의 첫째 줄입니다\n둘째 줄에는 숫자 12345 도 있습니다\n'.repeat(3000);
      const variants: Record<string, Buffer> = {
        utf8: Buffer.from(hangul),
        utf8Mark: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(hangul)]),
        utf16Little: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(hangul, 'utf16le')]),
      };
      for (const [name, input] of Object.entries(variants)) {
        expect(input.length).toBeGreaterThanOrEqual(TEXT_DIRECT_MIN_BYTES);
        const doc = await executeWorkerConversion(input, 'txt', WORD_TARGET, {}, `${name}.txt`);
        const back = await executeWorkerConversion(doc.buffer, WORD_TARGET, 'txt', {}, `${name}.doc`);
        expect(wordsOf(back.buffer.toString('utf8')), name).toEqual(wordsOf(hangul));
      }
    },
    REAL_CONVERSION_TIMEOUT_MS
  );

  oracleTest(
    'a text of 60,000 lines (4 MB) converts without holding the event loop past the heartbeat of the job',
    ['soffice'],
    async () => {
      const text = runOfLines(60000, 14);
      expect(Buffer.byteLength(text)).toBeGreaterThan(4 * 1000 * 1000);
      const input = Buffer.from(text);
      const route = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
      route.enable();
      await new Promise((resolve) => setTimeout(resolve, HISTOGRAM_RESOLUTION_MS * 3));
      const startedAt = performance.now();
      let result: WorkerConversionResult;
      try {
        result = await executeWorkerConversion(input, 'txt', WORD_TARGET, {}, 'rows.txt');
      } finally {
        route.disable();
      }
      const elapsedMs = performance.now() - startedAt;
      expect(startsWithBytes(result.buffer, CFBF_MAGIC)).toBe(true);
      // The same span spent idle on the same loaded machine is the reference: only work done in this process shows beyond it.
      const idle = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
      idle.enable();
      await new Promise((resolve) => setTimeout(resolve, Math.min(elapsedMs, 20_000)));
      idle.disable();
      expect((route.max - idle.max) / NS_PER_MS).toBeLessThan(MAX_LOOP_HOLD_MS);
    },
    REAL_CONVERSION_TIMEOUT_MS
  );
});
