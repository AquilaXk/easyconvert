import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ConversionFailedError, EngineMissingError } from '../src/lib/types';
import type { WorkerEngineOptions } from '../src/worker/worker-types';
import { calibreBinary, calibreMetadata, calibreText, lrfText, normalized, oebText } from './helpers/calibre-books';
import { palmDocText, readMobiBook, readPalmDatabase, readPalmDocHeader, recordsStartingWith, wordsOfMarkup } from './helpers/palmdb-reader';
import { skipUnless } from './helpers/strict-skip';

/**
 * The MOBI, AZW3, PDB, LRF and OEB books that calibre's `ebook-convert` writes (docs/policy-decisions.md, "E-book targets
 * written by calibre"), judged by readers that are not the writer:
 *  - the structure of a Palm database book by tests/helpers/palmdb-reader.ts, written from the MobileRead layout (the
 *    database header, PalmDOC compression, the MOBI header, the EXTH records, the KF8 records), which also decompresses
 *    the PalmDOC text of a MOBI or PDB book;
 *  - the text of every format by `ebook-convert` itself (to plain text) and the title by `ebook-meta`;
 *  - an OEB package by its OPF and the XHTML it names.
 * The text of every book must equal the text of the source after NFC normalisation and white space collapse, Hangul and
 * Japanese included. Tests that need calibre are skipped without it (and fail under ORACLE_STRICT_MODE=1); the answers
 * of a worker without it are tests/ebook-calibre-route.test.ts.
 */

const calibreMissing = skipUnless('ebook-convert', calibreBinary !== null);
const CONVERSION_TIMEOUT_MS = 120_000;
/** The names every temporary directory and file of the worker begins with (`easyconvert-calibre-`, `easyconvert-vfs`, `easyconvert_worker_sandbox_`). */
const WORKER_TEMP_PREFIX = 'easyconvert';
const MOBI_HEADER_ENCODING_UTF8 = 65001;
const KF8_VERSION = 8;
const MOBI6_VERSION = 6;
const PALMDOC_LZ77 = 2;
const EXTH_UPDATED_TITLE = 503;
const EXTH_LANGUAGE = 524;
const KF8_EOF_RECORD = Buffer.from([0xe9, 0x8e, 0x0d, 0x0a]);

const TITLE = '한글 테스트';
const PARAGRAPHS = [
  '안녕하세요, 세계. 한글 문장입니다. 가나다라마바사 café naïve.',
  '日本語のテキスト、ひらがなカタカナ。',
  'The quick brown fox jumps over the lazy dog.',
  '두 번째 장의 내용입니다 — “따옴표”와 줄임표…',
];
const LATIN_PARAGRAPHS = ['A short book written in Windows-1252: café, naïve, Zoë — “quotes” and an ellipsis… €5.', 'The quick brown fox jumps over the lazy dog.'];

const expectedText = (paragraphs: readonly string[]): string => normalized(paragraphs.join(' '));
const sourceOf = (paragraphs: readonly string[]): Buffer => Buffer.from(paragraphs.join('\n\n'), 'utf-8');

async function written(source: Buffer, src: string, tgt: string, name = `${TITLE}.${src}`): Promise<Buffer> {
  const result = await dispatchConversion(source, src, tgt, {}, name);
  expect(result.engineUsed, `${src} -> ${tgt}`).toBe('native-calibre');
  expect(result.filename).toBe(`${TITLE}.${tgt === 'oeb' ? 'zip' : tgt}`);
  return result.buffer;
}

function expectTitle(metadata: string): void {
  expect(metadata).toMatch(new RegExp(`^Title\\s*:\\s*${TITLE}\\s*$`, 'm'));
}

describe.skipIf(calibreMissing)('e-books written by calibre', () => {
  const books = new Map<string, Buffer>();
  async function book(tgt: string): Promise<Buffer> {
    let held = books.get(tgt);
    if (!held) {
      held = await written(sourceOf(PARAGRAPHS), 'txt', tgt);
      books.set(tgt, held);
    }
    return held;
  }

  it('MOBI: a Mobipocket 6 Palm database with PalmDOC LZ77 text, UTF-8, the title in EXTH, and the text of the source', async () => {
    const file = await book('mobi');
    const mobi = readMobiBook(file);
    expect([mobi.database.type, mobi.database.creator]).toEqual(['BOOK', 'MOBI']);
    expect(mobi.palmDoc.compression).toBe(PALMDOC_LZ77);
    expect(mobi.encoding).toBe(MOBI_HEADER_ENCODING_UTF8);
    expect(mobi.version).toBe(MOBI6_VERSION);
    expect(mobi.fullName).toBe(TITLE);
    expect(mobi.exth.get(EXTH_UPDATED_TITLE)?.[0].toString('utf-8')).toBe(TITLE);
    expect(mobi.exth.has(EXTH_LANGUAGE)).toBe(true);
    expect(wordsOfMarkup(palmDocText(file).toString('utf-8'))).toBe(expectedText(PARAGRAPHS));
    expect(normalized(calibreText(file, 'mobi'))).toBe(expectedText(PARAGRAPHS));
    expectTitle(calibreMetadata(file, 'mobi'));
  }, CONVERSION_TIMEOUT_MS);

  it('AZW3: a KF8 book with its FDST, index and end records, the title in EXTH, and the text of the source', async () => {
    const file = await book('azw3');
    const azw3 = readMobiBook(file);
    expect([azw3.database.type, azw3.database.creator]).toEqual(['BOOK', 'MOBI']);
    expect(azw3.version).toBe(KF8_VERSION);
    expect(azw3.palmDoc.compression).toBe(PALMDOC_LZ77);
    expect(azw3.encoding).toBe(MOBI_HEADER_ENCODING_UTF8);
    expect(recordsStartingWith(azw3.database, 'FDST')).toHaveLength(1);
    expect(recordsStartingWith(azw3.database, 'FLIS')).toHaveLength(1);
    expect(recordsStartingWith(azw3.database, 'INDX').length).toBeGreaterThanOrEqual(2);
    expect(azw3.database.records.at(-1)?.equals(KF8_EOF_RECORD)).toBe(true);
    expect(azw3.exth.get(EXTH_UPDATED_TITLE)?.[0].toString('utf-8')).toBe(TITLE);
    expect(normalized(calibreText(file, 'azw3'))).toBe(expectedText(PARAGRAPHS));
    expectTitle(calibreMetadata(file, 'azw3'));
  }, CONVERSION_TIMEOUT_MS);

  it('PDB: a PalmDOC book of LZ77 records of up to 4096 bytes, in UTF-8 when its text needs it', async () => {
    const file = await book('pdb');
    const database = readPalmDatabase(file);
    expect([database.type, database.creator]).toEqual(['TEXt', 'REAd']);
    const header = readPalmDocHeader(database.records[0]);
    expect(header.compression).toBe(PALMDOC_LZ77);
    expect(header.recordSize).toBe(4096);
    expect(header.textRecordCount).toBe(database.records.length - 1);
    expect(normalized(palmDocText(file).toString('utf-8'))).toBe(expectedText(PARAGRAPHS));
    expect(normalized(calibreText(file, 'pdb'))).toBe(expectedText(PARAGRAPHS));
  }, CONVERSION_TIMEOUT_MS);

  it('PDB: text that Windows-1252 holds is written in Windows-1252, the PalmDOC code page', async () => {
    const file = await written(sourceOf(LATIN_PARAGRAPHS), 'txt', 'pdb');
    const text = palmDocText(file);
    expect(text.includes(Buffer.from('café', 'latin1'))).toBe(true);
    expect(text.includes(Buffer.from([0x80]))).toBe(true);
    expect(text.includes(Buffer.from('€', 'utf-8'))).toBe(false);
    expect(normalized(calibreText(file, 'pdb'))).toBe(expectedText(LATIN_PARAGRAPHS));
  }, CONVERSION_TIMEOUT_MS);

  it('LRF: a Sony BBeB book whose paragraphs are the paragraphs of the source', async () => {
    const file = await book('lrf');
    expect(file.subarray(0, 8).equals(Buffer.from([0x4c, 0x00, 0x52, 0x00, 0x46, 0x00, 0x00, 0x00]))).toBe(true);
    expect(lrfText(file)).toBe(expectedText(PARAGRAPHS));
    expectTitle(calibreMetadata(file, 'lrf'));
  }, CONVERSION_TIMEOUT_MS);

  it('OEB: a ZIP of an OPF package and the XHTML it lists, with the text of the source', async () => {
    const file = await book('oeb');
    const zip = await JSZip.loadAsync(file);
    const opfName = Object.keys(zip.files).find((name) => name.endsWith('.opf'));
    expect(opfName).toBeDefined();
    const opf = await (zip.file(opfName as string) as JSZip.JSZipObject).async('string');
    expect(opf).toContain(`<dc:title>${TITLE}</dc:title>`);
    const documents = [...opf.matchAll(/<item\b[^>]*\bhref="([^"]+)"[^>]*media-type="application\/xhtml\+xml"/g)].map((match) => decodeURIComponent(match[1]));
    expect(documents.length).toBeGreaterThan(0);
    const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)].length;
    expect(spine).toBe(documents.length);
    const markup = await Promise.all(documents.map(async (href) => (await (zip.file(href) as JSZip.JSZipObject).async('string'))));
    expect(markup.every((page) => page.includes('<html') && page.includes('<body'))).toBe(true);
    expect(wordsOfMarkup(markup.join(' '))).toBe(expectedText(PARAGRAPHS));
  }, CONVERSION_TIMEOUT_MS);

  it.each([
    ['mobi', 'azw3'],
    ['azw3', 'mobi'],
    ['mobi', 'pdb'],
    ['pdb', 'lrf'],
    ['lrf', 'mobi'],
    ['mobi', 'oeb'],
  ])('a %s book converts to %s directly, with the text it holds', async (src, tgt) => {
    const source = await written(sourceOf(src === 'pdb' ? LATIN_PARAGRAPHS : PARAGRAPHS), 'txt', src);
    const converted = await written(source, src, tgt);
    const text = tgt === 'oeb' ? await oebText(converted) : tgt === 'lrf' ? lrfText(converted) : normalized(calibreText(converted, tgt));
    expect(text).toBe(expectedText(src === 'pdb' ? LATIN_PARAGRAPHS : PARAGRAPHS));
  }, CONVERSION_TIMEOUT_MS);

  it('a damaged book is a typed conversion failure, not a missing engine and not a server error', async () => {
    const file = await book('mobi');
    const error = await dispatchConversion(file.subarray(0, 300), 'mobi', 'azw3', {}, 'broken.mobi').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error).not.toBeInstanceOf(EngineMissingError);
    expect((error as Error).message).toMatch(/^calibre could not convert the \.mobi file to \.azw3/);
  }, CONVERSION_TIMEOUT_MS);

  it.each(['mobi', 'pdb', 'oeb'])('leaves nothing of a .%s conversion in the temporary directory', async (tgt) => {
    // A temporary directory of the test's own, so that the job directories of other test files running at the same time are not counted;
    // the result is written outside it, so that what is left in it is only what the route itself failed to remove. Only the worker's own
    // entries are counted: the test runner may make a cache directory of its own (`tsx-<uid>`) in the temporary directory on a first import.
    const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calibre-private-tmp-'));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibre-output-'));
    const previous = process.env.TMPDIR;
    try {
      process.env.TMPDIR = privateTmp;
      try {
        await dispatchConversion(sourceOf(LATIN_PARAGRAPHS), 'txt', tgt, { outputPath: path.join(outputDir, `out.${tgt}`) } as WorkerEngineOptions, `${TITLE}.txt`);
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
      }
      expect(fs.readdirSync(privateTmp).filter((name) => name.startsWith(WORKER_TEMP_PREFIX))).toEqual([]);
      expect(fs.readdirSync(outputDir)).toHaveLength(1);
    } finally {
      fs.rmSync(privateTmp, { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }, CONVERSION_TIMEOUT_MS);
});
