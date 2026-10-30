import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { isCalibreEbookTarget } from '../src/lib/conversions/calibre-ebook-targets';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { readRocketBook } from '../src/lib/conversions/office/rocketbook-reader';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { calibreBinary, textOfCalibreTarget } from './helpers/calibre-books';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * The two Rocket eBook files of the Open Preservation Foundation format corpus (written by calibre 0.8.57 and 0.9.0,
 * bench/realworld/manifest.json). The oracle is calibre, the converter the reference service uses for .rb:
 * `ebook-convert book.rb book.txt` (calibre 9.17.0, run once on a Linux VM) gives the 659 words below for both files, and the
 * SHA-256 of that word sequence is pinned here. Where `ebook-convert` is installed it is run again and compared live. The
 * pinned phrases are read from the HTML inside the file's deflate chunks by Python's zlib, not by the code under test.
 */

const SAMPLES = [
  { id: 'opf-lorem-ipsum-0857.rb', title: 'Lorem Ipsum', author: 'Andrew Jackson' },
  { id: 'opf-lorem-ipsum-090.rb', title: undefined, author: 'Unknown' },
] as const;

const CALIBRE_WORD_COUNT = 659;
const CALIBRE_WORDS_SHA256 = '18d55ba6b98a43cd1da4ab39ff0c550a461b473f8e5d70ce8c69526a48400fac';
const PHRASES = ['variatio ipsius', 'lorem ipsum dolor sit amet consectetur adipiscing elit', 'to the extent possible under law andrew jackson has waived all copyright'];
const FIRST_WORDS = ['variatio', 'ipsius', 'lorem', 'ipsum', 'dolor', 'sit'];
const LAST_WORDS = ['or', 'neighboring', 'rights', 'to', 'this', 'work'];
const CONVERSION_TIMEOUT_MS = 120_000;

const pdftotextMissing = skipWithoutTools('pdftotext');
const calibreTool = calibreBinary;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function digestOf(words: readonly string[]): string {
  return createHash('sha256').update(words.join(' ')).digest('hex');
}

function stripMarkup(markup: string): string {
  return markup
    .replace(/<(head|script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

async function epubWords(epub: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(epub);
  const documents = Object.keys(zip.files).filter((name) => /\.x?html$/.test(name) && !/nav\.x?html$/.test(name));
  const texts = await Promise.all(documents.map(async (name) => stripMarkup((await zip.file(name)?.async('string')) ?? '')));
  return wordsOf(texts.join(' '));
}

function calibreWords(book: Buffer, target: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibre-rb-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.rb'), book);
    execFileSync(calibreTool as string, [path.join(dir, 'in.rb'), path.join(dir, `out.${target}`)], { stdio: 'ignore', timeout: CONVERSION_TIMEOUT_MS });
    return wordsOf(fs.readFileSync(path.join(dir, `out.${target}`), 'utf-8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(SAMPLES)('the real Rocket eBook file $id', ({ id, title, author }) => {
  it('is read with the metadata and the page that calibre reads', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    const book = readRocketBook(bytes);
    expect({ title: book.title, authors: book.authors }).toEqual({ title, authors: [author] });
    expect(book.pages.map((page) => page.name)).toEqual(['index.html']);
    expect(wordsOf(stripMarkup(book.pages[0].html))).toHaveLength(CALIBRE_WORD_COUNT);
  });

  it('gives the word sequence of calibre as plain text', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    const words = wordsOf((await convertFile(bytes, 'rb', 'txt', {}, id)).buffer.toString('utf-8'));
    expect(words).toHaveLength(CALIBRE_WORD_COUNT);
    expect(words.slice(0, FIRST_WORDS.length)).toEqual(FIRST_WORDS);
    expect(words.slice(-LAST_WORDS.length)).toEqual(LAST_WORDS);
    expect(digestOf(words)).toBe(CALIBRE_WORDS_SHA256);
    const text = words.join(' ');
    for (const phrase of PHRASES) expect(text).toContain(phrase);
  });

  // skip-ok: the pinned digest of the test above is the oracle that always runs; this second run needs calibre, which only some hosts have
  it.skipIf(calibreTool === null)('gives the words that calibre writes for the same file, run live', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    const ours = wordsOf((await convertFile(bytes, 'rb', 'txt', {}, id)).buffer.toString('utf-8'));
    expect(ours).toEqual(calibreWords(bytes, 'txt'));
  });

  it('is written to every target the registry advertises, each holding the words of the book', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    for (const target of FORMAT_REGISTRY.rb.targetFormats.filter((candidate) => !isCalibreEbookTarget(candidate))) {
      const output = await convertFile(bytes, 'rb', target, {}, id);
      expect(output.filename, target).toBe(`${id.replace(/\.rb$/, '')}.${target}`);
      let words: string[] | undefined;
      if (target === 'txt') words = wordsOf(output.buffer.toString('utf-8'));
      if (target === 'html') words = wordsOf(stripMarkup(output.buffer.toString('utf-8')));
      if (target === 'epub') words = await epubWords(output.buffer);
      if (target === 'rtf') words = wordsOf(output.buffer.toString('latin1'));
      if (target === 'zip') {
        const entries = await JSZip.loadAsync(output.buffer);
        const names = Object.keys(entries.files);
        expect(names, target).toHaveLength(1);
        expect(Buffer.from(await entries.files[names[0]].async('uint8array')).equals(bytes), target).toBe(true);
        continue;
      }
      if (target === 'pdf') continue;
      const text = (words ?? []).join(' ');
      for (const phrase of PHRASES) expect(text, `${target}: ${phrase}`).toContain(phrase);
      if (target === 'epub' || target === 'html' || target === 'txt') expect(digestOf(words ?? []), target).toBe(CALIBRE_WORDS_SHA256);
    }
  }, CONVERSION_TIMEOUT_MS);

  // skip-ok: the five books are written by calibre, which only some hosts have; the suite names it in strict mode
  it.skipIf(skipUnless('ebook-convert', calibreTool !== null))('is written to the Palm, Kindle, Sony and Open eBook targets, each read back with the words of the book', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    for (const target of FORMAT_REGISTRY.rb.targetFormats.filter(isCalibreEbookTarget)) {
      const output = await dispatchConversion(bytes, 'rb', target, {}, id);
      expect(output.filename, target).toBe(`${id.replace(/\.rb$/, '')}.${target}`);
      const text = wordsOf(await textOfCalibreTarget(output.buffer, target)).join(' ');
      for (const phrase of PHRASES) expect(text, `${target}: ${phrase}`).toContain(phrase);
    }
  }, CONVERSION_TIMEOUT_MS);

  it.skipIf(pdftotextMissing)('is written to a PDF whose text Poppler reads as the words of the book', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    const pdf = (await convertFile(bytes, 'rb', 'pdf', {}, id)).buffer;
    const words = wordsOf(extractTextWithExternalPdftotext(pdf) ?? '');
    expect(words).toHaveLength(CALIBRE_WORD_COUNT);
    expect(digestOf(words)).toBe(CALIBRE_WORDS_SHA256);
  }, CONVERSION_TIMEOUT_MS);
});

/**
 * A file written by calibre 9.17.0 (`ebook-convert book.html book.rb`) from an HTML book of 3016 words with a picture, two
 * heading levels, a list and non-ASCII text: it has several deflate chunks and a PNG, which the corpus files lack. Its
 * words are those of `ebook-convert book.rb book.txt`, pinned by digest.
 */
const RICH_FIXTURE = path.join(__dirname, 'fixtures', 'ebooks', 'rocketbook-calibre-9.17-rich.rb');
const RICH_WORD_COUNT = 3016;
const RICH_WORDS_SHA256 = 'd44bdcf0a915fbe7572e9575adf05eaa4a620f22b21edc27a15e19c5e293f1f3';

describe('a Rocket eBook written by calibre with a picture and several chunks', () => {
  const book = fs.readFileSync(RICH_FIXTURE);

  it('is read with its metadata, its page of several chunks and its picture', () => {
    const read = readRocketBook(book);
    expect({ title: read.title, authors: read.authors }).toEqual({ title: 'Rich Book', authors: ['Test Author'] });
    expect(read.pages.map((page) => page.name)).toEqual(['index.html']);
    expect(read.pages[0].html.length).toBeGreaterThan(4096 * 4);
    expect(read.image('0.png')?.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('gives the word sequence of calibre as plain text', async () => {
    const words = wordsOf((await convertFile(book, 'rb', 'txt', {}, 'rich.rb')).buffer.toString('utf-8'));
    expect(words).toHaveLength(RICH_WORD_COUNT);
    expect(digestOf(words)).toBe(RICH_WORDS_SHA256);
  });

  // skip-ok: the pinned digest of the test above is the oracle that always runs; this second run needs calibre, which only some hosts have
  it.skipIf(calibreTool === null)('gives the words that calibre writes for the same file, run live', async () => {
    const ours = wordsOf((await convertFile(book, 'rb', 'txt', {}, 'rich.rb')).buffer.toString('utf-8'));
    expect(ours).toEqual(calibreWords(book, 'txt'));
  });

  it('is written to an EPUB with the three chapters the headings make and the picture', async () => {
    const epub = (await convertFile(book, 'rb', 'epub', {}, 'rich.rb')).buffer;
    expect(digestOf(await epubWords(epub))).toBe(RICH_WORDS_SHA256);
    const zip = await JSZip.loadAsync(epub);
    const names = Object.keys(zip.files);
    expect(names.filter((name) => /chapter\d+\.xhtml$/.test(name))).toHaveLength(3);
    const image = names.find((name) => name.endsWith('.png')) as string;
    expect((await zip.file(image)?.async('uint8array'))?.length).toBe(readRocketBook(book).image('0.png')?.length);
  });

  it('is written to HTML with its headings and the picture inline', async () => {
    const html = (await convertFile(book, 'rb', 'html', {}, 'rich.rb')).buffer.toString('utf-8');
    expect(html.match(/<h1[ >]/g)).toHaveLength(2);
    expect(html.match(/<h2[ >]/g)).toHaveLength(1);
    expect(html).toMatch(/<img [^>]*src="data:image\/png;base64,/);
    expect(digestOf(wordsOf(stripMarkup(html)))).toBe(RICH_WORDS_SHA256);
  });
});
