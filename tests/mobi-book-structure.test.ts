import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { readMobiModel } from '../src/lib/conversions/mobi-model';
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


/**
 * Markup laid out from a template whose markers (`\u0001name\u0002`) stand for byte offsets: every `{{name}}` becomes the
 * ten-digit `filepos` of the marker `name`, counted in bytes of the encoding the book is stored in, as a book's links are.
 */
function layout(template: string, encoding: 'utf-8' | 'latin1' = 'utf-8'): Buffer {
  // A position is ten digits whatever its value, so filling it in moves nothing.
  const sized = template.replace(/\{\{[^}]*\}\}/g, '0000000000');
  const offsets = new Map<string, number>();
  let bytes = 0;
  for (const part of sized.split(/(\u0001[^\u0002]*\u0002)/)) {
    if (part.startsWith('\u0001')) offsets.set(part.slice(1, -1), bytes);
    else bytes += Buffer.byteLength(part, encoding);
  }
  const filled = template.replace(/\{\{([^}]*)\}\}/g, (_token, name: string) => String(offsets.get(name) ?? 0).padStart(10, '0'));
  return Buffer.from(filled.replace(/\u0001[^\u0002]*\u0002/g, ''), encoding);
}

const mark = (name: string): string => `\u0001${name}\u0002`;
const titleParagraph = (title: string): string => `<p height="2em" width="0pt"><font size="6"><b>${title}</b></font></p>`;
const chapterTemplate = (titles: readonly string[]): string => titles.map((title, i) => `${mark(`c${i}`)}${titleParagraph(title)}<p>Text of ${title.toLowerCase()}.</p><mbp:pagebreak/>`).join('');
const tocLinks = (titles: readonly string[]): string => titles.map((title, i) => `<p height="0pt" width="-14pt"><a filepos={{c${i}}}>${title}</a></p>`).join('');
const guide = '<html><head><guide><reference type="toc" title="Table of Contents" filepos={{toc}} /></guide></head><body>';

function bookOf(markup: Buffer, extra: Partial<Parameters<typeof buildMobi>[0]> = {}): Buffer {
  return buildMobi({ textRecords: records(markup), compression: 2, encoding: 65001, textLength: markup.length, images: [], ...extra });
}

const chapterTexts = (html: string): string[] => elementsOf(html, new Set(['p'])).map((paragraph) => paragraph.text).filter((text) => text.startsWith('Text of'));
const headingTexts = (html: string): string[] => headingsOf(html).map(([, text]) => text);
const htmlOf = async (input: Buffer): Promise<string> => (await inspectEpub(await toEpub(input))).chapters.map((chapter) => chapter.html).join('\n');

describe('the table of contents of a MOBI book', () => {
  it('turns only the links with a label that point outside the contents page into headings', async () => {
    const template = `${guide}${chapterTemplate(CHAPTERS).replace('<p>Text of chapter one.</p>', `<p>Text of chapter one.</p>${mark('plain')}<p>A plain paragraph.</p>`)}${mark('toc')}<mbp:pagebreak/>${tocLinks(CHAPTERS)}<p><a filepos={{plain}}><img recindex="00001"></img></a></p>${mark('note')}<p>Note on the contents.</p><p><a filepos={{note}}>Self link</a></p><mbp:pagebreak/></body></html>`;
    const html = await htmlOf(bookOf(layout(template), { images: [PIXEL] }));
    // The picture link has no label and the self link points into the contents page: neither names a chapter.
    expect(headingTexts(html)).toEqual(CHAPTERS);
    const paragraphs = elementsOf(html, new Set(['p'])).map((paragraph) => paragraph.text);
    expect(paragraphs.filter((text) => text === 'A plain paragraph.' || text === 'Note on the contents.' || text === 'Self link')).toEqual(['A plain paragraph.', 'Note on the contents.', 'Self link']);
  });

  it.each([
    ['a link that never closes ends the page', `<p><a filepos={{plain}}></p>${'<b></b>'.repeat(400)}<p><a filepos={{plain}}>Later link</a></p>`],
    ['a link far from the others is not part of the page', `${'<i></i>'.repeat(700)}<p><a filepos={{plain}}>Far link</a></p>`],
    ['a link that points beyond the book names no chapter', '<p><a filepos=0099999999>Beyond</a></p>'],
  ])('keeps the paragraph a paragraph when %s', async (_name, extraLinks) => {
    const template = `${guide}${chapterTemplate(CHAPTERS).replace('<p>Text of chapter one.</p>', `<p>Text of chapter one.</p>${mark('plain')}<p>A plain paragraph.</p>`)}${mark('toc')}<mbp:pagebreak/>${tocLinks(CHAPTERS)}${extraLinks}<mbp:pagebreak/></body></html>`;
    const html = await htmlOf(bookOf(layout(template)));
    expect(headingTexts(html)).toEqual(CHAPTERS);
    expect(elementsOf(html, new Set(['p'])).filter((paragraph) => paragraph.text === 'A plain paragraph.')).toHaveLength(1);
  });

  it('makes one heading of two entries that name the same title, one at its start and one inside it', async () => {
    const template = `${guide}${mark('start')}<p>Nested ${mark('inside')}title</p><p>Text of nested.</p>${mark('toc')}<mbp:pagebreak/><p><a filepos={{start}}>Outer</a></p><p><a filepos={{inside}}>Inner</a></p><mbp:pagebreak/></body></html>`;
    const html = await htmlOf(bookOf(layout(template)));
    expect(headingTexts(html)).toEqual(['Nested title']);
    expect(elementsOf(html, new Set(['p'])).map((paragraph) => paragraph.text).filter((text) => text.startsWith('Nested'))).toEqual([]);
  });

  it('finds the chapters when the table of contents is at the front of the book', async () => {
    const template = `${guide}${mark('toc')}${tocLinks(CHAPTERS)}<mbp:pagebreak/>${chapterTemplate(CHAPTERS)}</body></html>`;
    const html = await htmlOf(bookOf(layout(template)));
    expect(headingTexts(html)).toEqual(CHAPTERS);
    expect(chapterTexts(html)).toEqual(CHAPTERS.map((title) => `Text of ${title.toLowerCase()}.`));
    // The page of links is left to the navigation document: each title is shown once.
    expect(elementsOf(html, new Set(['p', 'a', 'h1'])).filter((element) => CHAPTERS.includes(element.text))).toHaveLength(CHAPTERS.length);
  });

  it('counts the offsets in bytes: chapters after non-ASCII titles are still found', async () => {
    const titles = ['Été à Zürich', '日本語の章', 'Chapter Three'];
    const html = await htmlOf(bookOf(layout(`${guide}${chapterTemplate(titles)}${mark('toc')}<mbp:pagebreak/>${tocLinks(titles)}<mbp:pagebreak/></body></html>`)));
    expect(headingTexts(html)).toEqual(titles);
  });

  it('reads a Windows-1252 book with its own characters and offsets counted in its bytes', async () => {
    // Written as the Windows-1252 bytes 0x93 and 0x94 (curly quotes) and 0xE9 (é).
    const titles = ['Caf\xe9', 'Chapter \x93Two\x94'];
    const html = await htmlOf(bookOf(layout(`${guide}${chapterTemplate(titles)}${mark('toc')}<mbp:pagebreak/>${tocLinks(titles)}<mbp:pagebreak/></body></html>`, 'latin1'), { encoding: 1252 }));
    expect(headingTexts(html)).toEqual(['Café', 'Chapter \u201cTwo\u201d']);
  });

  it('refuses a text encoding other than UTF-8 and Windows-1252 with a typed 422 error naming it', async () => {
    const markup = layout(`${guide}${chapterTemplate(CHAPTERS)}</body></html>`);
    for (const encoding of [936, 28591, 0]) {
      const error = await convertFile(bookOf(markup, { encoding }), 'mobi', 'epub', {}, 'book.mobi').then(
        () => undefined,
        (caught: unknown) => caught as ConversionFailedError & { status?: number }
      );
      expect({ typed: error instanceof ConversionFailedError, status: error?.status, mentions: new RegExp(`text encoding ${encoding}\\b`).test(error?.message ?? '') }).toEqual({ typed: true, status: 422, mentions: true });
    }
  });
});

/** Time of the slowest of `runs` calls of the reader on the input of `size` bytes, in milliseconds (the reader's refusal counts: it did the work). */
async function readTime(make: (size: number) => Buffer, size: number, runs = 3): Promise<number> {
  const input = make(size);
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    await readMobiModel(input, 'book').catch(() => undefined);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('the time the reader takes on markup built to make it slow', () => {
  const SMALL = 100_000;
  const GROWTH = 4;
  // A linear reader takes about GROWTH times as long on GROWTH times the input, a quadratic one GROWTH squared: the bound sits between.
  const MAX_RATIO = 8;
  const endBook = (tail: string, size: number): Buffer => {
    const filler = tail.repeat(Math.ceil(size / tail.length));
    return bookOf(layout(`${guide}${chapterTemplate(CHAPTERS)}${mark('toc')}<mbp:pagebreak/>${tocLinks(CHAPTERS)}${filler}<mbp:pagebreak/></body></html>`));
  };
  const afterMarkup = (tail: string, size: number): Buffer => bookOf(layout(`${guide}${chapterTemplate(CHAPTERS)}</body></html>${tail.repeat(Math.ceil(size / tail.length))}`));

  it.each([
    ['links of the contents page that never close', (size: number) => endBook('<a filepos=0000000100>x ', size)],
    ['contents entries that point at paragraphs that never close', (size: number) => {
      const count = Math.ceil(size / 40);
      const paragraphs = Array.from({ length: count }, (_unused, i) => `${mark(`p${i}`)}<p>x`).join('');
      const links = Array.from({ length: count }, (_unused, i) => `<p><a filepos={{p${i}}}>T${i}</a></p>`).join('');
      return bookOf(layout(`${guide}${paragraphs}${mark('toc')}<mbp:pagebreak/>${links}<mbp:pagebreak/></body></html>`));
    }],
    ['picture tags that are never closed', (size: number) => afterMarkup('<img ', size)],
    ['MOBI tags that are never closed', (size: number) => afterMarkup('<mbp:', size)],
    ['link tags with a position that are never closed', (size: number) => afterMarkup('<a filepos=1 ', size)],
  ])('grows in proportion to the input on %s', async (_name, make) => {
    await readTime(make, SMALL / 4, 1);
    const small = await readTime(make, SMALL);
    const large = await readTime(make, SMALL * GROWTH);
    expect(large / Math.max(small, 1)).toBeLessThan(MAX_RATIO);
  }, 120_000);
});
