import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { CALIBRE_ONLY_SOURCES } from '../src/lib/conversions/calibre-ebook-targets';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requiresNativeEngine } from '../src/lib/conversions/native-engine-pairs';
import { assertNotSpoofedFile } from '../src/lib/security/file-guard';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { enginesForPair } from '../src/worker/engine-registry';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { calibreBinary, normalized, textOfCalibreTarget } from './helpers/calibre-books';
import { extractTextWithExternalPdftotext, requireOracleTool } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { sofficeConvert } from './helpers/soffice-office';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { withMissingBinary } from './helpers/native-tools';

/**
 * CHM, LIT and TCR books to the e-book formats, PDF, RTF and text (docs/policy-decisions.md, "CHM, LIT and TCR books"): calibre's
 * `ebook-convert` reads the three containers and writes every target, as the reference's engine does. The real files are the
 * Microsoft Reader and Compiled HTML Help files of the real-world corpus and a Psion TCR book written by calibre from public text
 * (tests/fixtures/ebooks/PROVENANCE). The oracles are not calibre: 7-Zip unpacks a CHM, the TCR container is decoded by a reader
 * written here from its layout, the EPUB is read as a ZIP, the PDF by Poppler, the RTF by LibreOffice, the Palm books by the
 * Palm database reader of the tests, and LRF by `lrf2lrs`. SNB is not offered: the calibre of the image reads no SNB file.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'ebooks');
const CONVERSION_TIMEOUT_MS = 300_000;
const SOURCES = ['chm', 'lit', 'tcr'] as const;
const TARGETS = ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'] as const;
const calibreMissing = skipUnless('ebook-convert', calibreBinary !== null);
const sevenZipMissing = skipWithoutTools('7z');
const pdfToolsMissing = skipWithoutTools('pdftotext');
const sofficeMissing = skipWithoutTools('soffice');

/** The words of a text, lower case, letters and digits. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The share of the distinct words of `expected` that `actual` holds. */
function recall(expected: readonly string[], actual: readonly string[]): number {
  const held = new Set(actual);
  const wanted = [...new Set(expected)];
  return wanted.filter((word) => held.has(word)).length / wanted.length;
}

/** The words of the pages of a CHM as 7-Zip unpacks it: the text of every HTML page, without markup and scripts. */
function wordsOfChmPages(chm: Buffer): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chm-oracle-'));
  try {
    fs.writeFileSync(path.join(dir, 'book.chm'), chm);
    execFileSync(requireOracleTool('7z'), ['x', '-y', `-o${path.join(dir, 'pages')}`, path.join(dir, 'book.chm')], { stdio: 'ignore' });
    const words: string[] = [];
    const pending = [path.join(dir, 'pages')];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else if (/\.html?$/i.test(entry.name)) {
          const markup = fs.readFileSync(full, 'latin1').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
          words.push(...wordsOf(markup.replace(/&nbsp;|&#160;/g, ' ')));
        }
      }
    }
    return words;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The text of a Psion TCR book, read from the layout of the container: the signature `!!8-Bit!!`, a dictionary of 256 strings (one length
 * byte and that many bytes each), then the text as one dictionary index per byte.
 */
export function tcrText(book: Buffer): string {
  expect(book.subarray(0, 9).toString('latin1')).toBe('!!8-Bit!!');
  let at = 9;
  const dictionary: Buffer[] = [];
  for (let index = 0; index < 256; index++) {
    const length = book[at];
    dictionary.push(book.subarray(at + 1, at + 1 + length));
    at += 1 + length;
  }
  return Buffer.concat([...book.subarray(at)].map((index) => dictionary[index])).toString('utf-8');
}

/** The text of the pages of an EPUB in reading order, from the package document: the ZIP is read without calibre. */
async function epubText(epub: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(epub);
  const names = Object.keys(zip.files);
  expect(names[0], 'the first entry of an EPUB is its media type').toBe('mimetype');
  expect(await zip.file('mimetype')?.async('string')).toBe('application/epub+zip');
  const container = (await zip.file('META-INF/container.xml')?.async('string')) ?? '';
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1] ?? '';
  const opf = (await zip.file(opfPath)?.async('string')) ?? '';
  expect(opf).toContain('<spine');
  const base = path.posix.dirname(opfPath);
  const manifest = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map((item) => [/\bid="([^"]+)"/.exec(item[0])?.[1] ?? '', /\bhref="([^"]+)"/.exec(item[0])?.[1] ?? ''] as const));
  const pages: string[] = [];
  for (const itemref of opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)) {
    const href = manifest.get(itemref[1]) ?? '';
    const markup = (await zip.file(path.posix.join(base, decodeURIComponent(href)))?.async('string')) ?? '';
    pages.push(markup.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '));
  }
  return pages.join(' ');
}

/** The text of the HTML pages of an OEB package delivered as a ZIP. */
async function oebPagesText(book: Buffer): Promise<string> {
  const pages = Object.values((await JSZip.loadAsync(book)).files).filter((file) => /\.x?html?$/i.test(file.name));
  expect(pages.length).toBeGreaterThan(0);
  const markup = await Promise.all(pages.map((page) => page.async('string')));
  return markup.map((page) => page.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')).join(' ');
}

/** The words of a book of any target, by a reader that is not calibre's own writer. */
async function wordsOfTarget(book: Buffer, target: string): Promise<string[]> {
  if (target === 'epub') return wordsOf(await epubText(book));
  if (target === 'txt') return wordsOf(book.toString('utf-8'));
  if (target === 'pdf') return wordsOf(extractTextWithExternalPdftotext(book) ?? '');
  if (target === 'rtf') return wordsOf(sofficeConvert(book, 'rtf', 'txt:Text', 'txt').toString('utf-8'));
  if (target === 'oeb') return wordsOf(await oebPagesText(book));
  return wordsOf(await textOfCalibreTarget(book, target));
}

const LOREM = 'variatio ipsius lorem ipsum dolor sit amet consectetur adipiscing elit proin lacinia cursus congue mauris ac nibh nec tortor tempor posuere';

describe('the pairs of the books only calibre reads', () => {
  it.each(SOURCES)('%s is offered for every target calibre writes, and still as a ZIP of its files', (source) => {
    expect([...FORMAT_REGISTRY[source].targetFormats].sort()).toEqual(['zip', ...TARGETS].sort());
  });

  it('does not offer SNB, whose books the calibre of the image cannot read', () => {
    expect(FORMAT_REGISTRY.snb.targetFormats).toEqual(['zip']);
  });

  it.each(SOURCES.flatMap((source) => TARGETS.map((target) => [source, target] as const)))('%s -> %s is a native pair with calibre as its only engine', (source, target) => {
    expect(requiresNativeEngine(source, target)).toBe(true);
    expect(enginesForPair(source, target)).toEqual([{ id: 'calibre', default: true }]);
  });

  it.each(SOURCES)('keeps %s to a ZIP with the archive route, not calibre', (source) => {
    expect(requiresNativeEngine(source, 'zip')).toBe(false);
    expect([...CALIBRE_ONLY_SOURCES]).toContain(source);
  });

  it.each(SOURCES.flatMap((source) => TARGETS.map((target) => [source, target] as const)))('%s -> %s answers an unavailable engine on a worker without ebook-convert', async (source, target) => {
    const probe = Buffer.concat([Buffer.from(source === 'chm' ? 'ITSF' : source === 'lit' ? 'ITOLITLS' : '!!8-Bit!!', 'latin1'), Buffer.alloc(64)]);
    const run = withMissingBinary('EBOOK_CONVERT_PATH', () => dispatchConversion(probe, source, target, {}, `book.${source}`));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'ebook-convert' });
  });

  it.each(SOURCES)('refuses a text file named .%s before calibre is asked', (source) => {
    expect(() => assertNotSpoofedFile(Buffer.from('Just some text.\n'), source, `book.${source}`)).toThrow(new RegExp(`^File spoofing rejected for file "book\\.${source}": .* incompatible with declared format "\\.${source}"`));
  });
});

describe.skipIf(calibreMissing)('the books of the real-world corpus and the fixtures, written by calibre', () => {
  const targetsOf = (source: string) => TARGETS.filter((target) => FORMAT_REGISTRY[source].targetFormats.includes(target));

  describe.each(['opf-lorem-ipsum-0857.lit', 'opf-lorem-ipsum-090.lit'])('the Microsoft Reader book %s', (id) => {
    it.skipIf(pdfToolsMissing || sofficeMissing)('is written to every target with the words of the book, each read back by a reader of its own', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const expected = wordsOf(LOREM);
      for (const target of targetsOf('lit')) {
        const result = await dispatchConversion(bytes, 'lit', target, {}, id);
        expect(result.engineUsed, target).toBe('native-calibre');
        expect(result.filename, target).toBe(`${id.replace(/\.lit$/, '')}.${target === 'oeb' ? 'zip' : target}`);
        const words = await wordsOfTarget(result.buffer, target);
        expect(recall(expected, words), `${id} -> ${target}`).toBe(1);
      }
    }, CONVERSION_TIMEOUT_MS);
  });

  describe.each(['tika-admin.chm', 'tika-testchm.chm'])('the Compiled HTML Help file %s', (id) => {
    it.skipIf(sevenZipMissing || pdfToolsMissing || sofficeMissing)('is written to every target with the words 7-Zip finds in its pages', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const expected = wordsOfChmPages(bytes);
      expect(expected.length).toBeGreaterThan(1000);
      for (const target of targetsOf('chm')) {
        const result = await dispatchConversion(bytes, 'chm', target, {}, id);
        expect(result.engineUsed, target).toBe('native-calibre');
        const words = await wordsOfTarget(result.buffer, target);
        // Poppler joins words at the end of a line and reads the page numbers of the PDF, so its reading of the PDF is a little less exact.
        expect(recall(words, expected), `the words of ${id} -> ${target} are in the pages`).toBeGreaterThan(target === 'pdf' ? 0.9 : 0.95);
        expect(recall(expected, words), `the words of the pages are in ${id} -> ${target}`).toBeGreaterThan(0.9);
      }
    }, CONVERSION_TIMEOUT_MS);
  });

  describe('the Psion TCR book of the fixtures', () => {
    const bytes = fs.readFileSync(path.join(FIXTURES, 'book-8bit.tcr'));
    it.skipIf(pdfToolsMissing || sofficeMissing)('is written to every target with the words that its own reader decodes', async () => {
      const expected = wordsOf(tcrText(bytes));
      expect(expected).toContain('variatio');
      for (const target of targetsOf('tcr')) {
        const result = await dispatchConversion(bytes, 'tcr', target, {}, 'book-8bit.tcr');
        expect(result.engineUsed, target).toBe('native-calibre');
        expect(recall(expected, await wordsOfTarget(result.buffer, target)), `tcr -> ${target}`).toBe(1);
      }
    }, CONVERSION_TIMEOUT_MS);

    it('gives the text of the book as it is', async () => {
      const result = await dispatchConversion(bytes, 'tcr', 'txt', {}, 'book-8bit.tcr');
      expect(normalized(result.buffer.toString('utf-8'))).toBe(normalized(tcrText(bytes)));
    }, CONVERSION_TIMEOUT_MS);
  });

  describe('a book that is not what its name says, or that calibre cannot read', () => {
    it('refuses a CHM without a start page with a typed error and no path of the worker', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'mspack-encints-32bit-both.chm');
      const failure = await dispatchConversion(bytes, 'chm', 'epub', {}, 'book.chm').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toMatch(/^calibre could not convert the \.chm file to \.epub: /);
      expect((failure as Error).message).not.toMatch(/\/tmp\/|easyconvert-calibre/);
    }, CONVERSION_TIMEOUT_MS);

    it.each([
      ['lit', Buffer.concat([Buffer.from('ITOLITLS', 'latin1'), Buffer.alloc(200)])],
      ['chm', Buffer.concat([Buffer.from('ITSF', 'latin1'), Buffer.alloc(200)])],
      ['tcr', Buffer.concat([Buffer.from('!!8-Bit!!', 'latin1'), Buffer.alloc(200)])],
    ] as const)('refuses a damaged .%s with a typed conversion error', async (source, damaged) => {
      const failure = await dispatchConversion(damaged, source, 'txt', {}, `book.${source}`).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toMatch(new RegExp(`^calibre could not convert the \\.${source} file to \\.txt`));
    }, CONVERSION_TIMEOUT_MS);

    it('refuses a book cut in half', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'tika-admin.chm');
      const failure = await dispatchConversion(bytes.subarray(0, bytes.length >> 1), 'chm', 'txt', {}, 'cut.chm').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      // calibre 8.5.0 stops on some cuts and writes an empty text file on others, which the route refuses.
      expect((failure as Error).message).toMatch(/^calibre (could not convert the \.chm file to \.txt|wrote no \.txt file for the \.chm file)/);
    }, CONVERSION_TIMEOUT_MS);
  });
});

describe.skipIf(calibreMissing || sevenZipMissing)('a CHM whose pages link to a file of the host', () => {
  const HOSTS_FILE = '/etc/hosts';
  const hostile = fs.readFileSync(path.join(FIXTURES, 'hostile-links.chm'));

  it.each(['epub', 'txt', 'oeb'] as const)('writes the book without the file the links name, as .%s', async (target) => {
    // The probe is meaningful only where the file exists and has a line that the book does not say (any Unix host).
    const sentinel = fs.existsSync(HOSTS_FILE) ? fs.readFileSync(HOSTS_FILE, 'utf-8').split('\n').find((line) => /\S{9,}/.test(line))?.trim() : undefined;
    expect(sentinel, `${HOSTS_FILE} has a line to look for`).toBeDefined();
    const result = await dispatchConversion(hostile, 'chm', target, {}, 'hostile.chm');
    expect(wordsOf(await epubOrText(result.buffer, target)).join(' ')).toContain('visible words of the book');
    const entries = target === 'txt' ? [] : Object.keys((await JSZip.loadAsync(result.buffer)).files);
    expect(entries.filter((name) => /hosts/i.test(name))).toEqual([]);
    const everything = target === 'txt' ? result.buffer : Buffer.concat(await Promise.all(Object.values((await JSZip.loadAsync(result.buffer)).files).filter((file) => !file.dir).map((file) => file.async('nodebuffer'))));
    expect(everything.includes(Buffer.from(sentinel as string)), 'the host file is not in the book').toBe(false);
  }, CONVERSION_TIMEOUT_MS);

  async function epubOrText(book: Buffer, target: string): Promise<string> {
    if (target === 'txt') return book.toString('utf-8');
    return target === 'epub' ? epubText(book) : oebPagesText(book);
  }
});
