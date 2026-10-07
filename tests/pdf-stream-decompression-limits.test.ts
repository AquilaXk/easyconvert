import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { extractStructuredTextFromPdf, extractTextFromPdf } from '../src/lib/conversions/pdf-utils';
import {
  ConversionFailedError,
  CorruptStreamError,
  DecompressionLimitError,
} from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import {
  type CraftObject,
  appendRevision,
  buildPdf,
  flate,
  singlePagePdf,
  textContent,
} from './helpers/pdf-craft';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * Stream decoding in the PDF text extractor: every Flate stream is bounded, only content reachable
 * from the page tree is decoded, and image streams are never decoded for text. The fixtures are
 * hand-written with tests/helpers/pdf-craft.ts, and pdftotext/qpdf are the independent readers.
 */

const MIB = 1024 * 1024;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_REQUEST = 400;
const BOMB_MIB = 128; // above the 64 MiB per-stream cap, about 1000:1 once deflated
const OVER_BUDGET_STREAM_MIB = 60; // below the per-stream cap; five of them pass the 256 MiB budget
const OVER_BUDGET_STREAMS = 5;
/** Hang guard only: the budget stops a bomb in milliseconds; inflating it would take far longer. */
const BOMB_HANG_GUARD_MS = 30_000;
const BOMB_RSS_LIMIT_MIB = 200;
const ORPHAN_MARKER = 'ORPHAN-MARKER-7731';
const SUPERSEDED_MARKER = 'SUPERSEDED-MARKER-4410';

const zeroBomb = zlib.deflateSync(Buffer.alloc(BOMB_MIB * MIB), { level: 9 });
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeTemp(name: string, data: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-limits-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

function pdftotext(pdf: Buffer): string {
  const tool = getOracleToolPath('pdftotext');
  if (!tool) throw new Error('pdftotext is required for this oracle test');
  return execFileSync(tool, [writeTemp('in.pdf', pdf), '-'], { encoding: 'utf8' });
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

async function catchError(run: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectLimitError(err: unknown): void {
  expect(err).toBeInstanceOf(DecompressionLimitError);
  expect((err as DecompressionLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
  expect(err).toBeInstanceOf(ConversionFailedError);
}

async function measure(run: () => Promise<unknown>): Promise<{ err: unknown; ms: number; rssMiB: number }> {
  const rssBefore = process.resourceUsage().maxRSS;
  const started = Date.now();
  const err = await catchError(run);
  const ms = Date.now() - started;
  const rssMiB = (process.resourceUsage().maxRSS - rssBefore) / 1024;
  return { err, ms, rssMiB };
}

describe('PDF Flate bombs are refused with a typed 413', () => {
  const orphanBombPdf = singlePagePdf(flate(textContent('Visible text')), [
    { id: 6, dict: '/Filter /FlateDecode', stream: zeroBomb },
  ]).buffer;
  const contentBombPdf = singlePagePdf(zeroBomb).buffer;

  it('pdf -> md: an unreferenced bomb stream is never decoded for text', async () => {
    const result = await convertFile(orphanBombPdf, 'pdf', 'md', {}, 'orphan-bomb.pdf');
    expect(result.mimeType).toBe('text/markdown');
    expect(result.buffer.toString('utf8')).toContain('Visible text');
  });

  it('pdf -> docx: an unreferenced bomb stream is never decoded for text', async () => {
    const result = await convertFile(orphanBombPdf, 'pdf', 'docx', {}, 'orphan-bomb.pdf');
    expect(result.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    const zip = await JSZip.loadAsync(result.buffer);
    const documentXml = await (zip.file('word/document.xml') as JSZip.JSZipObject).async('string');
    expect(documentXml).toContain('Visible text');
  });

  for (const target of ['md', 'docx']) {
    it(`pdf -> ${target}: a bomb page content stream is refused quickly and cheaply`, async () => {
      const { err, ms, rssMiB } = await measure(() => convertFile(contentBombPdf, 'pdf', target, {}, 'bomb.pdf'));
      expectLimitError(err);
      expect(ms).toBeLessThan(BOMB_HANG_GUARD_MS);
      expect(rssMiB).toBeLessThan(BOMB_RSS_LIMIT_MIB);
    });
  }

  it('refuses a document whose streams together exceed the decoded-byte budget', async () => {
    const chunk = zlib.deflateSync(Buffer.alloc(OVER_BUDGET_STREAM_MIB * MIB), { level: 9 });
    const streamIds = Array.from({ length: OVER_BUDGET_STREAMS }, (_, i) => 10 + i);
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      {
        id: 3,
        dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [${streamIds.map((id) => `${id} 0 R`).join(' ')}]`,
      },
      ...streamIds.map((id): CraftObject => ({ id, dict: '/Filter /FlateDecode', stream: chunk })),
    ];
    const err = await catchError(() => extractStructuredTextFromPdf(buildPdf(objects, 1).buffer));
    expectLimitError(err);
    expect((err as Error).message).toMatch(/document/i);
  });
});

describe('PDF stream decoding fails closed on corrupt data', () => {
  it('maps a corrupt Flate content stream to a typed 400, not a skip', () => {
    const pdf = singlePagePdf(Buffer.from('this is not a zlib stream at all', 'latin1')).buffer;
    let err: unknown;
    try {
      extractTextFromPdf(pdf);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CorruptStreamError);
    expect((err as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
    expect(err).not.toBeInstanceOf(DecompressionLimitError);
  });
});

describe('PDF text comes only from content the page tree reaches', () => {
  const visible = 'VISIBLE-LINE-ONE';

  it('omits an orphan content stream that no page references', () => {
    const pdf = singlePagePdf(flate(textContent(visible)), [
      { id: 6, dict: '/Filter /FlateDecode', stream: flate(textContent(ORPHAN_MARKER, 600)) },
    ]).buffer;
    const text = extractTextFromPdf(pdf);
    expect(text).toContain(visible);
    expect(text).not.toContain(ORPHAN_MARKER);
  });

  oracleTest('matches pdftotext for a document with an orphan content stream', ['pdftotext'], () => {
    const pdf = singlePagePdf(flate(textContent(visible)), [
      { id: 6, dict: '/Filter /FlateDecode', stream: flate(textContent(ORPHAN_MARKER, 600)) },
    ]).buffer;
    const reference = pdftotext(pdf);
    expect(reference).not.toContain(ORPHAN_MARKER);
    expect(words(extractTextFromPdf(pdf))).toEqual(words(reference));
  });

  const revisionOne = singlePagePdf(flate(textContent(SUPERSEDED_MARKER)));
  const revised = appendRevision(
    revisionOne,
    [{ id: 4, dict: '/Filter /FlateDecode', stream: flate(textContent(visible)) }],
    1
  );

  it('uses the newest revision of an object after an incremental update', () => {
    const text = extractTextFromPdf(revised.buffer);
    expect(text).toContain(visible);
    expect(text).not.toContain(SUPERSEDED_MARKER);
  });

  oracleTest('matches pdftotext after an incremental update', ['pdftotext'], () => {
    const reference = pdftotext(revised.buffer);
    expect(reference).not.toContain(SUPERSEDED_MARKER);
    expect(words(extractTextFromPdf(revised.buffer))).toEqual(words(reference));
  });

  const FORM_RESOURCES = '<< /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >>';
  const formObject = (id: number, text: string): CraftObject => ({
    id,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Filter /FlateDecode',
    stream: flate(textContent(text, 500)),
  });

  it('decodes a form XObject that a page draws and skips one that no page draws', () => {
    const pdf = singlePagePdf(
      flate(`${textContent(visible)}/Fm0 Do\n`),
      [formObject(6, 'FORM-DRAWN-TEXT'), formObject(7, ORPHAN_MARKER)],
      { resources: FORM_RESOURCES }
    ).buffer;
    const text = extractTextFromPdf(pdf);
    expect(text).toContain('FORM-DRAWN-TEXT');
    expect(text).toContain(visible);
    expect(text).not.toContain(ORPHAN_MARKER);
  });

  oracleTest('matches pdftotext for page and form XObject text', ['pdftotext'], () => {
    const pdf = singlePagePdf(
      flate(`${textContent(visible)}/Fm0 Do\n`),
      [formObject(6, 'FORM-DRAWN-TEXT'), formObject(7, ORPHAN_MARKER)],
      { resources: FORM_RESOURCES }
    ).buffer;
    expect(words(extractTextFromPdf(pdf)).sort()).toEqual(words(pdftotext(pdf)).sort());
  });

  it('never decodes an image XObject, even one a page draws', () => {
    const image: CraftObject = {
      id: 6,
      dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
      stream: zeroBomb,
    };
    const pdf = singlePagePdf(flate(`${textContent(visible)}/Fm0 Do\n`), [image], {
      resources: FORM_RESOURCES,
    }).buffer;
    expect(extractTextFromPdf(pdf)).toContain(visible);
  });

  it('refuses a form XObject that draws itself', () => {
    const selfReferencing: CraftObject = {
      id: 6,
      dict: '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /Fm0 6 0 R >> >>',
      stream: Buffer.from('/Fm0 Do\n', 'latin1'),
    };
    const pdf = singlePagePdf(flate('/Fm0 Do\n'), [selfReferencing], { resources: FORM_RESOURCES }).buffer;
    const err = (() => {
      try {
        extractTextFromPdf(pdf);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(PdfStructureError);
    expect((err as PdfStructureError).message).toMatch(/draws itself/);
  });

  const qpdf = getOracleToolPath('qpdf');
  const compressedStructure = (pdf: Buffer): Buffer => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-qpdf-'));
    tempDirs.push(dir);
    const input = path.join(dir, 'in.pdf');
    const output = path.join(dir, 'out.pdf');
    fs.writeFileSync(input, pdf);
    execFileSync(qpdf as string, ['--object-streams=generate', '--stream-data=compress', input, output]);
    return fs.readFileSync(output);
  };

  oracleTest('reads a page tree stored in object streams (qpdf-generated)', ['qpdf', 'pdftotext'], () => {
    const source = singlePagePdf(flate(textContent(visible)), [
      { id: 6, dict: '/Filter /FlateDecode', stream: flate(textContent(ORPHAN_MARKER, 600)) },
    ]).buffer;
    const packed = compressedStructure(source);
    expect(packed.includes(Buffer.from('/Type /ObjStm')) || packed.includes(Buffer.from('/Type/ObjStm'))).toBe(true);
    const text = extractTextFromPdf(packed);
    expect(text).toContain(visible);
    expect(text).not.toContain(ORPHAN_MARKER);
    expect(words(text)).toEqual(words(pdftotext(packed)));
  });
});
