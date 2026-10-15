import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { NextRequest } from 'next/server';
import type { Job } from '@/lib/queue/bullmq-engine';
import { POST as inspectRoute } from '../src/app/api/v1/archives/inspect/route';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import { ARCHIVE_SECURITY_LIMITS, convertArchive, inspectArchive, repairZipArchive } from '../src/lib/conversions/archive';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { decodeWoff2 } from '../src/lib/conversions/font';
import { generateHtmlFromSlides, parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { HTML_MAX_EMBEDDED_BASE64_CHARS } from '../src/lib/conversions/office/pptx-media';
import { Woff2FormatError, Woff2LimitError, WOFF2_MAX_TABLES } from '../src/lib/conversions/font-woff2';
import { payloadLimitStatus } from '../src/lib/api/payload-limit';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { s3Storage } from '../src/lib/storage/s3-storage';
import {
  ConversionFailedError,
  CorruptStreamError,
  DecompressionLimitError,
  PayloadLimitError,
  type ConversionJobData,
  type ConversionJobResult,
} from '../src/lib/types';
import {
  BOMB_BYTES,
  MIB,
  compressPadded,
  compressZeros,
  compressibleText,
  craftZip,
  localEntryOnly,
  tarOfFile,
  unterminatedDeflate,
} from './helpers/decompression-fixtures';
import { buildWoff2, minimalTransformedFont } from './helpers/woff2-builder';
import { buildDocxWithJpeg, buildPptxWithJpeg, makeNoisyJpeg } from './helpers/office-jpeg-fixtures';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const CHILD = path.join(__dirname, 'decompression-bomb-child.ts');

/** The bound the issue sets for refusing a bomb. */
const REFUSAL_MS = 500;
/** Peak RSS a bounded decoder may add while it refuses a bomb; an unbounded one adds the whole bomb. */
const MAX_RSS_GROWTH_BYTES = 100 * MIB;
/** A parsed package part may be held up to its 128 MiB cap before the stream is stopped. */
const XLSX_MAX_RSS_GROWTH_BYTES = 384 * MIB;
/** One-process-per-scenario runs share the machine; two at a time keep the timings honest. */
const CHILD_CONCURRENCY = 2;
const CHILD_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 180_000;

interface Outcome {
  error: { name: string; status?: number; message: string } | null;
  elapsedMs: number;
  rssGrowthBytes: number;
  size: number | null;
  pictures: string[];
}

let workDir = '';
const fixtures = new Map<string, string>();

function fixture(name: string, bytes: Buffer): void {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, bytes);
  fixtures.set(name, file);
}

/** Runs the scenario in a fresh process, so the peak RSS it reports belongs to this scenario alone. */
async function inChild(scenario: string, fixtureName: string, env: Record<string, string> = {}): Promise<Outcome> {
  const file = fixtures.get(fixtureName);
  if (!file) throw new Error(`no fixture ${fixtureName}`);
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', CHILD, scenario, file], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 4 * MIB,
  });
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('RESULT:'));
  if (!line) throw new Error(`scenario ${scenario} printed no result: ${stdout.slice(0, 400)}`);
  return JSON.parse(line.slice('RESULT:'.length)) as Outcome;
}

const results = new Map<string, Promise<Outcome>>();
let slots = CHILD_CONCURRENCY;
const waiting: Array<() => void> = [];

/** The outcome of a scenario, started on first use and run under the concurrency limit. */
function outcomeOf(scenario: string, fixtureName: string, env: Record<string, string> = {}): Promise<Outcome> {
  const key = `${scenario}:${fixtureName}:${JSON.stringify(env)}`;
  let result = results.get(key);
  if (!result) {
    result = (async () => {
      if (slots === 0) await new Promise<void>((resolve) => waiting.push(resolve));
      else slots -= 1;
      try {
        return await inChild(scenario, fixtureName, env);
      } finally {
        const next = waiting.shift();
        if (next) next();
        else slots += 1;
      }
    })();
    results.set(key, result);
  }
  return result;
}

function expectBombRefused(outcome: Outcome): void {
  expect(outcome.error?.name).toBe('DecompressionLimitError');
  expect(outcome.error?.status).toBe(413);
  expect(outcome.elapsedMs).toBeLessThan(REFUSAL_MS);
  expect(outcome.rssGrowthBytes).toBeLessThan(MAX_RSS_GROWTH_BYTES);
}

const NO_ZIP_BINARY = { ZIP_PATH: path.join(os.tmpdir(), 'no-such-zip-binary') };

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decompression-bounds-'));
  fixture('gzip-bomb.bin', await compressZeros(BOMB_BYTES, 'gzip'));
  const zeros = await compressZeros(BOMB_BYTES, 'rawDeflate');
  fixture('repair-bomb.zip', localEntryOnly('zeros.bin', zeros));
  // 40 MiB of zeros in a ZIP of about 40 KB: under the 64 MiB per-entry cap, far over 100 times the archive.
  fixture('repair-ratio.zip', localEntryOnly('zeros.bin', await compressZeros(40 * MIB, 'rawDeflate')));
  fixture('repair-cpu.zip', localEntryOnly('a.bin', await unterminatedDeflate(32 * MIB)));
  // The central directory declares exactly the per-entry cap, so only the byte count of the running stream can stop it.
  fixture('xlsx-at-cap.xlsx', craftZip([{ name: 'xl/sharedStrings.xml', deflated: zeros, declaredSize: 128 * MIB }]));
  fixture('xlsx-honest.xlsx', craftZip([{ name: 'xl/sharedStrings.xml', deflated: zeros, declaredSize: BOMB_BYTES }]));
  fixture('xlsx-lying.xlsx', craftZip([{ name: 'xl/sharedStrings.xml', deflated: zeros, declaredSize: 4096 }]));
  fixture('package-at-cap.docx', craftZip([{ name: 'word/document.xml', deflated: zeros, declaredSize: MIB }]));
  fixture('zip-lying.zip', craftZip([{ name: 'big.bin', deflated: zlib.deflateRawSync(compressibleText(50_000)), declaredSize: 100 }]));
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

describe('gzip bombs are refused as typed 413 errors, fast and with bounded memory', () => {
  it('gunzipStreamingWithLimits throws a DecompressionLimitError for a size or ratio bomb', async () => {
    expectBombRefused(await outcomeOf('gunzip', 'gzip-bomb.bin'));
  });

  it.each(['convert-tar-gz', 'convert-tgz', 'convert-gz'])('%s refuses the bomb', async (scenario) => {
    expectBombRefused(await outcomeOf(scenario, 'gzip-bomb.bin'));
  });

  it('inspectArchive refuses a gzip bomb instead of inflating it', async () => {
    expectBombRefused(await outcomeOf('inspect', 'gzip-bomb.bin'));
  });

  it('the graph archive.extract node refuses a tgz bomb', async () => {
    expectBombRefused(await outcomeOf('graph-tgz', 'gzip-bomb.bin'));
  });

  it('a corrupt gzip stream stays a plain 400 conversion failure, not a limit error', async () => {
    const corrupt = zlib.gzipSync(Buffer.alloc(4096, 1)).subarray(0, 30);
    const failure = await convertArchive(corrupt, 'tar.gz', 'zip', {}, 'corrupt.tar.gz').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(DecompressionLimitError);
    expect((failure as Error).message).toMatch(/^Failed to decompress GZIP archive 'corrupt\.tar\.gz'/);
  });
});

describe('ordinary gzip archives above the 1 MiB ratio-check threshold are accepted', () => {
  const CONTENT_BYTES = 4 * MIB;
  const content = compressibleText(CONTENT_BYTES);
  const tarGz = zlib.gzipSync(tarOfFile('notes/report.txt', content));

  it('is a realistic fixture: decodes past the threshold at a ratio far under the limit', () => {
    const ratio = (CONTENT_BYTES + 1024) / tarGz.length;
    expect(CONTENT_BYTES).toBeGreaterThan(MIB);
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(ARCHIVE_SECURITY_LIMITS.MAX_RATIO / 5);
  });

  it('inspectArchive lists it', async () => {
    const report = await inspectArchive(tarGz, { filename: 'report.tar.gz' });
    expect(report.entries.map((entry) => [entry.name, entry.uncompressedSize])).toEqual([['notes/report.txt', CONTENT_BYTES]]);
  });

  it('convertArchive extracts it byte for byte, as tar.gz and as tgz', async () => {
    for (const source of ['tar.gz', 'tgz'] as const) {
      const result = await convertArchive(tarGz, source, 'zip', {}, `report.${source}`);
      const zip = await JSZip.loadAsync(result.buffer);
      const extracted = await zip.file('notes/report.txt')!.async('nodebuffer');
      expect(extracted.equals(content), source).toBe(true);
    }
  });

  it('the graph archive.extract node stores the extracted file byte for byte', async () => {
    const key = `tests/decompression-bounds-remaining/${Date.now()}_report.tgz`;
    await s3Storage.saveObject(key, tarGz, 'application/gzip', 'report.tgz', 60_000);
    const result = await processGraphNodeJob(graphExtractJob(key), undefined, s3Storage);
    expect(result.resultKey).toMatch(/report\.txt$/);
    const stored = await s3Storage.getObject(result.resultKey);
    expect(stored?.buffer.equals(content)).toBe(true);
  });
});

function graphExtractJob(inputKey: string) {
  const graphId = `g_bounds_${Date.now()}`;
  return {
    id: `${graphId}:n1`,
    data: {
      jobId: `${graphId}:n1`,
      sourceFormat: 'bin',
      targetFormat: 'bin',
      fileSize: 0,
      options: {},
      graphId,
      graphNodeId: 'n1',
      graphNode: { op: 'archive.extract' },
      inputArtifacts: [inputKey],
    },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

describe('the inspect API answers 413 for a decompression bomb', () => {
  it('maps a gzip bomb to HTTP 413, not the 422 of an invalid archive', async () => {
    const email = `bomb_${Date.now()}_${Math.random().toString(36).slice(2)}@test.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'Bomb Inspector', tier: 'pro' }));
    const bomb = fs.readFileSync(fixtures.get('gzip-bomb.bin')!);
    const request = new NextRequest('http://localhost:3000/api/v1/archives/inspect', {
      method: 'POST',
      headers: { Cookie: `easyconvert_session=${createSessionToken(user)}`, 'x-archive-filename': 'bomb.tar.gz' },
      body: new Uint8Array(bomb),
    });
    const response = await inspectRoute(request);
    expect(response.status).toBe(413);
    const problem = await response.json();
    expect(problem.detail).toMatch(/Archive bomb detected/);
  });
});

describe('ZIP repair salvage', () => {
  async function withoutZipBinary<T>(operation: () => Promise<T>): Promise<T> {
    const original = process.env.ZIP_PATH;
    process.env.ZIP_PATH = NO_ZIP_BINARY.ZIP_PATH;
    try {
      return await operation();
    } finally {
      if (original === undefined) delete process.env.ZIP_PATH;
      else process.env.ZIP_PATH = original;
    }
  }

  it('refuses a deflate entry that expands far past the archive limits', async () => {
    expectBombRefused(await outcomeOf('repair', 'repair-bomb.zip', NO_ZIP_BINARY));
  });

  it('holds an entry to 100 times the archive even when it is under the 64 MiB per-entry cap', async () => {
    const archive = fs.readFileSync(fixtures.get('repair-ratio.zip')!);
    expect(archive.length * ARCHIVE_SECURITY_LIMITS.MAX_RATIO).toBeLessThan(40 * MIB);
    expectBombRefused(await outcomeOf('repair', 'repair-ratio.zip', NO_ZIP_BINARY));
  });

  it('salvages a cut-off stream in one pass instead of retrying every prefix', async () => {
    const archive = fs.readFileSync(fixtures.get('repair-cpu.zip')!);
    expect(archive.length).toBeGreaterThan(800_000);
    expect(archive.length).toBeLessThan(1_200_000);
    const outcome = await outcomeOf('repair', 'repair-cpu.zip', NO_ZIP_BINARY);
    expect(outcome.error).toBeNull();
    expect(outcome.size).toBeGreaterThan(1_000_000);
    expect(outcome.elapsedMs).toBeLessThan(2000);
  });

  it('returns the exact bytes of an ordinary entry', async () => {
    const original = compressibleText(300_000, 11);
    const repaired = await withoutZipBinary(() => repairZipArchive(localEntryOnly('note.txt', zlib.deflateRawSync(original))));
    const zip = await JSZip.loadAsync(repaired);
    expect((await zip.file('note.txt')!.async('nodebuffer')).equals(original)).toBe(true);
  });

  it('keeps the bytes decoded before a cut-off stream ends', async () => {
    const original = compressibleText(300_000, 12);
    const cut = zlib.deflateRawSync(original, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const repaired = await withoutZipBinary(() => repairZipArchive(localEntryOnly('cut.txt', cut)));
    const zip = await JSZip.loadAsync(repaired);
    expect((await zip.file('cut.txt')!.async('nodebuffer')).equals(original)).toBe(true);
  });
});

describe('JSZip package readers inflate under a byte cap', () => {
  it('stops an XLSX whose shared strings declare the cap and decode to 256 MiB', async () => {
    const outcome = await outcomeOf('xlsx', 'xlsx-at-cap.xlsx');
    expect(outcome.error?.name).toBe('DecompressionLimitError');
    expect(outcome.error?.status).toBe(413);
    expect(outcome.elapsedMs).toBeLessThan(5000);
    // The 128 MiB of decoded bytes held when the cap is hit; inflating the whole bomb adds more than 600 MiB.
    expect(outcome.rssGrowthBytes).toBeLessThan(XLSX_MAX_RSS_GROWTH_BYTES);
  });

  it('refuses an XLSX that declares more than the cap before inflating a byte', async () => {
    const outcome = await outcomeOf('xlsx', 'xlsx-honest.xlsx');
    expect(outcome.error?.status).toBe(413);
    expect(outcome.elapsedMs).toBeLessThan(REFUSAL_MS);
  });

  it('answers 400 for an entry that decodes to more than its declared size', async () => {
    const outcome = await outcomeOf('xlsx', 'xlsx-lying.xlsx');
    expect(outcome.error?.name).toBe('CorruptStreamError');
    expect(outcome.error?.status).toBe(400);
    expect(outcome.elapsedMs).toBeLessThan(REFUSAL_MS);
  });

  it('readPackageEntry stops at its limit however the central directory declares the size', async () => {
    const outcome = await outcomeOf('package-entry', 'package-at-cap.docx');
    expect(outcome.error?.name).toBe('DecompressionLimitError');
    expect(outcome.error?.status).toBe(413);
    expect(outcome.elapsedMs).toBeLessThan(REFUSAL_MS);
    expect(outcome.rssGrowthBytes).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('a ZIP entry whose inflated size differs from its declared size answers 400 through the archive converter', async () => {
    const archive = fs.readFileSync(fixtures.get('zip-lying.zip')!);
    const failure = await convertArchive(archive, 'zip', 'tar', {}, 'lying.zip').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect(failure).not.toBeInstanceOf(PayloadLimitError);
    expect((failure as { status?: number }).status).toBe(400);
    expect((failure as Error).message).toMatch(/^Invalid ZIP archive: 'big\.bin' (decodes to more than the \d+ bytes it declares|decodes to \d+ bytes but declares \d+)/);
  });

  it('still reads an ordinary workbook', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file(
      'xl/workbook.xml',
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    );
    zip.file('xl/sharedStrings.xml', '<sst><si><t>ordinary shared string</t></si></sst>');
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>');
    const sheets = await parseAllXlsxWorksheets(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    expect(sheets.map((sheet) => sheet.rows[0][0])).toEqual(['ordinary shared string']);
  });
});

describe('7z Deflate folder', () => {
  const DEFLATE_FOLDER_PREFIX = Buffer.from([0x0b, 0x01, 0x00, 0x01, 0x03, 0x04, 0x01, 0x08, 0x0c]);
  const START_HEADER_BYTES = 32;
  const DECLARED_BYTES = 5 * MIB;
  const ACTUAL_BYTES = 64 * MIB;

  /** Writes `value` as a 7z NUMBER of exactly four bytes. */
  function sevenZipNumber4(value: number): Buffer {
    return Buffer.from([0xe0 | ((value >>> 24) & 0x0f), value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]);
  }

  /** A 7-Zip written Deflate archive of zeros whose folder declares `DECLARED_BYTES` while the stream holds `ACTUAL_BYTES`. */
  function archiveWithUnderstatedSize(dir: string): Buffer {
    const source = path.join(dir, 'zeros.bin');
    fs.closeSync(fs.openSync(source, 'w'));
    fs.truncateSync(source, ACTUAL_BYTES);
    const archivePath = path.join(dir, 'zeros.7z');
    execFileSync(requireOracleTool('7z'), ['a', '-t7z', '-m0=Deflate', '-mx=1', '-mhc=off', '-y', archivePath, 'zeros.bin'], { cwd: dir, stdio: 'ignore' });
    const archive = fs.readFileSync(archivePath);
    const at = archive.indexOf(DEFLATE_FOLDER_PREFIX, START_HEADER_BYTES);
    expect(at, 'plain-header Deflate folder').toBeGreaterThan(0);
    const numberAt = at + DEFLATE_FOLDER_PREFIX.length;
    expect(archive[numberAt] & 0xf0).toBe(0xe0);
    sevenZipNumber4(DECLARED_BYTES).copy(archive, numberAt);
    const nextHeaderOffset = Number(archive.readBigUInt64LE(12));
    const nextHeaderSize = Number(archive.readBigUInt64LE(20));
    const header = archive.subarray(START_HEADER_BYTES + nextHeaderOffset, START_HEADER_BYTES + nextHeaderOffset + nextHeaderSize);
    archive.writeUInt32LE(zlib.crc32(header), 28);
    archive.writeUInt32LE(zlib.crc32(archive.subarray(12, 32)), 8);
    return archive;
  }

  oracleTest('a stream that decodes past the size its folder declares is refused at that size', ['7z'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounds-7z-'));
    try {
      const archive = archiveWithUnderstatedSize(dir);
      expect(archive.length * ARCHIVE_SECURITY_LIMITS.MAX_RATIO).toBeGreaterThan(DECLARED_BYTES);
      fixture('understated.7z', archive);
      const outcome = await outcomeOf('sevenzip', 'understated.7z');
      expect(outcome.error?.name).toBe('CorruptStreamError');
      expect(outcome.error?.status).toBe(400);
      expect(outcome.rssGrowthBytes).toBeLessThan(MAX_RSS_GROWTH_BYTES);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WOFF2 limits answer 413', () => {
  it('a table count over the engine limit is a Woff2LimitError that the routes answer with 413', () => {
    const file = buildWoff2({ tables: minimalTransformedFont(), numTables: WOFF2_MAX_TABLES + 1 });
    const failure = (() => {
      try {
        return decodeWoff2(file, 'limit');
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(Woff2LimitError);
    expect(payloadLimitStatus(failure)).toBe(413);
  });

  it('payloadLimitStatus separates size limits from malformed input', () => {
    expect(payloadLimitStatus(new DecompressionLimitError('bomb'))).toBe(413);
    expect(payloadLimitStatus(new PayloadLimitError('too many text blocks'))).toBe(413);
    expect(payloadLimitStatus(new Woff2FormatError('bad magic'))).toBeNull();
    expect(payloadLimitStatus(new CorruptStreamError('cut short'))).toBeNull();
    expect(payloadLimitStatus(new Error('plain'))).toBeNull();
  });
});

describe('embedded media: read once per part, only where it is drawn, under a per-document budget', () => {
  const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
  const SLIDE_TEXT = 'Quarterly results';
  const BUDGET_ENV = { EASYCONVERT_MAX_DOCUMENT_MEDIA_BYTES: String(64 * MIB) };

  /** A JPEG that is also `padBytes` of filler: the picture part of the office fixture, grown. */
  async function pictureOf(padBytes: number, filler: number): Promise<Buffer> {
    return Buffer.concat([await makeNoisyJpeg(), Buffer.alloc(padBytes, filler)]);
  }

  /** The fixture deck with `parts` as its media, each picture of the slide drawn `refs` times. */
  async function deckWith(parts: Buffer[], refs: number, compression: 'STORE' | 'DEFLATE' = 'DEFLATE'): Promise<Buffer> {
    const zip = await JSZip.loadAsync(await buildPptxWithJpeg(await makeNoisyJpeg()));
    zip.remove('ppt/media/image1.jpg');
    const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('text');
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('text');
    const picture = slide.match(/<p:pic>[\s\S]*?<\/p:pic>/)![0];
    let pictures = '';
    let relationships = '';
    parts.forEach((part, index) => {
      zip.file(`ppt/media/image${index + 1}.jpg`, part, { compression });
      relationships += `<Relationship Id="rIdM${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index + 1}.jpg"/>`;
      pictures += picture.replace('r:embed="rId2"', `r:embed="rIdM${index}"`).repeat(refs);
    });
    zip.file('ppt/slides/slide1.xml', slide.replace(picture, pictures));
    zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels.replace('</Relationships>', `${relationships}</Relationships>`));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  function deckFixture(name: string, deck: Buffer): void {
    fixture(name, deck);
  }

  it('converts a deck with a 70 MiB picture to text, and to HTML with the picture bytes intact', async () => {
    const part = await pictureOf(70 * MIB, 0x5a);
    const deck = await deckWith([part], 1, 'STORE');
    const text = await dispatchConversion(deck, 'pptx', 'txt', {}, 'media.pptx');
    expect(text.buffer.toString('utf-8')).toBe(`--- Slide 1 ---\n${SLIDE_TEXT}`);
    const html = (await dispatchConversion(deck, 'pptx', 'html', {}, 'media.pptx')).buffer.toString('utf-8');
    const uris = [...html.matchAll(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/g)];
    expect(uris.map((uri) => sha256(Buffer.from(uri[1], 'base64')))).toEqual([sha256(part)]);
  });

  it('converts a deck with a 3840x2160 uncompressed TIFF that deflates past 100:1', async () => {
    const tiff = await sharp({ create: { width: 3840, height: 2160, channels: 3, background: { r: 30, g: 90, b: 160 } } })
      .tiff({ compression: 'none' })
      .toBuffer();
    expect(tiff.length / zlib.deflateRawSync(tiff).length).toBeGreaterThan(100);
    const zip = await JSZip.loadAsync(await buildPptxWithJpeg(await makeNoisyJpeg()));
    zip.remove('ppt/media/image1.jpg');
    zip.file('ppt/media/image1.tif', tiff);
    const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('text');
    zip.file('ppt/slides/_rels/slide1.xml.rels', rels.replace('image1.jpg', 'image1.tif'));
    const deck = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const html = (await dispatchConversion(deck, 'pptx', 'html', {}, 'tiff.pptx')).buffer.toString('utf-8');
    const uri = html.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
    const meta = await sharp(Buffer.from(uri![1], 'base64')).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 3840, 2160]);
  });

  it('reads a part used by six pictures once, and none at all for text', async () => {
    deckFixture('refs-one-part.pptx', await deckWith([await pictureOf(40 * MIB, 0x5a)], 6));
    const source = sha256(await pictureOf(40 * MIB, 0x5a));
    // 6 reads of 40 MiB would pass the 64 MiB document budget; one read does not.
    const html = await outcomeOf('pptx-html', 'refs-one-part.pptx', BUDGET_ENV);
    expect(html.error).toBeNull();
    expect(html.pictures).toEqual(Array(6).fill(source));
    const text = await outcomeOf('pptx-txt', 'refs-one-part.pptx', BUDGET_ENV);
    expect(text.error).toBeNull();
    expect(text.size).toBe(`--- Slide 1 ---\n${SLIDE_TEXT}`.length);
    // The first conversion in a process loads converter code; a deck without media shows what that costs.
    deckFixture('refs-control.pptx', await deckWith([await makeNoisyJpeg()], 1));
    const control = await outcomeOf('pptx-txt', 'refs-control.pptx', BUDGET_ENV);
    // Reading the 40 MiB part would raise the peak by at least that much.
    expect(text.rssGrowthBytes - control.rssGrowthBytes).toBeLessThan(24 * MIB);
  });

  it('charges the media of a whole document to one budget, and only where the target draws it', async () => {
    deckFixture('two-parts.pptx', await deckWith([await pictureOf(40 * MIB, 0x5a), await pictureOf(40 * MIB, 0x5b)], 1));
    const html = await outcomeOf('pptx-html', 'two-parts.pptx', BUDGET_ENV);
    expect(html.error?.name).toBe('DecompressionLimitError');
    expect(html.error?.status).toBe(413);
    expect(html.error?.message).toMatch(/would exceed the decoded-byte budget of 67108864 bytes/);
    const text = await outcomeOf('pptx-txt', 'two-parts.pptx', BUDGET_ENV);
    expect(text.error).toBeNull();
  });

  it('refuses a media part past the limit of one part before inflating it', async () => {
    const zeros = await compressZeros(BOMB_BYTES, 'rawDeflate');
    const zip = await JSZip.loadAsync(await buildPptxWithJpeg(await makeNoisyJpeg()));
    const base = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const entries = await Promise.all(
      Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map(async (entry) =>
          entry.name === 'ppt/media/image1.jpg'
            ? { name: entry.name, deflated: zeros, declaredSize: 1536 * MIB }
            : { name: entry.name, deflated: zlib.deflateRawSync(await entry.async('nodebuffer')), declaredSize: (await entry.async('nodebuffer')).length }
        )
    );
    expect(base.length).toBeGreaterThan(0);
    deckFixture('bomb-media.pptx', craftZip(entries));
    const html = await outcomeOf('pptx-html', 'bomb-media.pptx');
    expect(html.error?.name).toBe('DecompressionLimitError');
    expect(html.error?.status).toBe(413);
    expect(html.error?.message).toMatch(/decodes to more than the limit of \d+ bytes/);
    expect(html.elapsedMs).toBeLessThan(REFUSAL_MS);
    expect(html.rssGrowthBytes).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('counts the PNG made from a TIFF part against the media budget', async () => {
    const noise = crypto.randomBytes(3840 * 2160 * 3);
    const tiff = await sharp(noise, { raw: { width: 3840, height: 2160, channels: 3 } }).tiff({ compression: 'none' }).toBuffer();
    const zip = await JSZip.loadAsync(await buildPptxWithJpeg(await makeNoisyJpeg()));
    zip.remove('ppt/media/image1.jpg');
    zip.file('ppt/media/image1.tif', tiff);
    const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('text');
    zip.file('ppt/slides/_rels/slide1.xml.rels', rels.replace('image1.jpg', 'image1.tif'));
    deckFixture('noise-tiff.pptx', await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
    // The TIFF alone fits 40 MiB; the PNG made from it as well does not.
    const tight = await outcomeOf('pptx-html', 'noise-tiff.pptx', { EASYCONVERT_MAX_DOCUMENT_MEDIA_BYTES: String(40 * MIB) });
    expect(tight.error?.name).toBe('DecompressionLimitError');
    expect(tight.error?.message).toMatch(/A copy of ZIP entry 'ppt\/media\/image1\.tif' would exceed the decoded-byte budget of 41943040 bytes/);
    const roomy = await outcomeOf('pptx-html', 'noise-tiff.pptx', { EASYCONVERT_MAX_DOCUMENT_MEDIA_BYTES: String(96 * MIB) });
    expect(roomy.error).toBeNull();
    expect(roomy.pictures).toHaveLength(1);
  });

  it('counts a cropped copy of a picture against the media budget', async () => {
    const jpeg = await makeNoisyJpeg();
    const zip = await JSZip.loadAsync(await buildPptxWithJpeg(jpeg));
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('text');
    zip.file('ppt/slides/slide1.xml', slide.replace('<a:blip r:embed="rId2"/>', '<a:blip r:embed="rId2"/><a:srcRect l="10000" t="10000"/>'));
    const deck = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const withBudget = async (bytes: number): Promise<unknown> => {
      const original = process.env.EASYCONVERT_MAX_DOCUMENT_MEDIA_BYTES;
      process.env.EASYCONVERT_MAX_DOCUMENT_MEDIA_BYTES = String(bytes);
      try {
        return await dispatchConversion(deck, 'pptx', 'html', {}, 'crop.pptx');
      } catch (error) {
        return error;
      } finally {
        if (original === undefined) delete process.env.EASYCONVERT_MAX_DOCUMENT_MEDIA_BYTES;
        else process.env.EASYCONVERT_MAX_DOCUMENT_MEDIA_BYTES = original;
      }
    };
    const tight = await withBudget(jpeg.length + 500);
    expect(tight).toBeInstanceOf(DecompressionLimitError);
    expect((tight as Error).message).toMatch(/A copy of ZIP entry 'ppt\/media\/image1\.jpg' would exceed the decoded-byte budget of \d+ bytes/);
    const roomy = await withBudget(4 * jpeg.length);
    expect((roomy as { buffer: Buffer }).buffer.toString('utf-8')).toContain('data:image/jpeg;base64,');
  });

  it('answers a typed 413 for pictures an HTML page cannot hold, whichever way they add up', () => {
    const picture = Buffer.alloc(200 * MIB);
    const shape = { x: 0, y: 0, width: 10, height: 10, shapeType: 'picture', imageData: picture, imageMimeType: 'image/png' };
    const slides = [{ number: 1, texts: [], shapes: [shape, shape, shape] }];
    const failure = (() => {
      try {
        return generateHtmlFromSlides(slides as never, 'deck');
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as PayloadLimitError).status).toBe(413);
    expect((failure as Error).message).toContain(`more than ${HTML_MAX_EMBEDDED_BASE64_CHARS} base64 characters`);
  });

  it('keeps the 128 MiB cap of a DOCX XML part and the 64 MiB cap of its pictures', async () => {
    const jpeg = await makeNoisyJpeg();
    const zip = await JSZip.loadAsync(await buildDocxWithJpeg(jpeg));
    const styles = await zip.file('word/styles.xml')!.async('text');
    zip.file('word/styles.xml', styles.replace('</w:styles>', `<!--${' '.repeat(70 * MIB)}--></w:styles>`), { compression: 'DEFLATE' });
    const docx = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const result = await dispatchConversion(docx, 'docx', 'txt', {}, 'styles.docx');
    expect(result.buffer.toString('utf-8')).toContain('Findings');

    zip.file('word/media/image1.jpg', Buffer.concat([jpeg, Buffer.alloc(70 * MIB, 0x5a)]), { compression: 'STORE' });
    const oversized = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const failure = await dispatchConversion(oversized, 'docx', 'txt', {}, 'picture.docx').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toMatch(/"word\/media\/image1\.jpg" declares \d+ bytes, more than the 67108864 byte limit/);
  });
});

describe('large parsed parts: worksheets take the workbook budget, content XML 128 MiB', () => {
  const ROWS = 2000;
  const WORKBOOK_XML =
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const RELS = '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>';

  /** A workbook whose one sheet holds `ROWS` rows (a number and a shared string each) inside a part padded with a comment to `partBytes`. */
  async function workbookWithSheetOf(partBytes: number): Promise<Buffer> {
    const rows = Array.from(
      { length: ROWS },
      (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index + 1}</v></c><c r="B${index + 1}" t="s"><v>0</v></c></row>`
    ).join('');
    const head = `<worksheet><sheetData>${rows}</sheetData><!--`;
    const tail = '--></worksheet>';
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('xl/workbook.xml', WORKBOOK_XML);
    zip.file('xl/_rels/workbook.xml.rels', RELS);
    zip.file('xl/sharedStrings.xml', '<sst><si><t>shared text</t></si></sst>');
    zip.file('xl/worksheets/sheet1.xml', head + ' '.repeat(partBytes - head.length - tail.length) + tail);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  function pythonReads(script: string, file: string): string {
    return execFileSync('python3', ['-c', script, file], { encoding: 'utf-8' }).trim();
  }

  it('converts a workbook with a 70 MiB sheet part to csv, html and json, as it did before the part cap', async () => {
    const workbook = await workbookWithSheetOf(70 * MIB);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'big-sheet-'));
    try {
      const csv = await dispatchConversion(workbook, 'xlsx', 'csv', {}, 'big.xlsx');
      const csvFile = path.join(dir, 'out.csv');
      fs.writeFileSync(csvFile, csv.buffer);
      expect(
        pythonReads(
          'import csv,sys\nrows=list(csv.reader(open(sys.argv[1],newline="",encoding="utf-8")))\nprint(len(rows),rows[0],rows[-1])',
          csvFile
        )
      ).toBe(`${ROWS} ['1', 'shared text'] ['${ROWS}', 'shared text']`);

      const json = await dispatchConversion(workbook, 'xlsx', 'json', {}, 'big.xlsx');
      const jsonFile = path.join(dir, 'out.json');
      fs.writeFileSync(jsonFile, json.buffer);
      expect(pythonReads('import json,sys\nd=json.load(open(sys.argv[1],encoding="utf-8"))\nprint(len(d))', jsonFile)).toBe(String(ROWS - 1)); // the first row names the columns

      const html = await dispatchConversion(workbook, 'xlsx', 'html', {}, 'big.xlsx');
      expect(html.buffer.toString('utf-8').split('shared text').length - 1).toBe(ROWS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers a typed 413 for a sheet part of 300 MiB', async () => {
    const zeros = await compressZeros(300 * MIB, 'rawDeflate');
    const workbook = craftZip([
      { name: '[Content_Types].xml', deflated: zlib.deflateRawSync('<Types/>'), declaredSize: 8 },
      { name: 'xl/workbook.xml', deflated: zlib.deflateRawSync(WORKBOOK_XML), declaredSize: WORKBOOK_XML.length },
      { name: 'xl/_rels/workbook.xml.rels', deflated: zlib.deflateRawSync(RELS), declaredSize: RELS.length },
      { name: 'xl/worksheets/sheet1.xml', deflated: zeros, declaredSize: 300 * MIB },
    ]);
    const failure = await dispatchConversion(workbook, 'xlsx', 'csv', {}, 'huge.xlsx').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DecompressionLimitError);
    expect((failure as DecompressionLimitError).status).toBe(413);
    expect((failure as Error).message).toMatch(/ZIP entry 'xl\/worksheets\/sheet1\.xml' decodes to more than the limit of 268435456 bytes/);
  });

  /** A workbook of two sheets, each a part of `sheetBytes` bytes (one row and a comment of spaces). */
  async function workbookOfTwoSheets(sheetBytes: number): Promise<Buffer> {
    const head = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData><!--';
    const tail = '--></worksheet>';
    const sheet = await compressPadded(head, sheetBytes - head.length - tail.length, tail);
    const text = (content: string) => ({ deflated: zlib.deflateRawSync(content), declaredSize: Buffer.byteLength(content) });
    return craftZip([
      { name: '[Content_Types].xml', ...text('<Types/>') },
      {
        name: 'xl/workbook.xml',
        ...text(
          '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="One" sheetId="1" r:id="rId1"/><sheet name="Two" sheetId="2" r:id="rId2"/></sheets></workbook>'
        ),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        ...text(
          '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>'
        ),
      },
      { name: 'xl/sharedStrings.xml', ...text('<sst><si><t>shared text</t></si></sst>') },
      { name: 'xl/worksheets/sheet1.xml', deflated: sheet, declaredSize: sheetBytes },
      { name: 'xl/worksheets/sheet2.xml', deflated: sheet, declaredSize: sheetBytes },
    ]);
  }

  it('shares the 256 MiB workbook budget between the sheets', async () => {
    fixture('two-sheets-150.xlsx', await workbookOfTwoSheets(150 * MIB));
    fixture('two-sheets-120.xlsx', await workbookOfTwoSheets(120 * MIB));
    const over = await outcomeOf('xlsx-csv', 'two-sheets-150.xlsx');
    expect(over.error?.name).toBe('DecompressionLimitError');
    expect(over.error?.status).toBe(413);
    expect(over.error?.message).toMatch(/ZIP entry 'xl\/worksheets\/sheet2\.xml' would exceed the decoded-byte budget of 268435456 bytes/);
    const within = await outcomeOf('xlsx-csv', 'two-sheets-120.xlsx');
    expect(within.error).toBeNull();
    expect(within.size).toBeGreaterThan(0);
  });

  it('converts a deck whose slide XML is 100 MiB', async () => {
    const zip = await JSZip.loadAsync(await buildPptxWithJpeg(await makeNoisyJpeg()));
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('text');
    zip.file('ppt/slides/slide1.xml', slide.replace('</p:sld>', `<!--${' '.repeat(100 * MIB)}--></p:sld>`));
    const deck = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const result = await dispatchConversion(deck, 'pptx', 'txt', {}, 'slide.pptx');
    expect(result.buffer.toString('utf-8')).toBe('--- Slide 1 ---\nQuarterly results');
  });
});
