import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { ROCKETBOOK_LIMITS, RocketBookFormatError, readRocketBook } from '../src/lib/conversions/office/rocketbook-reader';
import { ConversionFailedError, DecompressionLimitError, PayloadLimitError } from '../src/lib/types';
import { isOfficeSuiteOnlySource } from '../src/lib/conversions/office/office-suite-sources';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { readRocketBookModel } from '../src/lib/conversions/rocketbook-model';
import { withMissingBinary } from './helpers/native-tools';
import { expectNoHang, settle } from './helpers/timing';
import {
  FLAG_ENCRYPTED,
  FLAG_PLAIN,
  ROCKETBOOK_SIGNATURE,
  buildRocketBook,
  deflatedChunks,
  deflatedText,
  greyPng,
  htmlPage,
  imagePage,
  infoPage,
  simpleRocketBook,
} from './helpers/rocketbook-builder';

/**
 * A RocketBook file is a container of named pages: an info page with the title and the author, deflated HTML pages and
 * PNG pictures. These tests build containers from the layout that the two real files show and check what a caller sees:
 * the book the reader returns, the text and structure of the converted outputs, and the typed answer for a file that is
 * damaged or hostile. The real files and the oracle (calibre) are in rocketbook-real-samples.test.ts.
 */

const ONE_PIXEL_PNG = greyPng(1);
const PICTURE_PNG = greyPng(8);
const PNG_IHDR_END = 33;

/** PICTURE_PNG made `bytes` long by a private ancillary chunk after its header, which decoders skip (PNG specification 5.4). */
function paddedPng(bytes: number): Buffer {
  const body = Buffer.concat([Buffer.from('paDd', 'latin1'), Buffer.alloc(bytes)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body), 0);
  return Buffer.concat([PICTURE_PNG.subarray(0, PNG_IHDR_END), length, body, crc, PICTURE_PNG.subarray(PNG_IHDR_END)]);
}

async function textOf(book: Buffer): Promise<string> {
  return (await convertFile(book, 'rb', 'txt', {}, 'book.rb')).buffer.toString('utf-8');
}

describe('the container reader', () => {
  it('reads the title and the authors of the info page and the HTML pages in table order', () => {
    const book = readRocketBook(
      buildRocketBook([
        infoPage(['TYPE=2', 'TITLE=Lorem Ipsum', 'AUTHOR=Ann Author and Bob Writer & Cy Third']),
        htmlPage('second.html', '<HTML><BODY><P>two</P></BODY></HTML>'),
        htmlPage('first.html', '<HTML><BODY><P>one</P></BODY></HTML>'),
      ])
    );
    expect(book.title).toBe('Lorem Ipsum');
    expect(book.authors).toEqual(['Ann Author', 'Bob Writer', 'Cy Third']);
    expect(book.pages.map((page) => page.name)).toEqual(['second.html', 'first.html']);
    expect(book.pages[0].html).toContain('<P>two</P>');
  });

  it('keeps a title that holds an equals sign, which has no second meaning', () => {
    const book = readRocketBook(buildRocketBook([infoPage(['TITLE=E = mc2', 'AUTHOR=Albert']), htmlPage('index.html', '<P>x</P>')]));
    expect(book.title).toBe('E = mc2');
  });

  it('decodes a page as Windows-1252 and keeps the bytes the code page leaves undefined as replacement characters', () => {
    const html = Buffer.from([...Buffer.from('<P>caf'), 0xe9, 0x20, 0x80, 0x20, 0x93, ...Buffer.from('q'), 0x94, 0x20, 0x81, ...Buffer.from('</P>')]);
    const book = readRocketBook(buildRocketBook([htmlPage('index.html', html)]));
    expect(book.pages[0].html).toBe('<P>café € “q” �</P>');
  });

  it('reads a page stored without compression, matches names by suffix in any case and decodes percent escapes', () => {
    const book = readRocketBook(
      buildRocketBook([
        { name: 'Chapter%201.HTML', flags: FLAG_PLAIN, data: Buffer.from('<P>plain</P>') },
        htmlPage('b.html', '<P>packed</P>'),
        { name: 'notes.txt', flags: FLAG_PLAIN, data: Buffer.from('not a page') },
      ])
    );
    expect(book.pages.map((page) => [page.name, page.html])).toEqual([
      ['Chapter 1.HTML', '<P>plain</P>'],
      ['b.html', '<P>packed</P>'],
    ]);
  });

  it('joins the chunks of a page and leaves out pages flagged as protected', () => {
    const text = Buffer.from(`<P>${'word '.repeat(3000)}</P>`);
    const book = readRocketBook(
      buildRocketBook([
        htmlPage('index.html', text),
        { name: 'locked.html', flags: FLAG_ENCRYPTED, data: Buffer.from('xxxxxxxx') },
      ])
    );
    expect(book.pages).toHaveLength(1);
    expect(book.pages[0].html).toBe(text.toString('latin1'));
  });

  it('serves the PNG pictures that are stored plain and nothing else', () => {
    const book = readRocketBook(
      buildRocketBook([
        htmlPage('index.html', '<P>x</P>'),
        imagePage('0.png', ONE_PIXEL_PNG),
        { name: 'flagged.png', flags: FLAG_ENCRYPTED, data: ONE_PIXEL_PNG },
        imagePage('1.gif', ONE_PIXEL_PNG),
      ])
    );
    expect(book.image('0.png')?.equals(ONE_PIXEL_PNG)).toBe(true);
    expect(book.image('flagged.png')).toBeUndefined();
    expect(book.image('1.gif')).toBeUndefined();
    expect(book.image('absent.png')).toBeUndefined();
  });
});

describe('a file that is not a readable RocketBook', () => {
  const valid = simpleRocketBook('<P>x</P>');

  it('is refused when the signature is not the RocketBook one', () => {
    const wrong = Buffer.from(valid);
    wrong[6] = 0x58;
    expect(() => readRocketBook(wrong)).toThrow(RocketBookFormatError);
    expect(() => readRocketBook(Buffer.from('PK\u0003\u0004 plain text, not a RocketBook'))).toThrow(/signature/);
  });

  it('is refused when it is shorter than the header or its size is not the size the header states', () => {
    expect(() => readRocketBook(ROCKETBOOK_SIGNATURE)).toThrow(RocketBookFormatError);
    expect(() => readRocketBook(valid.subarray(0, valid.length - 1))).toThrow(/size/);
    expect(() => readRocketBook(Buffer.concat([valid, Buffer.from('tail')]))).toThrow(/size/);
  });

  it('is refused when the table of contents lies outside the file or claims more pages than fit', () => {
    const pastEnd = Buffer.from(valid);
    pastEnd.writeUInt32LE(valid.length - 2, 24);
    expect(() => readRocketBook(pastEnd)).toThrow(RocketBookFormatError);
    expect(() => readRocketBook(buildRocketBook([htmlPage('index.html', '<P>x</P>')], { statedPageCount: 0xffffffff }))).toThrow(RocketBookFormatError);
    expect(() => readRocketBook(buildRocketBook([htmlPage('index.html', '<P>x</P>')], { statedPageCount: 2 }))).toThrow(RocketBookFormatError);
  });

  it('is refused when it lists more pages than the limit', () => {
    const pages = Array.from({ length: 5 }, (_, index) => imagePage(`${index}.png`, ONE_PIXEL_PNG));
    expect(() => readRocketBook(buildRocketBook(pages), { ...ROCKETBOOK_LIMITS, maxPages: 4 })).toThrow(PayloadLimitError);
    expect(readRocketBook(buildRocketBook(pages), { ...ROCKETBOOK_LIMITS, maxPages: 5 }).image('4.png')).toBeDefined();
  });

  it('is refused when a page lies outside the file', () => {
    const beyond = buildRocketBook([{ ...imagePage('0.png', ONE_PIXEL_PNG), statedSize: 5000 }]);
    expect(() => readRocketBook(beyond)).toThrow(RocketBookFormatError);
    const compressed = buildRocketBook([{ ...htmlPage('index.html', '<P>x</P>'), statedOffset: 0xfffffff0 }]);
    expect(() => readRocketBook(compressed)).toThrow(RocketBookFormatError);
  });

  it('is refused when a page starts inside the header or the table of contents', () => {
    expect(() => readRocketBook(buildRocketBook([{ ...imagePage('0.png', ONE_PIXEL_PNG), statedOffset: 0 }]))).toThrow(RocketBookFormatError);
    expect(() => readRocketBook(buildRocketBook([{ ...imagePage('0.png', ONE_PIXEL_PNG), statedOffset: 0x130 }]))).toThrow(RocketBookFormatError);
  });

  it('is refused when two pages share bytes, so that one stored page cannot be read many times', () => {
    const first = htmlPage('a.html', '<P>x</P>');
    const aliased = buildRocketBook([first, { ...htmlPage('b.html', '<P>x</P>'), statedOffset: 0x128 + 4 + 2 * 44 }]);
    expect(() => readRocketBook(aliased)).toThrow(/overlap/);
    const imageAliased = buildRocketBook([imagePage('0.png', ONE_PIXEL_PNG), { ...imagePage('1.png', ONE_PIXEL_PNG), statedOffset: 0x128 + 4 + 2 * 44 + 2 }]);
    expect(() => readRocketBook(imageAliased)).toThrow(/overlap/);
  });

  it('is refused when the chunk table of a page runs past the file', () => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(0x0fffffff, 0);
    expect(() => readRocketBook(buildRocketBook([{ name: 'index.html', flags: 8, data: head }]))).toThrow(RocketBookFormatError);
    expect(() => readRocketBook(buildRocketBook([{ name: 'index.html', flags: 8, data: Buffer.alloc(3) }]))).toThrow(RocketBookFormatError);
    const oversizedChunk = Buffer.concat([deflatedChunks([Buffer.from('x')], 1).subarray(0, 8), Buffer.from([0xff, 0xff, 0xff, 0x7f])]);
    expect(() => readRocketBook(buildRocketBook([{ name: 'index.html', flags: 8, data: oversizedChunk }]))).toThrow(RocketBookFormatError);
  });

  it('is refused with a typed error when a chunk is not a deflate stream', () => {
    const broken = deflatedChunks([Buffer.from('this is not a zlib stream')], 25);
    expect(() => readRocketBook(buildRocketBook([{ name: 'index.html', flags: 8, data: broken }]))).toThrow(ConversionFailedError);
  });

  it('is refused when one chunk inflates past the chunk limit, however small it is stored', () => {
    const bomb = zlib.deflateSync(Buffer.alloc(ROCKETBOOK_LIMITS.maxChunkBytes + 1), { level: 9 });
    expect(bomb.length).toBeLessThan(10_000);
    const file = buildRocketBook([{ name: 'index.html', flags: 8, data: deflatedChunks([bomb], 5) }]);
    expect(() => readRocketBook(file)).toThrow(DecompressionLimitError);
  });

  it('is refused when the pages together inflate past the text limit', () => {
    const chunk = zlib.deflateSync(Buffer.alloc(4096, 0x41), { level: 9 });
    const pages = Array.from({ length: 6 }, (_, index) => ({ name: `p${index}.html`, flags: 8, data: deflatedChunks([chunk, chunk], 8192) }));
    const limits = { ...ROCKETBOOK_LIMITS, maxTextBytes: 8192 * 4 };
    expect(() => readRocketBook(buildRocketBook(pages), limits)).toThrow(DecompressionLimitError);
    expect(readRocketBook(buildRocketBook(pages.slice(0, 4)), limits).pages).toHaveLength(4);
  });

  it('is refused when a page states more text than the limit before any chunk is inflated', () => {
    const chunk = zlib.deflateSync(Buffer.from('x'));
    const file = buildRocketBook([{ name: 'index.html', flags: 8, data: deflatedChunks([chunk], 0xffffffff) }]);
    expect(() => readRocketBook(file)).toThrow(PayloadLimitError);
  });

  it('is refused when the pictures together are larger than the picture limit', () => {
    const file = buildRocketBook([htmlPage('index.html', '<P>x</P>'), imagePage('0.png', Buffer.alloc(100)), imagePage('1.png', Buffer.alloc(100))]);
    expect(() => readRocketBook(file, { ...ROCKETBOOK_LIMITS, maxImageBytes: 150 })).toThrow(PayloadLimitError);
  });

  it('is refused when its chunks inflate to more or less text than the page states', () => {
    const text = Buffer.from('<P>stated</P>');
    const chunk = zlib.deflateSync(text);
    for (const stated of [text.length - 1, text.length + 1]) {
      const file = buildRocketBook([{ name: 'index.html', flags: 8, data: deflatedChunks([chunk], stated) }]);
      expect(() => readRocketBook(file), `stated ${stated}`).toThrow(RocketBookFormatError);
    }
    expect(readRocketBook(buildRocketBook([{ name: 'index.html', flags: 8, data: deflatedChunks([chunk], text.length) }])).pages[0].html).toBe('<P>stated</P>');
  });

  it('is refused when a page lists more chunks than bytes of text it states', () => {
    const chunk = zlib.deflateSync(Buffer.from('x'));
    const file = buildRocketBook([{ name: 'index.html', flags: 8, data: deflatedChunks([chunk, chunk], 1) }]);
    expect(() => readRocketBook(file)).toThrow(RocketBookFormatError);
  });

  it('is refused when a chunk is shorter than the smallest zlib stream', () => {
    const shortest = zlib.deflateSync(Buffer.alloc(0));
    expect(shortest).toHaveLength(8);
    const file = buildRocketBook([{ name: 'index.html', flags: 8, data: deflatedChunks([zlib.deflateSync(Buffer.from('ab')), shortest.subarray(0, 7)], 2) }]);
    expect(() => readRocketBook(file)).toThrow(RocketBookFormatError);
  });

  it('is refused when its pages list more chunks together than the limit, and read at the limit', () => {
    const chunk = zlib.deflateSync(Buffer.from('x'));
    const pages = [0, 1].map((index) => ({ name: `p${index}.html`, flags: 8, data: deflatedChunks([chunk, chunk], 2) }));
    expect(() => readRocketBook(buildRocketBook(pages), { ...ROCKETBOOK_LIMITS, maxChunks: 3 })).toThrow(PayloadLimitError);
    expect(readRocketBook(buildRocketBook(pages), { ...ROCKETBOOK_LIMITS, maxChunks: 4 }).pages.map((page) => page.html)).toEqual(['xx', 'xx']);
  });

  it('ignores an info page that states no title and reads the first info page only', () => {
    const book = readRocketBook(
      buildRocketBook([infoPage(['TYPE=2', 'TITLE= ', 'AUTHOR=']), infoPage(['TITLE=Second']), htmlPage('index.html', '<P>x</P>')])
    );
    expect(book.title).toBeUndefined();
    expect(book.authors).toEqual([]);
  });

  it('reads at most the leading bytes of an info page', () => {
    const long = `TITLE=${'a'.repeat(ROCKETBOOK_LIMITS.maxInfoBytes)}`;
    const book = readRocketBook(buildRocketBook([infoPage([long, 'AUTHOR=Late Author']), htmlPage('index.html', '<P>x</P>')]));
    expect(book.authors).toEqual([]);
    expect((book.title ?? '').length).toBeLessThanOrEqual(ROCKETBOOK_LIMITS.maxInfoBytes);
  });

  it('splits an author line of 64 KiB of white space in linear time', async () => {
    const run = ' '.repeat(65_000);
    const author = `AUTHOR=Ann${run}Lee with Bob`;
    const book = await expectNoHang('white space author', () => readRocketBook(buildRocketBook([infoPage([author]), htmlPage('index.html', '<P>x</P>')])));
    expect(book.authors).toEqual([`Ann${run}Lee`, 'Bob']);
  });

  it('names a page in an error without the control characters of its stored name', () => {
    const file = buildRocketBook([{ ...imagePage('bad%0D%0Aline%07.png', ONE_PIXEL_PNG), statedSize: 5000 }]);
    const failure = settle(() => readRocketBook(file));
    expect(failure.ok).toBe(false);
    const message = (failure as { error: Error }).error.message;
    expect(message).toContain('bad');
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe('a hostile chunk table', () => {
  const SHORTEST_ZLIB_STREAM = zlib.deflateSync(Buffer.alloc(0));
  let inflateCalls: MockInstance<typeof zlib.inflateSync>;

  beforeEach(() => {
    inflateCalls = vi.spyOn(zlib, 'inflateSync');
  });

  afterEach(() => {
    inflateCalls.mockRestore();
  });

  /** The refusal of `file`, found within the hang guard: the claim is how much work was done, which the calls to the inflater count. */
  function failureOf(file: Buffer): Promise<unknown> {
    return expectNoHang('hostile chunk table', () => settle(() => readRocketBook(file))).then((settled) => (settled.ok ? undefined : settled.error));
  }

  it('is refused before any chunk is read when it lists four million chunks of no bytes', async () => {
    const chunks = 4 * 1024 * 1024;
    const page = Buffer.alloc(8 + 4 * chunks);
    page.writeUInt32LE(chunks, 0);
    page.writeUInt32LE(chunks, 4);
    const overLimit = await failureOf(buildRocketBook([{ name: 'index.html', flags: 8, data: page }]));
    const statesNoText = Buffer.from(page);
    statesNoText.writeUInt32LE(0, 4);
    const moreChunksThanText = await failureOf(buildRocketBook([{ name: 'index.html', flags: 8, data: statesNoText }]));
    expect(overLimit).toBeInstanceOf(PayloadLimitError);
    expect(moreChunksThanText).toBeInstanceOf(RocketBookFormatError);
    expect([overLimit, moreChunksThanText].map((error) => (error as { status: number }).status)).toEqual([413, 400]);
    expect(inflateCalls).not.toHaveBeenCalled();
  });

  it('is refused when 65,535 pages all point at one stored page of many chunks', async () => {
    const stored = deflatedChunks(Array.from({ length: 64 }, () => zlib.deflateSync(Buffer.from('x'))), 64);
    const tableEnd = 0x128 + 4 + 0xffff * 44;
    const pages = Array.from({ length: 0xffff }, (_, index) => ({ name: `p${index}.html`, flags: 8, data: index === 0 ? stored : Buffer.alloc(0), statedOffset: tableEnd, statedSize: stored.length }));
    const failure = await failureOf(buildRocketBook(pages));
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toBe(`The RocketBook pages list more than ${ROCKETBOOK_LIMITS.maxChunks} compressed chunks together.`);
    expect(inflateCalls).not.toHaveBeenCalled();
  });

  it('is refused before any chunk is inflated when a page holds more of the smallest zlib streams than the limit', async () => {
    const pageOf = (count: number) => buildRocketBook([{ name: 'index.html', flags: 8, data: deflatedChunks(Array.from({ length: count }, () => SHORTEST_ZLIB_STREAM), count) }]);
    const overLimit = await failureOf(pageOf(ROCKETBOOK_LIMITS.maxChunks + 1));
    const inflatedOverLimit = inflateCalls.mock.calls.length;
    const atLimit = await failureOf(pageOf(ROCKETBOOK_LIMITS.maxChunks));
    expect(overLimit).toBeInstanceOf(PayloadLimitError);
    expect([overLimit, atLimit].map((error) => (error as { status: number }).status)).toEqual([413, 400]);
    expect(inflatedOverLimit, 'streams inflated before the page over the limit was refused').toBe(0);
    expect(inflateCalls.mock.calls.length, 'a page at the limit is read: the counter sees the inflater').toBeGreaterThan(0);
  });

  it('is refused when a page of the smallest zlib streams inflates to none of the text it states', async () => {
    const file = buildRocketBook([{ name: 'index.html', flags: 8, data: deflatedChunks(Array.from({ length: 1000 }, () => SHORTEST_ZLIB_STREAM), 1000) }]);
    const failure = await failureOf(file);
    expect(failure).toBeInstanceOf(RocketBookFormatError);
    expect((failure as Error).message).toMatch(/states 1000 bytes of text and its chunks hold 0/);
  });
});

describe('a RocketBook converted to the targets of the e-book pipeline', () => {
  const html = [
    '<HTML><HEAD><TITLE></TITLE></HEAD><BODY>',
    '<H1>Chapter One</H1>',
    '<P>First paragraph with <B>bold</B> and <I>italic</I> words.</P>',
    '<P><IMG SRC="0.png"></P>',
    '<UL><LI>alpha</LI><LI>beta</LI></UL>',
    '<P>Café &amp; crème</P>',
    '</BODY></HTML>',
  ].join('\n');
  const second = '<HTML><BODY><H1>Chapter Two</H1><P>Second page text.</P></BODY></HTML>';
  const book = buildRocketBook([
    infoPage(['TYPE=2', 'TITLE=Probe title', 'AUTHOR=Probe Author']),
    htmlPage('index.html', html),
    htmlPage('two.html', second),
    imagePage('0.png', PICTURE_PNG),
  ]);

  it('is read to plain text in page order with its structure', async () => {
    const text = await textOf(book);
    expect(text.indexOf('Chapter One')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Chapter One')).toBeLessThan(text.indexOf('First paragraph with bold and italic words.'));
    expect(text.indexOf('First paragraph with bold and italic words.')).toBeLessThan(text.indexOf('Chapter Two'));
    expect(text).toContain('Second page text.');
    expect(text).toContain('Café & crème');
    expect(text).toContain('alpha');
    expect(text).not.toMatch(/<[A-Za-z]/);
  });

  it('is written as HTML with the title, the headings, the emphasis and the picture', async () => {
    const out = (await convertFile(book, 'rb', 'html', {}, 'book.rb')).buffer.toString('utf-8');
    expect(out).toContain('<title>Probe title</title>');
    expect(out).toMatch(/<h1[^>]*>Chapter One<\/h1>/);
    expect(out).toMatch(/<(b|strong)>bold<\/(b|strong)>/);
    expect(out).toMatch(/<(i|em)>italic<\/(i|em)>/);
    expect(out).toMatch(/<img [^>]*src="data:image\/png;base64,/);
  });

  it('is written as an EPUB with the title, the author, the chapters in order and the picture', async () => {
    const epub = (await convertFile(book, 'rb', 'epub', {}, 'book.rb')).buffer;
    const zip = await JSZip.loadAsync(epub);
    expect(await zip.file('mimetype')?.async('string')).toBe('application/epub+zip');
    const names = Object.keys(zip.files);
    const opf = await zip.file(names.find((name) => name.endsWith('.opf')) as string)?.async('string');
    expect(opf).toContain('Probe Author');
    const documents = await Promise.all(names.filter((name) => /\.x?html$/.test(name)).map(async (name) => zip.file(name)?.async('string') ?? ''));
    const all = documents.join('\n');
    expect(all.indexOf('Chapter One')).toBeLessThan(all.indexOf('Chapter Two'));
    expect(names.some((name) => /\.png$/.test(name))).toBe(true);
  });

  it('is written to every target the registry advertises for .rb', async () => {
    for (const target of FORMAT_REGISTRY.rb.targetFormats) {
      const out = await convertFile(book, 'rb', target, {}, 'book.rb');
      expect(out.buffer.length, target).toBeGreaterThan(0);
      expect(out.filename, target).toBe(`book.${target}`);
    }
  });

  it('is read without the office suite: .rb is no longer a format only the suite imports', async () => {
    expect(isOfficeSuiteOnlySource('rb')).toBe(false);
    const out = await withMissingBinary('SOFFICE_PATH', () => convertFile(book, 'rb', 'epub', {}, 'book.rb'));
    expect(out.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('is refused with a typed error when no page holds text', async () => {
    const empty = buildRocketBook([infoPage(['TITLE=Empty']), imagePage('0.png', ONE_PIXEL_PNG)]);
    await expect(textOf(empty)).rejects.toThrow(/no text/i);
    const protectedOnly = buildRocketBook([infoPage(['TITLE=Locked']), { name: 'index.html', flags: FLAG_ENCRYPTED, data: Buffer.from('xxxxxxxx') }]);
    await expect(textOf(protectedOnly)).rejects.toBeInstanceOf(ConversionFailedError);
  });

  it('is refused with a typed error when the file is damaged', async () => {
    const failure = await textOf(Buffer.from('not a rocketbook at all')).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RocketBookFormatError);
    expect((failure as Error).message).toBe('The file is not a readable RocketBook: it does not start with the RocketBook signature.');
  });

  it('is refused with a typed error when a page nests elements without end', async () => {
    const nested = buildRocketBook([htmlPage('index.html', `${'<DIV>'.repeat(200_000)}deep text${'</DIV>'.repeat(200_000)}`)]);
    await expect(textOf(nested)).rejects.toThrow(/nests elements deeper than/);
  });

  it('is refused with a typed error when a page names a picture more often than the model embeds', async () => {
    const repeated = buildRocketBook([htmlPage('index.html', '<P><IMG SRC="0.png"></P>'.repeat(50_000)), imagePage('0.png', PICTURE_PNG)]);
    const failure = await convertFile(repeated, 'rb', 'epub', {}, 'book.rb').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toBe('The document embeds more than 2000 images.');
  });

  it('is refused with a typed error when its pages together name one picture more often than the model embeds', async () => {
    const page = (index: number) => htmlPage(`p${index}.html`, '<P><IMG SRC="0.png"></P>'.repeat(700));
    const repeated = buildRocketBook([page(0), page(1), page(2), imagePage('0.png', PICTURE_PNG)]);
    const failure = await expectNoHang('one picture on every page', () => convertFile(repeated, 'rb', 'epub', {}, 'book.rb').catch((error: unknown) => error));
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toBe('The document embeds more than 2000 images.');
    expect((await readRocketBookModel(buildRocketBook([page(0), page(1), imagePage('0.png', PICTURE_PNG)]), 'book')).images).toHaveLength(1);
  });

  it('is refused with a typed error when its pages together name one picture for more bytes than the model embeds', async () => {
    const picture = paddedPng(1024 * 1024);
    const page = (index: number) => htmlPage(`p${index}.html`, '<P><IMG SRC="0.png"></P>'.repeat(150));
    const failure = await convertFile(buildRocketBook([page(0), page(1), imagePage('0.png', picture)]), 'rb', 'epub', {}, 'book.rb').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toBe(`The document embeds more than ${256 * 1024 * 1024} bytes of images.`);
  });

  it('reads twenty thousand pages in table order', async () => {
    const pages = Array.from({ length: 20_000 }, (_, index) => htmlPage(`p${index}.html`, `<P>page ${index}</P>`));
    const words = (await textOf(buildRocketBook(pages))).split(/\s+/).filter((word) => /^\d+$/.test(word));
    expect(words).toHaveLength(20_000);
    expect(words[0]).toBe('0');
    expect(words[19_999]).toBe('19999');
  });

  it('is written without the sections of a page that holds only the title', async () => {
    const titleOnly = buildRocketBook([htmlPage('index.html', '<HTML><HEAD><TITLE></TITLE></HEAD><BODY>\n</BODY></HTML>'), htmlPage('b.html', '<P>kept</P>')]);
    expect((await textOf(titleOnly)).trim()).toBe('kept');
  });

  it('reads a page of many deflate chunks as one text', async () => {
    const original = `<P>${'lorem ipsum '.repeat(2000)}</P>`;
    expect(deflatedText(Buffer.from(original)).length).toBeLessThan(original.length);
    expect((await textOf(buildRocketBook([htmlPage('index.html', original)]))).replace(/\s+/g, ' ').trim()).toBe(original.replace(/<\/?P>/g, '').replace(/\s+/g, ' ').trim());
  });
});
