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
import { oracleTest } from './helpers/oracle-test';

/**
 * An FB2 book keeps its structure when it becomes an EPUB or a PDF: the nesting of its sections is the nesting of the
 * headings, every top-level section and chapter starts a content document, the navigation lists them nested, poems,
 * epigraphs, tables and emphasis survive, the pictures named by the cover page and the text are packaged with their bytes,
 * and the notes keep their links. The expectations are written from the book authored below; the EPUB is read with parse5
 * and validated with EPUBCheck, the PDF with poppler.
 */

const PHOTO = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg'));
const PIXEL = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#cc3300' } }).png().toBuffer();

function book(options: { bodyTitle?: boolean } = {}): Buffer {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>prose</genre><author><first-name>Ann</first-name><middle-name>B.</middle-name><last-name>Writer</last-name></author><book-title>The Structured Book</book-title><annotation><p>ANNOTATION MUST NOT APPEAR</p></annotation><coverpage><image l:href="#cover.png"/></coverpage><lang>en</lang></title-info></description>
<body>${options.bodyTitle ? '<title><p>The Structured Book</p></title>' : ''}
<section id="part1"><title><p>Part One</p></title>
<epigraph><p>An epigraph line</p><text-author>Someone Wise</text-author></epigraph>
<section id="ch1"><title><p>First</p><p>chapter</p></title>
<p>Alpha <emphasis>beta</emphasis> <strong>gamma</strong> text<a l:href="#n1" type="note">[1]</a> and <a l:href="https://example.org/x">a link</a>.</p>
<image l:href="#pic.jpg"/>
<poem><title><p>A poem</p></title><stanza><v>verse one</v><v>verse two</v></stanza></poem>
<subtitle>A subtitle</subtitle>
<table><tr><th>Name</th><th>Depth</th></tr><tr><td>Post</td><td colspan="1">3 m</td></tr></table>
<empty-line/>
</section>
<section id="ch2"><title><p>Second chapter</p></title><p>Body of the second chapter.</p>
<section id="ss"><title><p>Nested subsection</p></title><p>Deep text.</p></section></section>
</section>
<section id="part2"><title><p>Part Two</p></title><p>Final words.</p></section>
</body>
<body name="notes"><title><p>Notes</p></title><section id="n1"><title><p>1</p></title><p>The note text.</p></section></body>
<binary id="cover.png" content-type="image/png">${PIXEL.toString('base64')}</binary>
<binary id="pic.jpg" content-type="image/jpeg">${PHOTO.toString('base64').replace(/(.{76})/g, '$1\n')}</binary>
</FictionBook>`;
  return Buffer.from(xml, 'utf-8');
}

const toEpub = async (input: Buffer) => (await convertFile(input, 'fb2', 'epub', {}, 'book.fb2')).buffer;

describe('FB2 to EPUB', () => {
  it('turns the nesting of sections into heading levels and one content document per chapter', async () => {
    const epub = await inspectEpub(await toEpub(book()));
    const headings = epub.chapters.flatMap((chapter) => headingsOf(chapter.html));
    expect(headings).toEqual([
      [1, 'Part One'],
      [2, 'First chapter'],
      [2, 'Second chapter'],
      [3, 'Nested subsection'],
      [1, 'Part Two'],
      [1, 'Notes'],
    ]);
    // The cover has a document of its own, then one starts at each h1 and h2: the part, two chapters, the second part and the notes.
    expect(epub.chapters).toHaveLength(6);
    expect(epub.chapters[0].html).toContain('<img');
    expect(epub.chapters[2].html).toContain('Alpha');
    expect(epub.chapters[3].html).toContain('Deep text.');
  });

  it('puts the book title above the sections when the body states one', async () => {
    const epub = await inspectEpub(await toEpub(book({ bodyTitle: true })));
    expect(epub.chapters.flatMap((chapter) => headingsOf(chapter.html)).slice(0, 3)).toEqual([[1, 'The Structured Book'], [2, 'Part One'], [3, 'First chapter']]);
  });

  it('lists the chapters nested in the navigation document and the NCX', async () => {
    const epub = await inspectEpub(await toEpub(book()));
    const entries = elementsOf(epub.navigation, new Set(['a'])).map((anchor) => anchor.text);
    expect(entries).toEqual(['Part One', 'First chapter', 'Second chapter', 'Nested subsection', 'Part Two', 'Notes']);
    expect(epub.navigation).toMatch(/<li><a href="chapter\d+\.xhtml[^"]*">Part One<\/a>\s*<ol>/);
    const ncx = await epub.zip.file('OEBPS/toc.ncx')?.async('string');
    expect(ncx).toContain('<text>Nested subsection</text>');
  });

  it('keeps emphasis, the poem, the subtitle, the table, the epigraph and the links, and leaves the annotation out', async () => {
    const epub = await inspectEpub(await toEpub(book()));
    const all = epub.chapters.map((chapter) => chapter.html).join('\n');
    expect(all).toMatch(/<em>beta<\/em> <strong>gamma<\/strong>/);
    expect(all).toContain('verse one');
    expect(all).toContain('verse two');
    expect(all).toContain('A subtitle');
    expect(all).toContain('An epigraph line');
    expect(all).toContain('Someone Wise');
    expect(elementsOf(all, new Set(['td', 'th'])).map((cell) => cell.text)).toEqual(['Name', 'Depth', 'Post', '3 m']);
    expect(elementsOf(all, new Set(['a'])).map((anchor) => anchor.attrs.get('href'))).toEqual(expect.arrayContaining(['https://example.org/x']));
    expect(all).not.toContain('ANNOTATION MUST NOT APPEAR');
    expect(all).toContain('The note text.');
  });

  it('links the note reference to the note, which is in the book', async () => {
    const epub = await inspectEpub(await toEpub(book()));
    const noteChapter = epub.chapters.find((chapter) => chapter.html.includes('The note text.')) as { html: string };
    const links = epub.chapters.flatMap((chapter) => elementsOf(chapter.html, new Set(['a'])).filter((anchor) => anchor.text === '[1]'));
    expect(links).toHaveLength(1);
    const href = links[0].attrs.get('href') as string;
    expect(href).toMatch(/^(?:chapter\d+\.xhtml)?#n1$/);
    const anchors = elementsOf(noteChapter.html, new Set(['a', 'span', 'p', 'div', 'section', 'h1', 'h2', 'h3', 'strong']));
    expect(anchors.some((element) => element.attrs.get('id') === 'n1')).toBe(true);
  });

  it('packages the cover page and the picture of the text with their own bytes, and marks the cover', async () => {
    const epub = await inspectEpub(await toEpub(book()));
    const images = [...epub.manifest].filter(([, item]) => item.mediaType.startsWith('image/'));
    expect(images).toHaveLength(2);
    const bytes = await Promise.all(images.map(([href]) => packagedFile(epub, href)));
    expect(bytes.some((data) => data.equals(PHOTO))).toBe(true);
    expect(bytes.some((data) => data.equals(PIXEL))).toBe(true);
    const cover = images.filter(([, item]) => item.properties.split(' ').includes('cover-image'));
    expect(cover).toHaveLength(1);
    expect((await packagedFile(epub, cover[0][0])).equals(PIXEL)).toBe(true);
    expect(epub.chapters[0].html).toContain('<img');
  });

  it('carries the book title, author and language into the package', async () => {
    const epub = await inspectEpub(await toEpub(book()));
    expect(epub.opf).toContain('<dc:title>The Structured Book</dc:title>');
    expect(epub.opf).toContain('<dc:creator>Ann B. Writer</dc:creator>');
    expect(epub.opf).toContain('<dc:language>en</dc:language>');
  });

  oracleTest('is valid according to EPUBCheck', ['epubcheck'], async () => {
    const report = runEpubcheck(await toEpub(book()));
    expect(report.messages.filter((message) => ['FATAL', 'ERROR'].includes(message.severity))).toEqual([]);
  }, 180_000);
});

describe('FB2 to PDF', () => {
  oracleTest('draws the headings, the text and both pictures', ['pdftotext', 'pdfimages'], async () => {
    const pdf = (await convertFile(book(), 'fb2', 'pdf', {}, 'book.fb2')).buffer;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb2-pdf-'));
    try {
      const file = path.join(dir, 'book.pdf');
      fs.writeFileSync(file, pdf);
      const text = execFileSync(requireOracleTool('pdftotext'), [file, '-'], { encoding: 'utf-8' });
      for (const expected of ['Part One', 'Nested subsection', 'Deep text.', 'verse two', 'Final words.']) expect(text).toContain(expected);
      expect(text).not.toContain('ANNOTATION MUST NOT APPEAR');
      const listing = execFileSync(requireOracleTool('pdfimages'), ['-list', file], { encoding: 'utf-8' }).split('\n').filter((line) => line.trim() !== '');
      expect(listing.length - 2).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('FB2 input that is not a book', () => {
  it.each([
    ['a binary that is not base64', '<binary id="pic.jpg" content-type="image/jpeg">!!!not base64!!!</binary>'],
    ['a reference to a picture the book does not hold', '<body><section><p>x</p><image l:href="#missing"/></section></body>'],
  ])('leaves out %s and still writes the book', async (_name, extra) => {
    const xml = `<?xml version="1.0"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>T</book-title></title-info></description><body><section><title><p>One</p></title><p>text</p><image l:href="#pic.jpg"/></section></body>${extra}</FictionBook>`;
    const epub = await inspectEpub(await toEpub(Buffer.from(xml, 'utf-8')));
    expect(epub.chapters.map((chapter) => chapter.html).join('')).toContain('text');
    expect([...epub.manifest].filter(([, item]) => item.mediaType.startsWith('image/'))).toHaveLength(0);
  });

  it.each([
    ['a book whose XML is cut off', (b: Buffer) => b.subarray(0, Math.floor(b.length / 2))],
    ['a book nested far deeper than any book is', () => Buffer.from(`<?xml version="1.0"?><FictionBook><body>${'<section>'.repeat(400)}<p>x</p>${'</section>'.repeat(400)}</body></FictionBook>`)],
    ['a book that is not FictionBook', () => Buffer.from('<?xml version="1.0"?><html><body><p>x</p></body></html>')],
  ])('refuses %s with a typed error', async (_name, make) => {
    const run = convertFile(make(book()), 'fb2', 'epub', {}, 'bad.fb2');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
  });

  it('survives random damage to a book: it converts or fails with a typed error, never hangs or throws another kind', async () => {
    const original = book();
    let state = 0x9e3779b9;
    const next = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % bound;
    };
    for (let round = 0; round < 120; round += 1) {
      const damaged = Buffer.from(original);
      const kind = round % 3;
      if (kind === 0) for (let hit = 0; hit < 1 + next(8); hit += 1) damaged[next(damaged.length)] = next(256);
      const bytes = kind === 1 ? damaged.subarray(0, 1 + next(damaged.length)) : kind === 2 ? Buffer.concat([damaged.subarray(0, next(damaged.length)), damaged.subarray(next(damaged.length))]) : damaged;
      try {
        await convertFile(bytes, 'fb2', 'epub', {}, 'fuzz.fb2');
      } catch (error) {
        expect(error, `round ${round}`).toBeInstanceOf(ConversionFailedError);
      }
    }
  }, 120_000);
});
