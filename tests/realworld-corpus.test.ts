import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { inflateEntry, localHeaderLength, locateCentralDirectory, parseCentralDirectory, ZipRangeError } from '../bench/realworld/zip-range';
import { ManifestError, parseManifest, type CorpusFile, type CorpusManifest } from '../bench/realworld/manifest';
import { planJobs, shardJobs } from '../bench/realworld/plan';
import { answeredStatus, isTypedRefusal } from '../bench/realworld/verdict';
import { evaluate, mergeShards, pairStats, readKnownFailures, renderMarkdown, REPORT_SCHEMA, type JobRecord, type ShardReport } from '../bench/realworld/report';
import { ocrPageCount } from '../bench/realworld/ocr-path';
import { outputProblem } from '../bench/realworld/output-check';
import { JobPool, MAX_JOB_DEADLINE_MS, NIGHTLY_WORKERS, scaledDeadlineMs, TOLERATED_HUNG_JOBS } from '../bench/realworld/pool';
import { OCR_PAGE_BUDGET_MS } from '../src/lib/conversions/ocr-work-budget';
import { captureError } from './helpers/capture-error';
import { oracleTest } from './helpers/oracle-test';
import { authorWithReferenceSuite } from './helpers/office-pair-fixtures';

/**
 * The real-world corpus runner (bench/realworld): range reads out of ZIP archives, manifest validation, the job plan
 * and sharding, verdicts, the gate, and the isolated job pool. ZIP archives come from JSZip, an independent writer, so
 * the reader is checked against bytes it did not produce.
 */

const SHA = 'a'.repeat(64);
const PAYLOAD_TEXT = 'real-world corpus payload '.repeat(200);
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const HANG_DEADLINE_MS = 1;
const JOB_DEADLINE_MS = 120_000;
const POOL_TEST_TIMEOUT_MS = 240_000;
const HEAP_MB = 1024;
const MIN_CORPUS_FILES = 5000;

async function zipOf(files: Record<string, Buffer>, compression: 'STORE' | 'DEFLATE', comment?: string): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer', compression, comment });
}

/** Reads every entry of `archive` the way the fetcher does: tail, central directory, local header, data. */
function readEntries(archive: Buffer): Map<string, Buffer> {
  const tail = archive.subarray(Math.max(0, archive.length - 65_557));
  const location = locateCentralDirectory(tail);
  const entries = parseCentralDirectory(archive.subarray(location.offset, location.offset + location.size), location.entries);
  const out = new Map<string, Buffer>();
  for (const entry of entries) {
    const start = entry.localHeaderOffset + localHeaderLength(archive.subarray(entry.localHeaderOffset, entry.localHeaderOffset + 30));
    out.set(entry.name, inflateEntry(entry, archive.subarray(start, start + entry.compressedSize)));
  }
  return out;
}

describe('ZIP range reader', () => {
  const files = { 'a/report.pdf': Buffer.from(PAYLOAD_TEXT), 'b.bin': Buffer.from([0, 1, 2, 3, 255]), 'empty.txt': Buffer.alloc(0) };

  for (const compression of ['STORE', 'DEFLATE'] as const) {
    it(`extracts every ${compression.toLowerCase()} entry byte for byte`, async () => {
      const entries = readEntries(await zipOf(files, compression));
      expect([...entries.keys()].sort()).toEqual(Object.keys(files).sort());
      for (const [name, data] of Object.entries(files)) expect(entries.get(name)?.equals(data)).toBe(true);
    });
  }

  it('finds the end record behind an archive comment', async () => {
    const entries = readEntries(await zipOf(files, 'DEFLATE', 'x'.repeat(5000)));
    expect(entries.get('b.bin')).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  });

  it('refuses a tail without an end record, a ZIP64 marker and a wrong data length', async () => {
    expect(() => locateCentralDirectory(Buffer.alloc(100))).toThrow(ZipRangeError);
    const archive = await zipOf(files, 'STORE');
    const tail = Buffer.from(archive.subarray(archive.length - 22));
    tail.writeUInt32LE(0xffffffff, 16);
    expect(() => locateCentralDirectory(tail)).toThrow(/ZIP64/);
    expect(() => inflateEntry({ name: 'x', method: 0, compressedSize: 4, size: 4, localHeaderOffset: 0 }, Buffer.alloc(3))).toThrow(/expected 4/);
    expect(() => localHeaderLength(Buffer.alloc(30))).toThrow(/local file header/);
  });
});

describe('corpus manifest', () => {
  const base = (files: unknown[]): string =>
    JSON.stringify({ schema: 1, sources: [{ id: 'src', description: 'd', licence: 'Apache License 2.0' }], files });
  const file = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'src-one.pdf',
    source: 'src',
    format: 'pdf',
    size: 10,
    sha256: SHA,
    origin: { kind: 'file', url: 'https://example.org/one.pdf' },
    ...overrides,
  });

  it('accepts a well-formed manifest', () => {
    expect(parseManifest(base([file()])).files.map((f) => f.id)).toEqual(['src-one.pdf']);
  });

  for (const [label, entry, message] of [
    ['a path-traversal id', file({ id: '../etc/passwd' }), /safe file name/],
    ['a short digest', file({ sha256: 'abc' }), /sha256/],
    ['an unknown source', file({ source: 'other' }), /unknown source/],
    ['a plain-http origin', file({ origin: { kind: 'file', url: 'http://example.org/x' } }), /https/],
    ['a zip origin without an offset', file({ origin: { kind: 'zip', archive: 'https://example.org/a.zip', entry: 'x', compressedSize: 1, method: 8 } }), /offset/],
  ] as const) {
    it(`refuses ${label}`, async () => {
      const error = await captureError(async () => parseManifest(base([entry])));
      expect(error).toBeInstanceOf(ManifestError);
      expect((error as Error).message).toMatch(message);
    });
  }

  it('refuses duplicate ids and a source without a licence', () => {
    expect(() => parseManifest(base([file(), file()]))).toThrow(/duplicate/);
    expect(() => parseManifest(JSON.stringify({ schema: 1, sources: [{ id: 'src', description: '', licence: ' ' }], files: [] }))).toThrow(/licence/);
  });
});

describe('job plan and shards', () => {
  const corpusFile = (id: string, format: string): CorpusFile => ({ id, source: 's', format, size: 1, sha256: SHA, origin: { kind: 'file', url: 'https://x/y' } });
  const files = [...Array.from({ length: 7 }, (_, i) => corpusFile(`p${i}`, 'pdf')), corpusFile('t0', 'txt'), corpusFile('none', 'zzz')];
  const targets: Record<string, string[]> = { pdf: ['docx', 'html', 'png', 'txt', 'jpg'], txt: ['pdf'] };
  const jobs = planJobs(files, (format) => targets[format] ?? [], 2);

  it('covers every advertised target and skips formats without targets', () => {
    expect(jobs).toHaveLength(7 * 2 + 1);
    expect(new Set(jobs.filter((j) => j.file.format === 'pdf').map((j) => j.target))).toEqual(new Set(targets.pdf));
    expect(jobs.some((j) => j.file.id === 'none')).toBe(false);
    expect(new Set(jobs.filter((j) => j.file.id === 'p0').map((j) => j.target)).size).toBe(2);
  });

  it('puts each file with all its jobs in exactly one shard', () => {
    const shards = [0, 1, 2].map((s) => shardJobs(jobs, s, 3));
    expect(shards.flat()).toHaveLength(jobs.length);
    const owner = new Map<string, number>();
    shards.forEach((shard, s) => shard.forEach((job) => {
      expect(owner.get(job.file.id) ?? s).toBe(s);
      owner.set(job.file.id, s);
    }));
    expect(() => shardJobs(jobs, 3, 3)).toThrow(RangeError);
  });
});

describe('verdicts and gate', () => {
  it('maps errors to the status the API answers', () => {
    expect(answeredStatus({ typed: false, status: null })).toBe(500);
    expect(answeredStatus({ typed: true, status: null })).toBe(400);
    expect(isTypedRefusal({ typed: true, status: 413 })).toBe(true);
    expect(isTypedRefusal({ typed: true, status: 503 })).toBe(true);
    expect(isTypedRefusal({ typed: true, status: 500 })).toBe(false);
    expect(isTypedRefusal({ typed: false, status: null })).toBe(false);
  });

  const record = (verdict: JobRecord['verdict'], i: number): JobRecord => ({ file: `f${i}`, source: 'pdf', target: 'txt', verdict, ms: i });

  it('fails on a crash and on a refusal rate above the baseline', () => {
    const clean = Array.from({ length: 30 }, (_, i) => record(i < 3 ? 'refused' : 'ok', i));
    expect(evaluate(clean, { schema: REPORT_SCHEMA, refusalRate: { 'pdf->txt': 0.1 } }).pass).toBe(true);
    expect(evaluate([...clean, record('crash', 99)], null).fatal.map((j) => j.file)).toEqual(['f99']);
    const worse = Array.from({ length: 30 }, (_, i) => record(i < 9 ? 'refused' : 'ok', i));
    expect(evaluate(worse, { schema: REPORT_SCHEMA, refusalRate: { 'pdf->txt': 0.1 } }).refusalRegressions).toEqual([{ pair: 'pdf->txt', baseline: 0.1, now: 0.3 }]);
    expect(pairStats(worse)[0]).toMatchObject({ pair: 'pdf->txt', jobs: 30, refusalRate: 0.3, p95Ms: 28 });
  });

  it('reports a tracked failure without failing on it, and still fails on an untracked one', () => {
    const tracked: JobRecord = { file: 'k', source: 'ppt', target: 'odp', verdict: 'crash', ms: 1, detail: 'Error: Unsupported conversion from PPT to odp' };
    const untracked: JobRecord = { ...tracked, file: 'u', detail: 'TypeError: cannot read properties of undefined' };
    const known = [{ pair: '*', verdict: 'crash' as const, detail: '^Error: Unsupported conversion from ', issue: 631 }];
    const gate = evaluate([tracked, untracked], null, known);
    expect(gate.known).toEqual([{ job: tracked, issue: 631 }]);
    expect(gate.fatal.map((j) => j.file)).toEqual(['u']);
    expect(gate.pass).toBe(false);
    expect(evaluate([tracked], null, known).pass).toBe(true);
  });

  it('accepts only known failures that name their tracking issue and a failing verdict', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realworld-known-'));
    const write = (body: unknown): string => {
      const file = path.join(dir, `${Math.random()}.json`);
      fs.writeFileSync(file, JSON.stringify(body));
      return file;
    };
    expect(() => readKnownFailures(write([{ pair: '*', verdict: 'crash', detail: 'x' }]))).toThrow(/issue/);
    expect(() => readKnownFailures(write([{ pair: '*', verdict: 'ok', detail: 'x', issue: 1 }]))).toThrow(/not a failure/);
    expect(readKnownFailures().every((k) => k.issue > 0)).toBe(true);
  });

  it('renders the pair table, the untracked failures with escaped details, and the tracked ones by issue', () => {
    const jobs: JobRecord[] = [
      { file: 'a', source: 'pdf', target: 'txt', verdict: 'ok', ms: 10 },
      { file: 'b', source: 'pdf', target: 'txt', verdict: 'crash', ms: 20, detail: 'TypeError: x | y' },
      { file: 'c', source: 'ppt', target: 'odp', verdict: 'crash', ms: 30, detail: 'Error: Unsupported conversion from PPT to odp' },
    ];
    const gate = evaluate(jobs, null, [{ pair: 'ppt->odp', verdict: 'crash', detail: '^Error: Unsupported', issue: 631 }]);
    const lines = renderMarkdown(jobs, gate).split('\n');
    expect(lines).toContain('Gate: **fail**. Jobs: 3. ok 1, refused 0, bad-output 0, crash 2, hang 0.');
    expect(lines).toContain('| pdf->txt | 2 | 1 | 0 | 0 | 1 | 0 | 20 |');
    expect(lines).toContain('| b | pdf->txt | crash | TypeError: x \\| y |');
    expect(lines).toContain('| #631 | 1 |');
    expect(lines.some((line) => line.startsWith('| c |'))).toBe(false);
  });

  it('refuses to merge an incomplete set of shards', () => {
    const shard = (n: number): ShardReport => ({ schema: REPORT_SCHEMA, shard: n, shards: 2, commit: 'c', jobs: [record('ok', n)] });
    expect(mergeShards([shard(0), shard(1)])).toHaveLength(2);
    expect(() => mergeShards([shard(0)])).toThrow(/1 of 2/);
  });
});

describe('isolated job pool', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realworld-pool-'));
  const good = path.join(dir, 'good.png');
  const broken = path.join(dir, 'broken.png');
  fs.writeFileSync(good, PNG_1X1);
  fs.writeFileSync(broken, Buffer.concat([PNG_1X1.subarray(0, 40), Buffer.alloc(16)]));

  it('converts a valid file, refuses a corrupt one with a typed error, and survives a hang', async () => {
    const env = { ...process.env, REALWORLD_PDFINFO: '', REALWORLD_IDENTIFY: '' };
    const pool = await JobPool.start({ workers: 1, deadlineMs: JOB_DEADLINE_MS, heapMb: HEAP_MB, env });
    try {
      const [ok, refused] = await pool.runAll([
        { path: good, name: 'good.png', format: 'png', target: 'bmp' },
        { path: broken, name: 'broken.png', format: 'png', target: 'bmp' },
      ]);
      expect(ok.verdict).toBe('ok');
      expect(ok.bytes).toBeGreaterThan(54);
      expect(refused.verdict).toBe('refused');
    } finally {
      pool.stop();
    }
    const hanging = await JobPool.start({ workers: 1, deadlineMs: HANG_DEADLINE_MS, heapMb: HEAP_MB, env });
    try {
      const [first, second] = await hanging.runAll([
        { path: good, name: 'good.png', format: 'png', target: 'bmp' },
        { path: good, name: 'good.png', format: 'png', target: 'bmp' },
      ]);
      expect(first.verdict).toBe('hang');
      expect(second.verdict).toBe('hang');
      expect(first.detail).toMatch(/no answer within 1 ms/);
    } finally {
      hanging.stop();
    }
  }, POOL_TEST_TIMEOUT_MS);
});

describe('job deadline by size', () => {
  const BASE_MS = 180_000;
  const SHARD_PAGES = 20;

  it('is the base deadline for a file without OCR pages, and grows by the converter page budget for each page', () => {
    expect(scaledDeadlineMs(BASE_MS, 0)).toBe(BASE_MS);
    expect(scaledDeadlineMs(BASE_MS, 1)).toBe(BASE_MS + OCR_PAGE_BUDGET_MS);
    expect(scaledDeadlineMs(BASE_MS, SHARD_PAGES)).toBe(BASE_MS + SHARD_PAGES * OCR_PAGE_BUDGET_MS);
  });

  it('stops growing at the longest a job may run, and never goes below the base deadline', () => {
    expect(scaledDeadlineMs(BASE_MS, 100_000)).toBe(MAX_JOB_DEADLINE_MS);
    expect(scaledDeadlineMs(2 * MAX_JOB_DEADLINE_MS, 100_000)).toBe(2 * MAX_JOB_DEADLINE_MS);
  });

  it('keeps TOLERATED_HUNG_JOBS jobs hung at the longest deadline inside half of the nightly shard timeout', () => {
    const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'nightly.yml'), 'utf8');
    const realworld = workflow.slice(workflow.indexOf('\n  realworld:'), workflow.indexOf('\n  realworld-gate:'));
    const minutes = Number(/timeout-minutes:\s*(\d+)/.exec(realworld)?.[1]);
    expect(minutes, 'timeout-minutes of the realworld job').toBeGreaterThan(0);
    const holdMs = (TOLERATED_HUNG_JOBS * MAX_JOB_DEADLINE_MS) / NIGHTLY_WORKERS;
    expect(holdMs).toBeLessThanOrEqual((minutes * 60_000) / 2);
    expect(MAX_JOB_DEADLINE_MS).toBe(540_000);
  });

  describe('which files are read by OCR', () => {
    async function pdfOf(pages: Array<'text' | 'picture'>): Promise<Buffer> {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const picture = await doc.embedPng(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer());
      for (const kind of pages) {
        const page = doc.addPage([612, 792]);
        if (kind === 'text') page.drawText('The committee reviewed the quarterly report and approved the budget for the water project.', { x: 36, y: 700, size: 12, font });
        else page.drawImage(picture, { x: 36, y: 36, width: 540, height: 720 });
      }
      return Buffer.from(await doc.save());
    }

    it('counts every page of a PDF that has no text, the pages the converter recognizes', async () => {
      expect(await ocrPageCount(await pdfOf(['picture', 'picture', 'picture']))).toBe(3);
    });

    it('counts none of a PDF that has text, which the converter reads without OCR, even when some pages are pictures', async () => {
      expect(await ocrPageCount(await pdfOf(['text', 'text']))).toBe(0);
      expect(await ocrPageCount(await pdfOf(['text', 'picture', 'picture']))).toBe(0);
    });

    it('counts none of a file the PDF reader cannot open', async () => {
      expect(await ocrPageCount(Buffer.from('not a pdf'))).toBe(0);
    });
  });

  it('takes the deadline of a job in place of the pool deadline, so a job given time is not reported as hung', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realworld-deadline-'));
    const good = path.join(dir, 'good.png');
    fs.writeFileSync(good, PNG_1X1);
    const env = { ...process.env, REALWORLD_PDFINFO: '', REALWORLD_IDENTIFY: '' };
    const pool = await JobPool.start({ workers: 1, deadlineMs: HANG_DEADLINE_MS, heapMb: HEAP_MB, env });
    try {
      const [given, notGiven] = await pool.runAll([
        { path: good, name: 'good.png', format: 'png', target: 'bmp', deadlineMs: JOB_DEADLINE_MS },
        { path: good, name: 'good.png', format: 'png', target: 'bmp' },
      ]);
      expect(given.verdict).toBe('ok');
      expect(notGiven.verdict).toBe('hang');
    } finally {
      pool.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, POOL_TEST_TIMEOUT_MS);
});

describe('output check', () => {
  const NO_READERS = { pdfinfo: '', identify: '' };
  const ZIP_MIME = 'application/zip';
  const check = (buffer: Buffer, target: string, mimeType?: string) => outputProblem(buffer, target, os.tmpdir(), { ...NO_READERS, mimeType });

  it('accepts the ZIP of page images a multi-page document converts to, and nothing else dressed as an image', async () => {
    const pages = await zipOf({ 'doc-1.png': PNG_1X1, 'doc-2.png': PNG_1X1 }, 'DEFLATE');
    expect(await check(pages, 'png', ZIP_MIME)).toBeNull();
    expect(await check(pages, 'png')).toBe('output bytes do not match png');
    expect(await check(PNG_1X1, 'png')).toBeNull();
    const eps = Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nshowpage\n');
    expect(await check(await zipOf({ 'doc-1.eps': eps, 'doc-2.eps': eps }, 'DEFLATE'), 'eps', ZIP_MIME)).toBeNull();
  });

  it('rejects a page archive that is empty, holds a page of another type, or is not a ZIP', async () => {
    expect(await check(await zipOf({}, 'STORE'), 'png', ZIP_MIME)).toBe('png page archive has no pages');
    const mixed = await zipOf({ 'doc-1.png': PNG_1X1, 'doc-2.png': Buffer.from('not an image') }, 'DEFLATE');
    expect(await check(mixed, 'png', ZIP_MIME)).toBe('page doc-2.png: output bytes do not match png');
    expect(await check(Buffer.from('plain text, no archive'), 'png', ZIP_MIME)).toBe('png page archive is not a readable ZIP');
    expect(await check(Buffer.alloc(0), 'png', ZIP_MIME)).toBe('empty output');
  });

  it('does not take a ZIP for a target that is not delivered page by page', async () => {
    const archive = await zipOf({ 'a.txt': Buffer.from('x') }, 'STORE');
    expect(await check(archive, 'pdf', ZIP_MIME)).toBe('output bytes do not match pdf');
  });
});

describe('production conversion path', () => {
  // ppt -> odp is converted only by the LibreOffice pool behind the dispatcher; the in-process converter refuses it.
  oracleTest(
    'a job server converts ppt to odp, a pair only the dispatcher can answer',
    ['soffice'],
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realworld-prod-'));
      const file = path.join(dir, 'slides.ppt');
      fs.writeFileSync(file, authorWithReferenceSuite('ppt'));
      const env = { ...process.env, REALWORLD_PDFINFO: '', REALWORLD_IDENTIFY: '' };
      const pool = await JobPool.start({ workers: 1, deadlineMs: JOB_DEADLINE_MS, heapMb: HEAP_MB, env });
      try {
        const [outcome] = await pool.runAll([{ path: file, name: 'slides.ppt', format: 'ppt', target: 'odp' }]);
        expect(outcome.detail).toBeUndefined();
        expect(outcome.verdict).toBe('ok');
        expect(outcome.bytes).toBeGreaterThan(0);
      } finally {
        pool.stop();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    POOL_TEST_TIMEOUT_MS
  );
});

describe('manifest file', () => {
  it('lists only licensed sources, unique ids and verified digests', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'realworld', 'manifest.json'), 'utf8')) as CorpusManifest;
    const parsed = parseManifest(JSON.stringify(manifest));
    expect(parsed.files.length).toBeGreaterThanOrEqual(MIN_CORPUS_FILES);
    expect(new Set(parsed.files.map((f) => f.source))).toEqual(new Set(parsed.sources.map((s) => s.id)));
  });
});
