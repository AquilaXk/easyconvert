import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { getOracleToolPath, extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { pdfinfoPages } from './helpers/encrypted-pdf-fixtures';
import { requireRealworldSample } from './helpers/realworld-sample';
import { sofficeConvert } from './helpers/soffice-convert';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The document and PDF pairs of entry 183: Word macro and template files, text and markup documents and PDFs written as
 * Word 97-2003, RTF, page pictures and the other page formats. Each class converts a real or authored input through the
 * dispatcher and the output is read back by a program that is not the converter: LibreOffice (printing the output to a PDF,
 * read by pdftotext), Tesseract on the page pictures, the Ghostscript text writer on PostScript, ImageMagick on the rasters,
 * and the package parts of the XPS and OpenDocument outputs. The Pages and AbiWord pairs are checked on real files in
 * tests/office-suite-real-samples.test.ts, which also checks the coverage of the registry.
 */

const TIMEOUT_MS = 300_000;
const MIN_WORD_LENGTH = 4;
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const LEGACY_STREAM: Readonly<Record<string, string>> = { doc: 'WordDocument', ppt: 'PowerPoint Document' };
/** Share of the words of the source that may be missing from what the reader finds in the output. */
const MAX_MISSING_SHARE = 0.1;

const fixture = (relative: string): Buffer => fs.readFileSync(path.join(__dirname, 'fixtures', relative));
const normalized = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const wordsOf = (text: string): string[] => normalized(text).split(' ').filter((word) => word.length >= MIN_WORD_LENGTH);

/** The text of an Office or RTF output, as the office suite prints it and Poppler reads it. */
function printedText(output: Buffer, target: string): string {
  return sofficeConvert(output, `out.${target}`, 'pdf', (pdf) => extractTextWithExternalPdftotext(pdf.read()) ?? '');
}

function expectWordsPresent(source: string, text: string, label: string): void {
  const have = new Set(wordsOf(text));
  const wanted = [...new Set(wordsOf(source))];
  const missing = wanted.filter((word) => !have.has(word));
  expect({ label, missing: missing.slice(0, 8), within: missing.length <= wanted.length * MAX_MISSING_SHARE }).toEqual({ label, missing: missing.slice(0, 8), within: true });
}

function expectLegacyContainer(output: Buffer, target: string): void {
  expect(output.subarray(0, COMPOUND_FILE_SIGNATURE.length).equals(COMPOUND_FILE_SIGNATURE)).toBe(true);
  expect(output.includes(Buffer.from(LEGACY_STREAM[target], 'utf16le'))).toBe(true);
}

/** The pictures of an output: the file itself, or the entries of the ZIP that a document of several pages arrives in, in page order. */
async function pagePictures(output: Buffer): Promise<Buffer[]> {
  if (output.subarray(0, 2).toString('latin1') !== 'PK') return [output];
  const archive = await JSZip.loadAsync(output);
  return Promise.all(
    Object.keys(archive.files)
      .sort()
      .map(async (name) => Buffer.from(await archive.files[name].async('uint8array')))
  );
}

function withTempDirectory<T>(use: (directory: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-pairs-'));
  try {
    return use(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function withTempDirectoryAsync<T>(use: (directory: string) => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-pairs-'));
  try {
    return await use(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Tesseract's reading of a picture. */
function recognizedText(picture: Buffer): string {
  return withTempDirectory((directory) => {
    const file = path.join(directory, 'page.png');
    fs.writeFileSync(file, picture);
    return execFileSync(getOracleToolPath('tesseract') ?? 'tesseract', [file, '-', '--psm', '6'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  });
}

/** Page count and first page size in points of a PDF, from Poppler's pdfinfo. */
function pdfPages(pdf: Buffer): { count: number; width: number; height: number } {
  const size = withTempDirectory((directory) => {
    const file = path.join(directory, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const info = execFileSync(getOracleToolPath('pdfinfo') ?? 'pdfinfo', [file], { encoding: 'utf-8' });
    const match = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
    return { width: Number(match?.[1]), height: Number(match?.[2]) };
  });
  return { count: pdfinfoPages(pdf), ...size };
}

/** The PDF the office suite prints of an input: the pages that its pictures have to match. */
function printedPdf(input: Buffer, name: string): Buffer {
  return sofficeConvert(input, name, 'pdf', (pdf) => pdf.read());
}

async function expectPictures(output: Buffer, target: 'png' | 'jpg', printed: { count: number; width: number; height: number }, label: string): Promise<Buffer[]> {
  const pictures = await pagePictures(output);
  expect({ label, pages: pictures.length }).toEqual({ label, pages: printed.count });
  for (const picture of pictures) {
    const metadata = await sharp(picture).metadata();
    expect(metadata.format).toBe(target === 'png' ? 'png' : 'jpeg');
    expect(Math.abs((metadata.width ?? 0) / (metadata.height ?? 1) - printed.width / printed.height), `${label} aspect ratio`).toBeLessThan(0.01);
  }
  const { channels } = await sharp(pictures[0]).stats();
  expect(Math.max(...channels.map((channel) => channel.max - channel.min)), `${label} first page is not one flat colour`).toBeGreaterThan(0);
  return pictures;
}

describe.skipIf(skipWithoutTools('soffice', 'pdftotext', 'pdfinfo', 'pdftoppm'))('Word macro files and templates as Word 97-2003, RTF, OpenDocument and page pictures', () => {
  const CASES = [
    { id: 'office-60158.docm', extension: 'docm', targets: ['doc', 'rtf', 'odt', 'docx', 'png', 'jpg'], phrases: ['now is the time for all good men to come to the aid of their country', 'the quick brown foxy jumps over the lazy dog'] },
    { id: 'office-document-60316.dotx', extension: 'dotx', targets: ['doc', 'rtf', 'png', 'jpg'], phrases: ['getting the perfect job might be challenging'] },
  ] as const;
  for (const { id, extension, targets, phrases } of CASES) {
    it(
      `${id} as .${extension} converts to ${targets.join(', ')}`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const printed = pdfPages(printedPdf(bytes, id));
        for (const target of targets) {
          const label = `${id} -> ${target}`;
          const result = await dispatchConversion(bytes, extension, target, {}, id);
          if (target === 'png' || target === 'jpg') {
            await expectPictures(result.buffer, target, printed, label);
            continue;
          }
          if (target === 'doc') expectLegacyContainer(result.buffer, target);
          if (target === 'rtf') expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('{\\rtf');
          if (target === 'docx') expect((await JSZip.loadAsync(result.buffer)).file('word/document.xml')).not.toBeNull();
          const text = normalized(printedText(result.buffer, target));
          expect({ label, missing: phrases.filter((phrase) => !text.includes(phrase)) }).toEqual({ label, missing: [] });
          // A macro project never travels into the result.
          if (target === 'docx') expect(Object.keys((await JSZip.loadAsync(result.buffer)).files).some((name) => /vbaProject/i.test(name))).toBe(false);
        }
      },
      TIMEOUT_MS
    );
  }
});

const TEXT_SENTENCES = [
  'The harbour master counted seventeen lanterns along the northern breakwater.',
  'Each lantern burned a different colour of oil, and the pilots learned the order by heart.',
  'During the storm of the third winter the keeper relit them one by one with a borrowed ladder.',
];
/** A document of several printed pages: the same paragraphs repeated under numbered headings. */
function repeated(render: (heading: string, paragraph: string) => string): string {
  const parts: string[] = [];
  for (let section = 1; section <= 14; section += 1) parts.push(render(`Section ${section}`, TEXT_SENTENCES.map((sentence) => `${sentence} (${section})`).join(' ').repeat(3)));
  return parts.join('');
}
const TEXT_SOURCES: Readonly<Record<string, { bytes: Buffer }>> = {
  txt: { bytes: Buffer.from(repeated((heading, paragraph) => `${heading}\n\n${paragraph}\n\n`), 'utf-8') },
  md: { bytes: Buffer.from(repeated((heading, paragraph) => `## ${heading}\n\n${paragraph}\n\n`), 'utf-8') },
  html: { bytes: Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lanterns</title></head><body>${repeated((heading, paragraph) => `<h2>${heading}</h2><p>${paragraph}</p>`)}</body></html>`, 'utf-8') },
};

describe.skipIf(skipWithoutTools('soffice', 'pdftotext', 'pdfinfo', 'pdftoppm', 'tesseract'))('text, Markdown and HTML as Word 97-2003, RTF and page pictures', () => {
  for (const [extension, { bytes }] of Object.entries(TEXT_SOURCES)) {
    for (const target of ['doc', 'rtf'] as const) {
      it(
        `.${extension} to .${target} holds the words of the document`,
        async () => {
          const result = await dispatchConversion(bytes, extension, target, {}, `lanterns.${extension}`);
          expect(result.engineUsed).toMatch(/^native-soffice/);
          if (target === 'doc') expectLegacyContainer(result.buffer, target);
          else expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('{\\rtf');
          expectWordsPresent(TEXT_SENTENCES.join(' '), printedText(result.buffer, target), `${extension} -> ${target}`);
        },
        TIMEOUT_MS
      );
    }
    for (const target of ['png', 'jpg'] as const) {
      it(
        `.${extension} to .${target} is one picture for each page of the PDF of the same document, and the first reads back`,
        async () => {
          const pdf = (await dispatchConversion(bytes, extension, 'pdf', {}, `lanterns.${extension}`)).buffer;
          const printed = pdfPages(pdf);
          expect(printed.count).toBeGreaterThan(1);
          const result = await dispatchConversion(bytes, extension, target, {}, `lanterns.${extension}`);
          expect(result.engineUsed).toBe('native-poppler');
          const pictures = await expectPictures(result.buffer, target, printed, `${extension} -> ${target}`);
          const first = normalized(recognizedText(await sharp(pictures[0]).png().toBuffer()));
          expect(first).toContain('harbour master counted seventeen lanterns');
          // The first page of the request alone is the first page of the pictures.
          const firstOnly = await dispatchConversion(bytes, extension, target, { multiPageOutput: 'first' }, `lanterns.${extension}`);
          expect(firstOnly.buffer.subarray(0, 2).toString('latin1')).not.toBe('PK');
          expect((await sharp(firstOnly.buffer).metadata()).width).toBe((await sharp(pictures[0]).metadata()).width);
        },
        TIMEOUT_MS
      );
    }
  }

  it(
    'a page selection belongs to the pictures: the HTML pages are drawn whole and page 2 alone is written',
    async () => {
      const { bytes } = TEXT_SOURCES.html;
      const result = await dispatchConversion(bytes, 'html', 'png', { pages: '2' }, 'lanterns.html');
      const pictures = await pagePictures(result.buffer);
      expect(pictures).toHaveLength(1);
      const second = normalized(recognizedText(pictures[0]));
      expect(second).toContain('lanterns');
    },
    TIMEOUT_MS
  );

  it(
    'reStructuredText to .rtf holds the words of the document',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'pil-about.rst');
      const result = await dispatchConversion(bytes, 'rst', 'rtf', {}, 'about.rst');
      expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('{\\rtf');
      const source = bytes.toString('utf-8').replace(/^[=\-~^`.*:#]{3,}$/gm, ' ');
      expectWordsPresent(source, printedText(result.buffer, 'rtf'), 'rst -> rtf');
    },
    TIMEOUT_MS
  );

  it(
    'a Palm database (.pdb) to .rtf holds the words the office suite reads from the book',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'lo-plucker.pdb');
      const result = await dispatchConversion(bytes, 'pdb', 'rtf', {}, 'plucker.pdb');
      expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('{\\rtf');
      const reference = sofficeConvert(bytes, 'in.pdb', 'pdf', (pdf) => extractTextWithExternalPdftotext(pdf.read()) ?? '');
      expectWordsPresent(reference, printedText(result.buffer, 'rtf'), 'pdb -> rtf');
      expect(normalized(printedText(result.buffer, 'rtf'))).toContain('universal declaration of human rights');
    },
    TIMEOUT_MS
  );
});

describe.skipIf(skipWithoutTools('soffice', 'pdftotext', 'pdfinfo', 'pdftoppm'))('PDF as Word 97-2003', () => {
  const LATIN = fixture('pdf-text/latin.pdf');
  const TRUTH = fs.readFileSync(path.join(__dirname, 'fixtures', 'pdf-text', 'latin.truth.txt'), 'utf-8');

  it(
    'a PDF to .doc is the office suite\'s Word 97 export of the DOCX written of it, with the words of the PDF',
    async () => {
      const result = await dispatchConversion(LATIN, 'pdf', 'doc', {}, 'latin.pdf');
      expect(result.engineUsed).toMatch(/^native-soffice/);
      expectLegacyContainer(result.buffer, 'doc');
      expectWordsPresent(TRUTH, printedText(result.buffer, 'doc'), 'pdf -> doc');
    },
    TIMEOUT_MS
  );
});

describe.skipIf(skipWithoutTools('pdftoppm', 'pdftops', 'pdftocairo', 'pdfinfo', 'gs', 'identify', 'convert', 'tesseract', 'soffice'))('PDF as the raster formats, PostScript, DXF and OpenDocument drawing', () => {
  const MULTIPAGE = fixture('pdf-text/multipage.pdf');
  const MULTIPAGE_TRUTH = fs.readFileSync(path.join(__dirname, 'fixtures', 'pdf-text', 'multipage.truth.txt'), 'utf-8');
  const RASTER_DPI = 150;
  const POINTS_PER_INCH = 72;
  /** Mean absolute 8-bit difference allowed between two renderers of the same page (Poppler against Poppler's encoder chain). */
  const MAX_MEAN_DIFFERENCE = 12;

  /** What ImageMagick finds in a picture it decodes itself: format, width and height. */
  function identified(picture: Buffer, extension: string): { format: string; width: number; height: number } {
    return withTempDirectory((directory) => {
      const file = path.join(directory, `picture.${extension}`);
      fs.writeFileSync(file, picture);
      const [format, width, height] = execFileSync(getOracleToolPath('identify') ?? 'identify', ['-format', '%m %w %h\n', `${file}[0]`], { encoding: 'utf-8' }).trim().split('\n')[0].split(' ');
      return { format, width: Number(width), height: Number(height) };
    });
  }

  /** The first picture of a file as ImageMagick decodes it, a PNG. */
  function magickToPng(picture: Buffer, extension: string): Buffer {
    return withTempDirectory((directory) => {
      const file = path.join(directory, `picture.${extension}`);
      fs.writeFileSync(file, picture);
      return execFileSync(getOracleToolPath('convert') ?? 'convert', [`${file}[0]`, 'png:-'], { maxBuffer: 256 * 1024 * 1024 });
    });
  }

  /** The first page drawn by `pdftoppm` at the density of the request, the reference picture of every raster below. */
  async function referencePage(pdf: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
    return withTempDirectoryAsync(async (directory) => {
      fs.writeFileSync(path.join(directory, 'in.pdf'), pdf);
      execFileSync(getOracleToolPath('pdftoppm') ?? 'pdftoppm', ['-png', '-r', String(RASTER_DPI), '-f', '1', '-l', '1', '-singlefile', path.join(directory, 'in.pdf'), path.join(directory, 'ref')]);
      const { data, info } = await sharp(path.join(directory, 'ref.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height };
    });
  }

  async function expectSamePage(picture: Buffer, pdf: Buffer, label: string): Promise<void> {
    const reference = await referencePage(pdf);
    const { data, info } = await sharp(picture).flatten({ background: '#ffffff' }).removeAlpha().resize(reference.width, reference.height, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    let total = 0;
    for (let i = 0; i < data.length; i += 1) total += Math.abs(data[i] - reference.data[i]);
    expect({ label, meanDifference: total / data.length < MAX_MEAN_DIFFERENCE }).toEqual({ label, meanDifference: true });
  }

  /** The decoders that read each raster: the image library for the formats it reads, ImageMagick for the others. */
  const SHARP_READS: Readonly<Record<string, string>> = { webp: 'webp', avif: 'heif', gif: 'gif' };
  const MAGICK_READS: Readonly<Record<string, string>> = { bmp: 'BMP', psd: 'PSD' };

  it.each(['webp', 'avif', 'gif', 'bmp', 'psd'])(
    'a PDF to .%s writes one picture for each page, the size of the page at the default density',
    async (target) => {
      const result = await dispatchConversion(MULTIPAGE, 'pdf', target, {}, 'multipage.pdf');
      expect(result.engineUsed).toBe('native-poppler');
      const pictures = await pagePictures(result.buffer);
      expect(pictures).toHaveLength(pdfinfoPages(MULTIPAGE));
      const page = pdfPages(MULTIPAGE);
      let decoded: { format: string; width: number; height: number };
      let png: Buffer;
      if (SHARP_READS[target] !== undefined) {
        const metadata = await sharp(pictures[0]).metadata();
        decoded = { format: metadata.format ?? '', width: metadata.width ?? 0, height: metadata.height ?? 0 };
        png = await sharp(pictures[0]).png().toBuffer();
      } else {
        decoded = identified(pictures[0], target);
        png = magickToPng(pictures[0], target);
      }
      expect(decoded.format.startsWith(SHARP_READS[target] ?? MAGICK_READS[target])).toBe(true);
      expect(Math.abs(decoded.width - (page.width * RASTER_DPI) / POINTS_PER_INCH)).toBeLessThanOrEqual(1);
      expect(Math.abs(decoded.height - (page.height * RASTER_DPI) / POINTS_PER_INCH)).toBeLessThanOrEqual(1);
      await expectSamePage(png, MULTIPAGE, `pdf -> ${target}`);
      const firstOnly = await dispatchConversion(MULTIPAGE, 'pdf', target, { multiPageOutput: 'first' }, 'multipage.pdf');
      expect(firstOnly.buffer.subarray(0, 2).toString('latin1')).not.toBe('PK');
    },
    TIMEOUT_MS
  );

  it(
    'a PDF to .ico writes an icon no larger than the format allows for each page',
    async () => {
      const result = await dispatchConversion(MULTIPAGE, 'pdf', 'ico', {}, 'multipage.pdf');
      const icons = await pagePictures(result.buffer);
      expect(icons).toHaveLength(pdfinfoPages(MULTIPAGE));
      for (const icon of icons) {
        // The icon directory (type 1, one image) and the picture it points at, read here and not by the converter.
        expect(icon.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))).toBe(true);
        const count = icon.readUInt16LE(4);
        expect(count).toBeGreaterThanOrEqual(1);
        const size = icon.readUInt32LE(6 + 8);
        const offset = icon.readUInt32LE(6 + 12);
        const entryWidth = icon[6] === 0 ? 256 : icon[6];
        const entryHeight = icon[7] === 0 ? 256 : icon[7];
        const picture = await sharp(icon.subarray(offset, offset + size)).metadata();
        expect({ width: picture.width, height: picture.height }).toEqual({ width: entryWidth, height: entryHeight });
        expect(Math.max(entryWidth, entryHeight)).toBeLessThanOrEqual(256);
        // The icon is a square canvas that holds the whole page, so it is not one flat colour.
        const { channels } = await sharp(icon.subarray(offset, offset + size)).stats();
        expect(Math.max(...channels.map((channel) => channel.max - channel.min))).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS
  );

  it.each(['ps', 'eps'])(
    'a PDF to .%s draws the first page of the PDF, as Ghostscript renders it',
    async (target) => {
      const result = await dispatchConversion(MULTIPAGE, 'pdf', target, { multiPageOutput: 'first' }, 'multipage.pdf');
      const first = result.buffer.subarray(0, 2).toString('latin1') === 'PK' ? await pagePictures(result.buffer).then((files) => files[0]) : result.buffer;
      expect(first.toString('latin1').startsWith(target === 'eps' ? '%!PS-Adobe-3.0 EPSF-3.0' : '%!PS-Adobe-3.0')).toBe(true);
      const picture = withTempDirectory((directory) => {
        const file = path.join(directory, `page.${target}`);
        fs.writeFileSync(file, first);
        const png = path.join(directory, 'page.png');
        execFileSync(getOracleToolPath('gs') ?? 'gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dFirstPage=1', '-dLastPage=1', ...(target === 'eps' ? ['-dEPSCrop'] : []), '-sDEVICE=png16m', `-r${RASTER_DPI}`, `-sOutputFile=${png}`, file]);
        return fs.readFileSync(png);
      });
      expectWordsPresent(MULTIPAGE_TRUTH.split(/\n\s*\n/).slice(0, 2).join(' '), recognizedText(picture), `pdf -> ${target}`);
      if (target === 'ps') await expectSamePage(picture, MULTIPAGE, 'pdf -> ps');
    },
    TIMEOUT_MS
  );

  /** The names of the entities of a DXF and the vertices of its polylines: group code 0 names an entity, and every VERTEX is a point of an outline. */
  function dxfEntities(dxf: string): { entities: string[]; vertices: number } {
    const lines = dxf.split(/\r?\n/);
    const entities: string[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i].trim() === '0') entities.push(lines[i + 1].trim());
    return { entities, vertices: entities.filter((entity) => entity === 'VERTEX').length };
  }

  it(
    'a PDF to .dxf is a drawing between the section and the end of the file that the office suite opens and prints as one page with ink on it',
    async () => {
      const result = await dispatchConversion(MULTIPAGE, 'pdf', 'dxf', { multiPageOutput: 'first' }, 'multipage.pdf');
      const first = result.buffer.subarray(0, 2).toString('latin1') === 'PK' ? await pagePictures(result.buffer).then((files) => files[0]) : result.buffer;
      const { entities, vertices } = dxfEntities(first.toString('utf-8'));
      expect(entities[0]).toBe('SECTION');
      expect(entities.at(-1)).toBe('EOF');
      // The glyphs of the page are outlines: hundreds of points, drawn by the office suite's own DXF import.
      expect(vertices).toBeGreaterThan(200);
      const printed = sofficeConvert(first, 'page.dxf', 'pdf', (pdf) => pdf.read());
      expect(pdfinfoPages(printed)).toBe(1);
      const ink = withTempDirectory((directory) => {
        fs.writeFileSync(path.join(directory, 'in.pdf'), printed);
        return execFileSync(getOracleToolPath('pdftoppm') ?? 'pdftoppm', ['-r', '50', '-gray', '-f', '1', '-l', '1', path.join(directory, 'in.pdf')]);
      });
      expect(ink.some((byte, index) => index > 16 && byte < 255)).toBe(true);
    },
    TIMEOUT_MS
  );

  it(
    'a PDF to .odd is an OpenDocument drawing with one full-page picture for each page, the page as Poppler draws it',
    async () => {
      const result = await dispatchConversion(MULTIPAGE, 'pdf', 'odd', {}, 'multipage.pdf');
      const drawings = await pagePictures(result.buffer);
      expect(drawings).toHaveLength(pdfinfoPages(MULTIPAGE));
      const package0 = await JSZip.loadAsync(drawings[0]);
      expect(await package0.file('mimetype')?.async('string')).toBe('application/vnd.oasis.opendocument.graphics');
      const pictureName = Object.keys(package0.files).find((name) => /^Pictures\//.test(name) && !package0.files[name].dir);
      expect(pictureName).toBeDefined();
      const picture = Buffer.from(await package0.files[pictureName as string].async('uint8array'));
      await expectSamePage(picture, MULTIPAGE, 'pdf -> odd');
    },
    TIMEOUT_MS
  );
});

describe('the pairs of entry 183 in the registry', () => {
  const ADDED: Readonly<Record<string, readonly string[]>> = {
    abw: ['doc', 'jpg', 'png', 'rtf'],
    docm: ['doc', 'docx', 'jpg', 'odt', 'png', 'rtf'],
    dot: ['doc', 'jpg', 'png', 'rtf'],
    dotx: ['doc', 'jpg', 'png', 'rtf'],
    html: ['doc', 'jpg', 'png', 'rtf'],
    md: ['doc', 'jpg', 'png', 'rtf'],
    pages: ['doc', 'docx', 'epub', 'jpg', 'pdf', 'png', 'txt'],
    pdb: ['rtf'],
    pdf: ['avif', 'bmp', 'doc', 'dxf', 'eps', 'gif', 'ico', 'odd', 'ps', 'psd', 'webp'],
    rst: ['rtf'],
    txt: ['doc', 'jpg', 'png', 'rtf'],
    xps: ['odd'],
    zabw: ['doc', 'jpg', 'png', 'rtf'],
  };
  const LEFT_OUT: Readonly<Record<string, readonly string[]>> = {
    docx: ['azw3', 'lrf', 'mobi', 'oeb', 'pdb', 'xps'],
    odt: ['azw3', 'lrf', 'mobi', 'oeb', 'pdb'],
    pages: ['ppt', 'xls'],
    pdf: ['emf', 'ppt', 'wmf'],
  };

  it.each(Object.entries(ADDED))('%s offers the targets of the entry', (source, targets) => {
    expect(targets.filter((target) => !FORMAT_REGISTRY[source].targetFormats.includes(target))).toEqual([]);
  });

  it.each(Object.entries(LEFT_OUT))('%s does not offer the targets the entry leaves out', (source, targets) => {
    expect(targets.filter((target) => FORMAT_REGISTRY[source].targetFormats.includes(target))).toEqual([]);
  });
});
