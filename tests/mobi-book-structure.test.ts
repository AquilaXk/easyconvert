import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { ConversionFailedError } from '../src/lib/types';
import { elementsOf, headingsOf, inspectEpub, packagedFile } from './helpers/epub-inspect';
import { requireOracleTool } from './helpers/differential-oracle';
import { runEpubcheck } from './helpers/epubcheck';
import { buildMobi, palmDocCompress } from './helpers/mobi-builder';
import { oracleTest } from './helpers/oracle-test';

/**
 * A MOBI book keeps its structure when it becomes an EPUB or a PDF: the chapters its table of contents names are headings
 * and content documents, the table of contents page itself is left to the navigation document, the pictures its markup
 * numbers (`recindex`) and its cover are packaged with their bytes, and the title, author and language of its headers reach
 * the package. The fixtures are written by hand to the MobileRead notes (tests/helpers/mobi-builder.ts) and by the
 * reference converter (bench/corpus/ebooks/book.mobi); expectations come from the text they were authored from, the EPUB is
 * read with parse5 and validated with EPUBCheck, the PDF with poppler. Damaged books convert or fail with a typed error.
 */

const CORPUS = path.join(__dirname, '..', 'bench', 'corpus');
const PHOTO = fs.readFileSync(path.join(CORPUS, 'photo-a.jpg'));
const PIXEL = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#3366cc' } }).png().toBuffer();
const ROUNDS = 150;
const CHAPTERS = ['Chapter One', 'Chapter Two', 'Chapter Three'];

const metadataOf = (opf: string): { title?: string; creator?: string; language?: string } => {
  const field = (tag: string): string | undefined => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(opf)?.[1];
  return { title: field('dc:title'), creator: field('dc:creator'), language: field('dc:language') };
};

/** Markup with a `filepos` table of contents at its end: offsets are those of the chapter paragraphs, as bytes. */
function markupWithToc(chapters: readonly string[], extraBody = ''): Buffer {
  const placeholder = '0000000000';
  const head = `<html><head><guide><reference type="toc" title="Table of Contents" filepos=${placeholder} /></guide></head><body>`;
  const chapter = (title: string, index: number): string =>
    `<p height="2em" width="0pt"><font size="6"><b>${title}</b></font></p>${index === 0 ? '<p><img recindex="00001" width="8" height="8"></img></p>' : ''}<p align="justify">Text of ${title.toLowerCase()} &amp; more.</p><mbp:pagebreak/>`;
  const body = chapters.map(chapter).join('') + extraBody;
  const tocPage = (positions: number[]): string => `<mbp:pagebreak/>${chapters.map((title, i) => `<p height="0pt" width="-14pt"><a filepos=${String(positions[i]).padStart(10, '0')}>${title}</a></p>`).join('')}<mbp:pagebreak/></body></html>`;
  const draft = Buffer.from(head + body + tocPage(chapters.map(() => 0)), 'utf-8');
  const positions = chapters.map((title) => draft.indexOf(`<p height="2em" width="0pt"><font size="6"><b>${title}</b>`));
  const tocStart = draft.indexOf('<mbp:pagebreak/><p height="0pt"');
  return Buffer.from((head + body + tocPage(positions)).replace(placeholder, String(tocStart).padStart(10, '0')), 'utf-8');
}

function records(markup: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < markup.length; at += 4096) out.push(palmDocCompress(markup.subarray(at, at + 4096)));
  return out;
}

function book(options: { markup?: Buffer; images?: Buffer[]; cover?: number | null; title?: string; extra?: Partial<Parameters<typeof buildMobi>[0]> } = {}): Buffer {
  const markup = options.markup ?? markupWithToc(CHAPTERS);
  const exth = [
    { type: 100, data: Buffer.from('Ann Writer') },
    { type: 503, data: Buffer.from(options.title ?? 'The Fixture Book') },
    { type: 524, data: Buffer.from('en') },
    ...(options.cover === null ? [] : [{ type: 201, data: Buffer.from([0, 0, 0, options.cover ?? 1]) }]),
  ];
  return buildMobi({ textRecords: records(markup), compression: 2, encoding: 65001, textLength: markup.length, exth, fullName: 'Stored full name', images: options.images ?? [PIXEL, PHOTO], ...options.extra });
}

const toEpub = async (input: Buffer) => (await convertFile(input, 'mobi', 'epub', {}, 'book.mobi')).buffer;

describe('MOBI to EPUB', () => {
  it('makes the chapters of the table of contents headings and content documents, and leaves the table of contents page out', async () => {
    const epub = await inspectEpub(await toEpub(book()));
    expect(epub.chapters.flatMap((chapter) => headingsOf(chapter.html))).toEqual(CHAPTERS.map((title) => [1, title]));
    // A cover page, then one document per chapter.
    expect(epub.chapters).toHaveLength(4);
    const all = epub.chapters.map((chapter) => chapter.html).join('\n');
    // Each title is shown once, as a heading: the table of contents page is not a second copy.
    const shown = elementsOf(all, new Set(['h1', 'p', 'a'])).map((element) => element.text);
    for (const title of CHAPTERS) expect(shown.filter((text) => text === title), title).toHaveLength(1);
    expect(all).toContain('Text of chapter two &amp; more.');
    expect(elementsOf(epub.navigation, new Set(['a'])).map((anchor) => anchor.text)).toEqual(CHAPTERS);
  });

  it('packages the picture the markup numbers and the cover the header names, and marks the cover', async () => {
    const epub = await inspectEpub(await toEpub(book()));
    const images = [...epub.manifest].filter(([, item]) => item.mediaType.startsWith('image/'));
    expect(images).toHaveLength(2);
    const bytes = await Promise.all(images.map(([href]) => packagedFile(epub, href)));
    expect(bytes.some((data) => data.equals(PIXEL))).toBe(true);
    expect(bytes.some((data) => data.equals(PHOTO))).toBe(true);
    const cover = images.filter(([, item]) => item.properties.split(' ').includes('cover-image'));
    expect(cover).toHaveLength(1);
    expect((await packagedFile(epub, cover[0][0])).equals(PHOTO)).toBe(true);
    expect(elementsOf(epub.chapters[0].html, new Set(['img']))).toHaveLength(1);
  });

  it('carries the title, author and language of the headers', async () => {
    expect(metadataOf((await inspectEpub(await toEpub(book()))).opf)).toEqual({ title: 'The Fixture Book', creator: 'Ann Writer', language: 'en' });
  });

  it('uses the stored full name when no updated title is given, and the file name when there is neither', async () => {
    const named = await inspectEpub(await toEpub(buildMobi({ ...parts(), fullName: 'Stored full name' })));
    expect(metadataOf(named.opf).title).toBe('Stored full name');
    const bare = await inspectEpub(await toEpub(buildMobi({ ...parts(), fullName: '' })));
    expect(metadataOf(bare.opf).title).toBe('book');
  });

  oracleTest('is valid according to EPUBCheck', ['epubcheck'], async () => {
    const report = runEpubcheck(await toEpub(book()));
    expect(report.messages.filter((message) => ['FATAL', 'ERROR'].includes(message.severity))).toEqual([]);
  }, 180_000);

  it('reads the reference converter\'s book: ten chapters named as the text names them, its picture, its title and author', async () => {
    const mobi = fs.readFileSync(path.join(CORPUS, 'ebooks', 'book.mobi'));
    const titles = fs.readFileSync(path.join(CORPUS, 'ebooks', 'book.gt.txt'), 'utf8').split('\n').filter((line) => /^Chapter \d+: /.test(line));
    expect(titles).toHaveLength(10);
    const epub = await inspectEpub(await toEpub(mobi));
    expect(epub.chapters.flatMap((chapter) => headingsOf(chapter.html)).map(([, text]) => text)).toEqual(titles);
    expect([...epub.manifest].filter(([, item]) => item.mediaType.startsWith('image/'))).toHaveLength(1);
    expect(metadataOf(epub.opf)).toMatchObject({ title: 'The Quiet Harbour Survey', creator: 'Mara Ellison' });
  });
});

function parts(): Parameters<typeof buildMobi>[0] {
  const markup = markupWithToc(CHAPTERS);
  return { textRecords: records(markup), compression: 2, encoding: 65001, textLength: markup.length };
}

describe('MOBI to PDF', () => {
  oracleTest('draws the chapters, the text and both pictures', ['pdftotext', 'pdfimages'], async () => {
    const pdf = (await convertFile(book(), 'mobi', 'pdf', {}, 'book.mobi')).buffer;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-pdf-'));
    try {
      const file = path.join(dir, 'book.pdf');
      fs.writeFileSync(file, pdf);
      const text = execFileSync(requireOracleTool('pdftotext'), [file, '-'], { encoding: 'utf-8' });
      for (const title of CHAPTERS) expect(text).toContain(title);
      expect(text).toContain('Text of chapter three & more.');
      const listing = execFileSync(requireOracleTool('pdfimages'), ['-list', file], { encoding: 'utf-8' }).split('\n').filter((line) => line.trim() !== '');
      expect(listing.length - 2).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a MOBI book whose headers or links lie', () => {
  const converts = async (input: Buffer): Promise<string> => (await inspectEpub(await toEpub(input))).chapters.map((chapter) => chapter.html).join('\n');
  const texts = (html: string): string[] => elementsOf(html, new Set(['p'])).map((paragraph) => paragraph.text).filter((text) => text.startsWith('Text of'));

  it.each([
    ['a picture number beyond the pictures it has', () => book({ markup: markupWithToc(CHAPTERS, '<p><img recindex="00099"></img></p>') })],
    ['a first picture index outside the book', () => book({ extra: { firstImageIndex: 9999 } })],
    ['a first picture index of zero, which is the header record', () => book({ extra: { firstImageIndex: 0 } })],
    ['a picture record that is not a picture', () => book({ images: [Buffer.from('this is not an image at all'), PHOTO], cover: null })],
    ['a full name that lies outside the record', () => book({ extra: { fullNameField: { offset: 0x7fffffff, length: 99 } } })],
    ['a full name length that runs past the record', () => book({ extra: { fullNameField: { offset: 300, length: 0x7fffffff } } })],
    ['a cover offset that names no picture', () => book({ cover: 77 })],
  ])('converts a book with %s, leaving out what it cannot find', async (_name, make) => {
    const html = await converts(make());
    expect(headingsOf(html).map(([, text]) => text)).toEqual(CHAPTERS);
    expect(texts(html)).toEqual(CHAPTERS.map((title) => `Text of ${title.toLowerCase()} & more.`));
  });

  it('ignores the metadata after a record that is cut off or claims more than the header holds', async () => {
    const good = book();
    const at = good.indexOf(Buffer.from('EXTH'));
    const broken = Buffer.from(good);
    broken.writeUInt32BE(0xfffffff0, at + 12 + 4); // length of the first EXTH record
    expect(metadataOf((await inspectEpub(await toEpub(broken))).opf)).toMatchObject({ title: 'Stored full name', creator: undefined });
    const countLies = Buffer.from(good);
    countLies.writeUInt32BE(0xffffffff, at + 8);
    expect(metadataOf((await inspectEpub(await toEpub(countLies))).opf)).toEqual({ title: 'The Fixture Book', creator: 'Ann Writer', language: 'en' });
  });

  it('keeps the text when a table of contents entry points outside the markup, into a tag or twice at one place', async () => {
    const markup = markupWithToc(CHAPTERS).toString('utf-8');
    const lying = markup.replace(/filepos=(\d+)>Chapter Two/, 'filepos=0099999999>Chapter Two').replace(/filepos=(\d+)>Chapter Three/, 'filepos=0000000012>Chapter Three');
    expect(texts(await converts(book({ markup: Buffer.from(lying) })))).toEqual(CHAPTERS.map((title) => `Text of ${title.toLowerCase()} & more.`));
  });

  it('finishes quickly on thousands of links that never close, which it converts or refuses with a typed error', async () => {
    const links = '<a filepos=0000000100>x'.repeat(20_000);
    const started = Date.now();
    await converts(book({ markup: markupWithToc(CHAPTERS, links) })).catch((error: unknown) => expect(error).toBeInstanceOf(ConversionFailedError));
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('survives random damage to the reference converter\'s book: it converts or fails with a typed error, and never hangs', async () => {
    const original = fs.readFileSync(path.join(CORPUS, 'ebooks', 'book.mobi'));
    let state = 0x2545f491;
    const next = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % bound;
    };
    const header = 4096;
    const outcomes = { converted: 0, refused: 0, untyped: [] as string[] };
    for (let round = 0; round < ROUNDS; round += 1) {
      const damaged = Buffer.from(original);
      // Half of the damage lands in the container and header records, where the offsets and lengths are.
      const reach = round % 2 === 0 ? header : damaged.length;
      for (let hit = 0; hit < 1 + next(10); hit += 1) damaged[next(reach)] = next(256);
      const bytes = round % 5 === 0 ? damaged.subarray(0, 1 + next(damaged.length)) : damaged;
      try {
        await convertFile(bytes, 'mobi', 'epub', {}, 'fuzz.mobi');
        outcomes.converted += 1;
      } catch (error) {
        if (error instanceof ConversionFailedError) outcomes.refused += 1;
        else outcomes.untyped.push(`round ${round}: ${String(error)}`);
      }
    }
    expect(outcomes.untyped).toEqual([]);
    expect(outcomes.converted + outcomes.refused).toBe(ROUNDS);
    // The damage is real: some books are refused, and some survive it.
    expect(outcomes.refused).toBeGreaterThan(5);
    expect(outcomes.converted).toBeGreaterThan(5);
  }, 120_000);
});
