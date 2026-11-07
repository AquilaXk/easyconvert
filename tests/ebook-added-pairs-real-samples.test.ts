import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { isCalibreEbookTarget } from '../src/lib/conversions/calibre-ebook-targets';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { calibreBinary, textOfCalibreTarget } from './helpers/calibre-books';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { sofficeConvert } from './helpers/soffice-office';

/**
 * Real files for the e-book pairs added to the registry (docs/policy-decisions.md, "E-book pairs added"): two Kindle books of the
 * Open Preservation Foundation format corpus and a public Kindle edition of a novel (to RTF), and comic archives of the Internet
 * Archive and of a viewer's test data (to a PDF and an image book). The oracles are tools that are not the converter: LibreOffice
 * for RTF, `pdfimages` and `pdfinfo` for PDF, the file listing of 7-Zip for the pages of an archive, calibre for the books it writes.
 */

const CONVERSION_TIMEOUT_MS = 300_000;
const LOREM = ['opf-lorem-ipsum-0857.azw3', 'opf-lorem-ipsum-090.azw3'] as const;
const PHRASES = ['variatio ipsius', 'lorem ipsum dolor sit amet consectetur adipiscing elit', 'to the extent possible under law andrew jackson has waived all copyright'];
const IMAGE_ENTRY = /\.(png|jpe?g|webp|bmp|gif)$/i;

const sofficeMissing = skipWithoutTools('soffice');
const pdfToolsMissing = skipWithoutTools('pdfimages', 'pdfinfo');
const sevenZipMissing = skipWithoutTools('7z');
const calibreMissing = skipUnless('ebook-convert', calibreBinary !== null);

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The text LibreOffice reads from an RTF file. */
function rtfWords(rtf: Buffer): string[] {
  return wordsOf(sofficeConvert(rtf, 'rtf', 'txt:Text', 'txt').toString('utf-8'));
}

describe.each(LOREM)('the real Kindle book %s to RTF', (id) => {
  it.skipIf(sofficeMissing)('holds the words that the book gives as plain text, read back by LibreOffice', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    const rtf = await convertFile(bytes, 'azw3', 'rtf', {}, id);
    expect(rtf.filename).toBe(`${id.replace(/\.azw3$/, '')}.rtf`);
    const words = rtfWords(rtf.buffer);
    expect(words).toEqual(wordsOf((await convertFile(bytes, 'azw3', 'txt', {}, id)).buffer.toString('utf-8')));
    for (const phrase of PHRASES) expect(words.join(' ')).toContain(phrase);
  }, CONVERSION_TIMEOUT_MS);
});

describe('the real public Kindle edition to RTF', () => {
  it.skipIf(sofficeMissing)('holds the words of the book that its plain text holds', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'gutenberg-pg11-images.azw3');
    const words = rtfWords((await convertFile(bytes, 'azw3', 'rtf', {}, 'alice.azw3')).buffer);
    const plain = wordsOf((await convertFile(bytes, 'azw3', 'txt', {}, 'alice.azw3')).buffer.toString('utf-8'));
    expect(plain.length).toBeGreaterThan(20_000);
    expect(words).toEqual(plain);
  }, CONVERSION_TIMEOUT_MS);
});

/** The names of the pictures in a comic archive, by 7-Zip's listing. */
function pagesOfArchive(archive: Buffer, extension: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-listing-'));
  try {
    const file = path.join(dir, `in.${extension}`);
    fs.writeFileSync(file, archive);
    const listing = execFileSync(requireOracleTool('7z'), ['l', '-ba', '-slt', file], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    return [...listing.matchAll(/^Path = (.+)$/gm)].map((match) => match[1]).filter((name) => IMAGE_ENTRY.test(name) && !/(^|\/)(__MACOSX\/|\.[^/]*$)/.test(name));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pdfPageCount(pdf: Buffer): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-pdfinfo-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    return Number(/Pages:\s+(\d+)/.exec(execFileSync(requireOracleTool('pdfinfo'), [path.join(dir, 'in.pdf')], { encoding: 'utf-8' }))?.[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The content documents of an image book that name a picture, and the pictures the package holds. */
async function imageBookCounts(epub: Buffer): Promise<{ referenced: number; packaged: number }> {
  const zip = await JSZip.loadAsync(epub);
  let referenced = 0;
  for (const name of Object.keys(zip.files).filter((entry) => /\.xhtml$/.test(entry) && !/nav\.xhtml$/.test(entry))) {
    referenced += [...((await zip.file(name)?.async('string')) ?? '').matchAll(/<img\b/g)].length;
  }
  return { referenced, packaged: Object.keys(zip.files).filter((entry) => /\.(png|jpe?g|gif)$/i.test(entry)).length };
}

const COMICS = [
  { id: 'okular-rotated_cb.cbz', source: 'cbz' },
  { id: 'ia-ppg-crossover-aniso-2.cbz', source: 'cbz' },
  { id: 'ia-gene-autry-four-color-66.cbr', source: 'cbr' },
] as const;

describe.each(COMICS)('the real comic archive $id', ({ id, source }) => {
  // skip-ok: a RAR comic is unpacked by unrar, which only some hosts have; the suite names it in strict mode
  const unrarMissing = source === 'cbr' ? skipWithoutTools('unrar') : false;

  it.skipIf(pdfToolsMissing || sevenZipMissing || unrarMissing)('binds every page into a PDF', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    const pages = pagesOfArchive(bytes, source);
    expect(pages.length).toBeGreaterThan(0);
    const pdf = await convertFile(bytes, source, 'pdf', {}, id);
    expect(pdf.filename).toBe(`${id.replace(/\.[a-z]+$/, '')}.pdf`);
    expect(pdfPageCount(pdf.buffer)).toBe(pages.length);
  }, CONVERSION_TIMEOUT_MS);

  it.skipIf(sevenZipMissing || unrarMissing)('is an image book with a picture for every page', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    const pages = pagesOfArchive(bytes, source);
    const epub = await convertFile(bytes, source, 'epub', {}, id);
    expect(await imageBookCounts(epub.buffer)).toEqual({ referenced: pages.length, packaged: pages.length });
  }, CONVERSION_TIMEOUT_MS);

  // skip-ok: the five books are written by calibre, which only some hosts have; the suite names it in strict mode
  it.skipIf(calibreMissing || sevenZipMissing || unrarMissing)('is written to the Palm, Kindle, Sony and Open eBook targets, each read back by calibre', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    for (const target of FORMAT_REGISTRY[source].targetFormats.filter(isCalibreEbookTarget)) {
      const output = await dispatchConversion(bytes, source, target, {}, id);
      expect(output.filename, target).toBe(`${id.replace(/\.[a-z]+$/, '')}.${target === 'oeb' ? 'zip' : target}`);
      expect(output.size, target).toBeGreaterThan(0);
      // A comic holds pictures: calibre reads the book back, and its text is whatever the pages carry.
      await expect(textOfCalibreTarget(output.buffer, target), target).resolves.toBeTypeOf('string');
    }
  }, CONVERSION_TIMEOUT_MS * 2);
});
