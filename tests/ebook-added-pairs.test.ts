import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { textOfEpub } from '../bench/families/ebook';
import { CORPUS_DIR } from '../bench/config';
import { wordF1 } from '../bench/text-metrics';
import { convertFile } from '../src/lib/conversions';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { CALIBRE_EBOOK_TARGETS } from '../src/lib/conversions/calibre-ebook-targets';
import { requiresNativeEngine } from '../src/lib/conversions/native-engine-pairs';
import { convertWithCalibre, type CalibreDeps } from '../src/worker/ebook-calibre';
import { ConversionFailedError, UnsupportedTargetError } from '../src/lib/types';
import { extractTextWithExternalPdftotext, requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { buildStoredRar4 } from './helpers/rar4-stored';
import { normalizeWhitespace, sofficeConvert } from './helpers/soffice-office';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 232).
runWithoutFileConfinement();

/**
 * The e-book pairs the registry offers from EPUB, FB2, MOBI, AZW, AZW3, PRC, CBZ and CBR (docs/policy-decisions.md,
 * "E-book pairs added"): the RTF of a book, a PRC book to the targets of a MOBI one, and a comic archive as a PDF, an image
 * book and the text of its lettering. The book is the corpus book of the ebook benchmark, whose text the benchmark scores
 * every output against; each output is read back by a tool that is not the converter (LibreOffice for RTF, the spine reader
 * of the benchmark for EPUB, Poppler for PDF, Tesseract for lettering). The calibre targets are read back in
 * tests/ebook-calibre-writers.test.ts.
 */

const NATIVE_TIMEOUT_MS = 180_000;
const OCR_TIMEOUT_MS = 240_000;
const EBOOKS = path.join(CORPUS_DIR, 'ebooks');
const book = (name: string): Buffer => fs.readFileSync(path.join(EBOOKS, name));
const truth = book('book.gt.txt').toString('utf8');
const MIN_WORD_F1 = 0.97;

/** The text LibreOffice reads from an RTF file. */
function rtfText(rtf: Buffer): string {
  return sofficeConvert(rtf, 'rtf', 'txt:Text', 'txt').toString('utf-8');
}

describe('the registry offers the added pairs', () => {
  const ADDED: Readonly<Record<string, readonly string[]>> = {
    epub: ['azw3', 'lrf', 'mobi', 'oeb', 'pdb', 'rtf'],
    fb2: ['azw3', 'lrf', 'mobi', 'oeb', 'pdb', 'rtf'],
    mobi: ['rtf'],
    azw: ['rtf'],
    azw3: ['rtf'],
    prc: ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    cbz: ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'rtf', 'txt'],
    cbr: ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
  };

  it('lists each pair and counts 41 of them', () => {
    for (const [source, targets] of Object.entries(ADDED)) expect(FORMAT_REGISTRY[source].targetFormats).toEqual(expect.arrayContaining([...targets]));
    expect(Object.values(ADDED).reduce((total, targets) => total + targets.length, 0)).toBe(41);
  });

  it('marks the calibre targets of the added sources as native-engine pairs', () => {
    for (const [source, targets] of Object.entries(ADDED)) {
      for (const target of targets.filter((t) => CALIBRE_EBOOK_TARGETS.has(t))) expect(requiresNativeEngine(source, target)).toBe(true);
    }
  });
});

describe('RTF from the books with a reader', () => {
  const SOURCES = [
    ['epub', 'book.epub'],
    ['fb2', 'book.fb2'],
    ['mobi', 'book.mobi'],
    // A Kindle book of either generation and a Palm-named Mobipocket book are read by the MOBI reader.
    ['azw', 'book.mobi'],
    ['azw3', 'book.mobi'],
    ['prc', 'book.mobi'],
  ] as const;

  for (const [source, file] of SOURCES) {
    oracleTest(`${source} -> rtf holds the text of the book, read back by LibreOffice`, ['soffice'], async () => {
      const result = await convertFile(book(file), source, 'rtf', {}, `book.${source}`);
      expect(result.filename).toBe('book.rtf');
      expect(result.mimeType).toBe('application/rtf');
      expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('{\\rtf');
      const text = rtfText(result.buffer);
      expect(wordF1(truth, text)).toBeGreaterThan(MIN_WORD_F1);
      expect(text).toContain('café');
      expect(text).toContain('Tide & Timber');
    }, NATIVE_TIMEOUT_MS);
  }
});

describe('PRC books', () => {
  it('read like the MOBI book of the same bytes for every target the in-process engine writes', async () => {
    const mobi = await convertFile(book('book.mobi'), 'mobi', 'txt', {}, 'book.mobi');
    const prc = await convertFile(book('book.mobi'), 'prc', 'txt', {}, 'book.prc');
    expect(prc.filename).toBe('book.txt');
    expect(prc.buffer.equals(mobi.buffer)).toBe(true);
    expect(wordF1(truth, prc.buffer.toString('utf-8'))).toBeGreaterThan(MIN_WORD_F1);
  }, NATIVE_TIMEOUT_MS);

  it('prc -> epub keeps the text, the chapters and the picture of the book', async () => {
    const result = await convertFile(book('book.mobi'), 'prc', 'epub', {}, 'book.prc');
    expect(result.filename).toBe('book.epub');
    expect(wordF1(truth, await textOfEpub(result.buffer))).toBeGreaterThan(MIN_WORD_F1);
    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files).filter((name) => /\.(png|jpe?g|gif)$/.test(name))).toHaveLength(1);
  }, NATIVE_TIMEOUT_MS);

  oracleTest('prc -> pdf holds the text of the book, read back by pdftotext', ['pdftotext'], async () => {
    const result = await convertFile(book('book.mobi'), 'prc', 'pdf', {}, 'book.prc');
    expect(result.filename).toBe('book.pdf');
    expect(wordF1(truth, extractTextWithExternalPdftotext(result.buffer) ?? '')).toBeGreaterThan(MIN_WORD_F1);
  }, NATIVE_TIMEOUT_MS);

  it('refuses a file that is not a Palm database, and a calibre target without the program', async () => {
    await expect(convertFile(Buffer.from('plain text pretending to be a prc'.padEnd(120)), 'prc', 'txt', {}, 'x.prc')).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(convertFile(book('book.mobi'), 'prc', 'mobi', {}, 'book.prc')).rejects.toMatchObject({ engineName: 'ebook-convert' });
  });
});

// ---------------------------------------------------------------------------
// Comic archives
// ---------------------------------------------------------------------------

/** A page image whose width tells it apart, with a word written on it for OCR. */
async function comicPage(word: string, width: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="320"><rect width="100%" height="100%" fill="white"/><text x="20" y="200" font-family="DejaVu Sans, Arial, sans-serif" font-size="96" font-weight="bold" fill="black">${word}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function cbz(pages: Record<string, Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(pages)) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Pixel widths of the images of a PDF in page order, as `pdfimages -list` prints them. */
function pdfImageWidths(pdf: Buffer): number[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-pdfimages-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    const listing = execFileSync(requireOracleTool('pdfimages'), ['-list', path.join(dir, 'in.pdf')], { encoding: 'utf-8' });
    return listing
      .split('\n')
      .slice(2)
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns[2] === 'image')
      .map((columns) => Number(columns[3]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The pictures of an image book in reading order: the spine's content documents name them, the package holds them. */
async function bookPictureWidths(epub: Buffer): Promise<{ widths: number[]; cover: string | undefined; text: string }> {
  const zip = await JSZip.loadAsync(epub);
  const opfPath = /full-path="([^"]+)"/.exec((await zip.file('META-INF/container.xml')?.async('string')) ?? '')?.[1] as string;
  const opf = (await zip.file(opfPath)?.async('string')) ?? '';
  const base = path.posix.dirname(opfPath);
  const manifest = new Map<string, string>();
  for (const item of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(item[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(item[0])?.[1];
    if (id && href) manifest.set(id, href);
  }
  const widths: number[] = [];
  let text = '';
  for (const itemref of opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)) {
    const html = (await zip.file(path.posix.join(base, manifest.get(itemref[1]) as string))?.async('string')) ?? '';
    text += html.replace(/<(?:head|style)\b[\s\S]*?<\/(?:head|style)>/gi, ' ').replace(/<[^>]+>/g, ' ');
    for (const image of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
      const bytes = await zip.file(path.posix.join(base, decodeURIComponent(image[1])))?.async('nodebuffer');
      widths.push((await sharp(bytes as Buffer).metadata()).width as number);
    }
  }
  const cover = /<item\b[^>]*\bproperties="[^"]*cover-image[^"]*"[^>]*\bhref="([^"]+)"|<item\b[^>]*\bhref="([^"]+)"[^>]*\bproperties="[^"]*cover-image/.exec(opf);
  return { widths, cover: cover?.[1] ?? cover?.[2], text };
}

const WORDS = ['ALPHA', 'BRAVO', 'CHARLIE'];

describe.each(['cbz', 'cbr'] as const)('%s comic archives', (source) => {
  async function archive(pages: Record<string, Buffer>): Promise<Buffer> {
    if (source === 'cbz') return cbz(pages);
    return buildStoredRar4(Object.entries(pages).map(([name, data]) => ({ name, data })));
  }
  const named = async () => ({ 'page10.png': await comicPage(WORDS[2], 430), 'page2.png': await comicPage(WORDS[1], 420), 'page1.png': await comicPage(WORDS[0], 410) });

  oracleTest(`${source} -> pdf binds the pages in natural name order`, ['pdfimages'], async () => {
    const result = await convertFile(await archive(await named()), source, 'pdf', {}, `comic.${source}`);
    expect(result.filename).toBe('comic.pdf');
    expect(pdfImageWidths(result.buffer)).toEqual([410, 420, 430]);
  }, NATIVE_TIMEOUT_MS);

  it(`${source} -> epub is an image book: one picture per page in page order, the first as the cover`, async () => {
    const result = await convertFile(await archive(await named()), source, 'epub', {}, `comic.${source}`);
    expect(result.filename).toBe('comic.epub');
    expect(result.mimeType).toBe('application/epub+zip');
    const read = await bookPictureWidths(result.buffer);
    expect(read.widths).toEqual([410, 420, 430]);
    expect(read.cover).toBeDefined();
    // The book holds pictures and no invented text.
    expect(normalizeWhitespace(read.text).replace(/Page \d+/g, '').trim()).toBe('');
  }, NATIVE_TIMEOUT_MS);

  oracleTest(`${source} -> txt and rtf read the lettering of the pages with OCR, in page order`, ['tesseract', 'soffice'], async () => {
    const pages = { 'p1.png': await comicPage('HELLO', 700), 'p2.png': await comicPage('WORLD', 700) };
    const input = await archive(pages);
    const txt = (await convertFile(input, source, 'txt', {}, `comic.${source}`)).buffer.toString('utf-8').toUpperCase();
    expect(txt.indexOf('HELLO')).toBeGreaterThanOrEqual(0);
    expect(txt.indexOf('WORLD')).toBeGreaterThan(txt.indexOf('HELLO'));
    const rtf = await convertFile(input, source, 'rtf', {}, `comic.${source}`);
    const rtfWords = rtfText(rtf.buffer).toUpperCase();
    expect(rtfWords.indexOf('WORLD')).toBeGreaterThan(rtfWords.indexOf('HELLO'));
  }, OCR_TIMEOUT_MS);

  oracleTest(`${source} pages with no lettering are a typed error for the text targets, never an empty file`, ['tesseract'], async () => {
    const blank = await sharp({ create: { width: 600, height: 400, channels: 3, background: 'white' } }).png().toBuffer();
    const input = await archive({ 'p.png': blank });
    for (const target of ['txt', 'rtf'] as const) {
      const run = convertFile(input, source, target, {}, `blank.${source}`);
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/PDF OCR failed: Optical character recognition failed to detect readable text/);
    }
    // The image book of the same pages is still a book of pictures.
    expect((await bookPictureWidths((await convertFile(input, source, 'epub', {}, `blank.${source}`)).buffer)).widths).toEqual([600]);
  }, OCR_TIMEOUT_MS);

  it(`refuses an archive without pages, a damaged page, and a target it does not offer, with typed errors`, async () => {
    await expect(convertFile(await archive({ 'readme.txt': Buffer.from('no pictures') }), source, 'epub', {}, `x.${source}`)).rejects.toThrow(/holds no page images/);
    await expect(convertFile(await archive({ 'p.png': Buffer.from('not a png') }), source, 'epub', {}, `x.${source}`)).rejects.toThrow(/page "p\.png" cannot be decoded/);
    await expect(convertFile(await archive({ 'p.png': Buffer.from('not a png') }), source, 'pdf', {}, `x.${source}`)).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(convertFile(await archive(await named()), source, 'docx', {}, `x.${source}`)).rejects.toBeInstanceOf(UnsupportedTargetError);
  });
});

describe('cbr -> pdf of a file that is not a RAR archive', () => {
  it('is a typed 400 error', async () => {
    const run = convertFile(Buffer.from('this is not a rar archive at all'.padEnd(64)), 'cbr', 'pdf', {}, 'x.cbr');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// The route to the calibre targets
// ---------------------------------------------------------------------------

describe('what calibre is given for the added sources', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-added-pairs-'));
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  /** A stand-in `ebook-convert` that keeps the book it was given and writes a minimal MOBI. */
  function keepingProgram(): { program: string; kept: string } {
    const kept = path.join(workDir, 'kept-book');
    const program = path.join(workDir, 'ebook-convert');
    fs.writeFileSync(
      program,
      `#!${process.execPath}\nconst fs = require('node:fs');\nconst [input, output] = process.argv.slice(2);\nfs.copyFileSync(input, ${JSON.stringify(kept)} + '.' + input.split('.').pop());\nconst book = Buffer.alloc(80); book.write('BOOKMOBI', 60, 'latin1'); fs.writeFileSync(output, book);\n`,
      { mode: 0o755 }
    );
    return { program, kept };
  }

  /** The conversion of the source into EPUB by the worker's own converters, as the worker runs it. */
  const deps: CalibreDeps = {
    async convert(input, src, target, options, originalFilename) {
      const result = await convertFile(input as Buffer, src, target, options, originalFilename);
      return { buffer: result.buffer, mimeType: result.mimeType, filename: result.filename, size: result.size, engineUsed: 'internal-fallback', executionTimeMs: 0 };
    },
    discardOutput() {},
  };

  const keptFile = (kept: string, extension: string): Buffer => fs.readFileSync(`${kept}.${extension}`);

  it('hands a PRC book over as it is', async () => {
    const { program, kept } = keepingProgram();
    const input = book('book.mobi');
    const result = await convertWithCalibre(deps, { input, src: 'prc', tgt: 'mobi', options: {}, originalFilename: 'book.prc' }, program);
    expect(keptFile(kept, 'prc').equals(input)).toBe(true);
    fs.rmSync(result.filePath as string, { force: true });
  });

  it('gives calibre the EPUB the project writes from an FB2 book, and from a comic archive an image book', async () => {
    const { program, kept } = keepingProgram();
    const fb2 = await convertWithCalibre(deps, { input: book('book.fb2'), src: 'fb2', tgt: 'azw3', options: {}, originalFilename: 'book.fb2' }, program);
    expect(wordF1(truth, await textOfEpub(keptFile(kept, 'epub')))).toBeGreaterThan(MIN_WORD_F1);
    fs.rmSync(fb2.filePath as string, { force: true });
    const comic = await convertWithCalibre(deps, { input: await cbz({ 'p1.png': await comicPage('ONE', 400), 'p2.png': await comicPage('TWO', 500) }), src: 'cbz', tgt: 'lrf', options: {}, originalFilename: 'c.cbz' }, program).catch(() => undefined);
    // The stand-in writes a MOBI, so the LRF signature check ends the run; what calibre was given is what is read.
    expect(comic).toBeUndefined();
    expect((await bookPictureWidths(keptFile(kept, 'epub'))).widths).toEqual([400, 500]);
  }, NATIVE_TIMEOUT_MS);

  /** A package whose content documents link to, style from and show a file of the host, and whose manifest may name another one outside the package. */
  async function craftedEpub(secret: string, escapingManifest: boolean): Promise<Buffer> {
    const outside = `${'../'.repeat(12)}${secret.slice(1)}`;
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file(
      'OEBPS/content.opf',
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x</dc:identifier><dc:title>Crafted</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>${escapingManifest ? `<item id="s" href="${outside}" media-type="application/xhtml+xml"/>` : ''}</manifest><spine><itemref idref="c"/>${escapingManifest ? '<itemref idref="s"/>' : ''}</spine></package>`
    );
    zip.file(
      'OEBPS/c.xhtml',
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title><link rel="stylesheet" href="file://${secret}"/></head><body><h1>Crafted</h1><p>Visible text. <a href="file://${secret}">local</a> <a href="${outside}">relative</a> <img src="file://${secret}" alt="x"/> <img src="${outside}" alt="y"/></p></body></html>`
    );
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  it('never gives calibre the uploaded EPUB: links, styles and pictures that name a file of the host are not in the book it gets', async () => {
    const secret = path.join(workDir, 'secret.txt');
    fs.writeFileSync(secret, 'CANARY-LOCAL-FILE-CONTENT');
    const crafted = await craftedEpub(secret, false);
    const { program, kept } = keepingProgram();
    const result = await convertWithCalibre(deps, { input: crafted, src: 'epub', tgt: 'mobi', options: {}, originalFilename: 'crafted.epub' }, program);
    const staged = keptFile(kept, 'epub');
    expect(staged.equals(crafted)).toBe(false);
    const packaged = await JSZip.loadAsync(staged);
    const everything = (await Promise.all(Object.values(packaged.files).filter((entry) => !entry.dir).map((entry) => entry.async('string')))).join('\n');
    expect(everything).toContain('Visible text.');
    expect(everything).not.toContain('CANARY');
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain('file://');
    expect(everything).not.toContain('../');
    fs.rmSync(result.filePath as string, { force: true });
  });

  const HOSTILE_SVG = (secret: string) =>
    `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file://${secret}">]><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><style>@import url(file://${secret}.css);</style><image xlink:href="file://${secret}.png" width="10" height="10"/><text>&x;</text></svg>`;

  it('leaves the SVG pictures of an uploaded EPUB out of the book calibre gets, keeping their text alternative', async () => {
    const secret = path.join(workDir, 'secret.txt');
    const zip = await JSZip.loadAsync(await craftedEpub(secret, false));
    const opf = (await zip.file('OEBPS/content.opf')!.async('string')).replace('</manifest>', '<item id="v" href="v.svg" media-type="image/svg+xml"/></manifest>');
    zip.file('OEBPS/content.opf', opf);
    zip.file('OEBPS/v.svg', HOSTILE_SVG(secret));
    zip.file('OEBPS/c.xhtml', (await zip.file('OEBPS/c.xhtml')!.async('string')).replace('</p>', ' <img src="v.svg" alt="VECTOR-ALT"/></p>'));
    const { program, kept } = keepingProgram();
    const result = await convertWithCalibre(deps, { input: await zip.generateAsync({ type: 'nodebuffer' }), src: 'epub', tgt: 'mobi', options: {}, originalFilename: 'svg.epub' }, program);
    const packaged = await JSZip.loadAsync(keptFile(kept, 'epub'));
    const names = Object.keys(packaged.files);
    expect(names.some((name) => name.toLowerCase().endsWith('.svg'))).toBe(false);
    const everything = (await Promise.all(Object.values(packaged.files).filter((entry) => !entry.dir).map((entry) => entry.async('string')))).join('\n');
    for (const needle of ['file:', '<!ENTITY', '@import', 'xlink:href', 'image/svg+xml']) expect(everything).not.toContain(needle);
    fs.rmSync(result.filePath as string, { force: true });
  });

  it('refuses an EPUB written for calibre that still packages an SVG document', async () => {
    const { assertNoVectorImages } = await import('../src/lib/conversions/epub-rewrite');
    const zip = await JSZip.loadAsync(await craftedEpub(path.join(workDir, 'secret.txt'), false));
    zip.file('OEBPS/content.opf', (await zip.file('OEBPS/content.opf')!.async('string')).replace('</manifest>', '<item id="v" href="v.svg" media-type="image/svg+xml"/></manifest>'));
    zip.file('OEBPS/v.svg', HOSTILE_SVG('/etc/hosts'));
    await expect(assertNoVectorImages(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/SVG picture/);
    await expect(assertNoVectorImages(await craftedEpub(path.join(workDir, 'secret.txt'), false))).resolves.toBeUndefined();
  });

  it('refuses an EPUB whose manifest names a file outside the package before calibre starts', async () => {
    const secret = path.join(workDir, 'secret.txt');
    fs.writeFileSync(secret, 'CANARY-LOCAL-FILE-CONTENT');
    const { program, kept } = keepingProgram();
    const run = convertWithCalibre(deps, { input: await craftedEpub(secret, true), src: 'epub', tgt: 'mobi', options: {}, originalFilename: 'crafted.epub' }, program);
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/points outside the package/);
    expect(fs.existsSync(`${kept}.epub`)).toBe(false);
  });
});
