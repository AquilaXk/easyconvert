import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { ROCKETBOOK_LIMITS, RocketBookFormatError, readRocketBook } from '../src/lib/conversions/office/rocketbook-reader';
import { ConversionFailedError, DecompressionLimitError, PayloadLimitError } from '../src/lib/types';
import { isOfficeSuiteOnlySource } from '../src/lib/conversions/office/office-suite-sources';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { withMissingBinary } from './helpers/native-tools';
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
