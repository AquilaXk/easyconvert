import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { getFormatByExtension } from '../src/lib/registry';
import { OFFICE_SUITE_SOURCE_FORMATS, isOfficeSuiteOnlySource } from '../src/lib/conversions/office/office-suite-sources';
import { requireRealworldSample } from './helpers/realworld-sample';
import { defaultResolver } from '../bench/tools';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { sofficeConvert } from './helpers/soffice-convert';
import { calibreBinary, textOfCalibreTarget } from './helpers/calibre-books';
import { xpsGlyphText } from './helpers/xps-glyphs';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { pdfinfoPages } from './helpers/encrypted-pdf-fixtures';

/**
 * Real files of the formats the office suite reads and the in-process engine does not (Works, WordPerfect, Lotus Word Pro,
 * OpenOffice.org 1.x, Numbers, Publisher, StarOffice, AbiWord, Quattro Pro, the Sony and Palm e-books) or reads as another
 * format (Word, Excel and OpenDocument templates, PowerPoint slide shows). Until #783 these were handed to the in-process text extractor, which either refused the bytes with an
 * untyped error or, for some targets, returned the raw bytes read as text. Each file here is converted to every target the
 * registry advertises for it (a test below fails when one has no conversion). Two oracles read the result and neither is the
 * converter's own text export: the words of the office suite's PDF export of the same file, read by pdftotext, and phrases
 * pinned as literals, read from the document by a reader other than the converter and its text filter (how is said per
 * sample). A page image is checked against the PDF of the same file (one image per page, the page's aspect ratio), and a Word or
 * PowerPoint 97-2003 output for the stream that makes it one. The e-book outputs are read back by calibre's `ebook-convert` and by the MobileRead layout of a MOBI book. The files
 * are fetched, digest-checked and cached like the nightly corpus run does (bench/realworld/manifest.json).
 */

const toolsMissing = skipWithoutTools('soffice', 'pdftotext', 'pdfinfo');
const calibreMissing = skipUnless('ebook-convert', calibreBinary !== null);
const CONVERSION_TIMEOUT_MS = 600_000;
const MIN_WORD_LENGTH = 4;
/** Share of the words of the reference text that the output may lack: headers, footers and page numbers are laid out differently. */
const MAX_MISSING_SHARE = 0.1;
/** A sample whose reference text has fewer words than this is checked for the words it has, not for a share. */
const MIN_WORDS_FOR_SHARE = 8;

interface SampleCase {
  /** Id in bench/realworld/manifest.json. */
  id: string;
  extension: string;
  targets: readonly string[];
  /**
   * Phrases of the document's own text, pinned as literals. They were read from the document by the PDF the office suite
   * prints of it, through pdftotext (a path other than the converter's text export), and for the OpenDocument and StarOffice
   * files also from the XML of the package itself. Every output that holds text must hold every phrase.
   */
  phrases: readonly string[];
  /** The office suite's filter that saves the sample again in `extension` (a real Word document saved as a Word template). */
  resaveAs?: string;
  /**
   * The phrases are also bytes of the sample (8-bit text in the file, found after the same normalisation): the file's own text, read
   * by neither the office suite nor the converter.
   */
  phrasesInSourceBytes?: true;
}

const SAMPLES: readonly SampleCase[] = [
  { id: 'lo-tdf120761_zorder.dot', extension: 'dot', targets: ['docx', 'odt', 'pdf', 'txt', 'xps'], phrases: ['blah blah blah'] },
  {
    id: 'govdocs1-000003.doc',
    extension: 'dot',
    targets: ['docx', 'odt', 'pdf', 'txt', 'html', 'xps'],
    phrases: ['depopulation activities', 'bull calf premises', 'selective depopulation activities at these facilities'],
    resaveAs: 'dot:MS Word 97 Vorlage',
  },
  {
    id: 'tika-testworks.wps',
    extension: 'wps',
    targets: ['docx', 'odt', 'pdf', 'txt', 'html', 'md', 'zip', 'doc', 'rtf', 'jpg', 'png'],
    phrases: ['this is an example document made with microsoft works word processor'],
  },
  {
    id: 'opf-testwordperfect_6_61.wpd',
    extension: 'wpd',
    targets: ['docx', 'odt', 'pdf', 'txt', 'html', 'md', 'zip', 'doc', 'rtf', 'jpg', 'png'],
    phrases: ['sluwe sjaantje sloeg de slome slager'],
  },
  {
    id: 'lo-wordpro.lwp',
    extension: 'lwp',
    targets: ['doc', 'docx', 'html', 'md', 'odt', 'pdf', 'rtf', 'txt', 'jpg', 'png'],
    phrases: ['this line is bold', 'this document is created using lotus wordpro release 9 6', 'this is a bulleted list'],
    phrasesInSourceBytes: true,
  },
  {
    id: 'lo-fdo36036-1.lwp',
    extension: 'lwp',
    targets: ['docx', 'pdf', 'txt'],
    phrases: ['cross over a1 to a1139', 'our works are at the bottom'],
    phrasesInSourceBytes: true,
  },
  {
    id: 'lo-tdf129993-2.lwp',
    extension: 'lwp',
    targets: ['odt', 'pdf', 'txt'],
    phrases: ['test test test test test test test test'],
    phrasesInSourceBytes: true,
  },
  { id: 'lo-tdf151375.ott', extension: 'ott', targets: ['odt', 'docx', 'pdf', 'txt'], phrases: ['unser zeichen ihr zeichen datum', 'mit dank zurück', 'prüfung und stellungnahme'] },
  {
    id: 'lo-ooo32780-1.sxw',
    extension: 'sxw',
    targets: ['odt', 'docx', 'pdf', 'txt', 'zip'],
    phrases: ['he heard quiet steps behind him', 'that didn t bode well', 'was there another crook who d had the same idea'],
  },
  { id: 'tika-testexcel_template.xlt', extension: 'xlt', targets: ['xlsx', 'csv', 'pdf'], phrases: ['this is a template'] },
  {
    id: 'tika-testnumbers.numbers',
    extension: 'numbers',
    targets: ['xlsx', 'xls', 'csv', 'zip', 'pdf', 'jpg', 'png'],
    phrases: ['category amount home', 'food', 'gas', 'credit card', 'entertainment', 'total'],
  },
  {
    id: 'govdocs1-764092.pps',
    extension: 'pps',
    targets: ['pptx', 'odp', 'pdf', 'html', 'txt', 'ppt', 'jpg', 'png'],
    phrases: ['so you want an instrument approach', 'new york flight procedures office'],
  },
  { id: 'lo-impress.otp', extension: 'otp', targets: ['odp', 'pptx', 'pdf'], phrases: ['title of impress template'] },
  { id: 'lo-calc.ots', extension: 'ots', targets: ['ods', 'xlsx', 'csv', 'pdf', 'zip'], phrases: ['calc template s first cell'] },
  {
    id: 'tika-teststaroffice-6.0-draw.sxi',
    extension: 'sxi',
    targets: ['odp', 'pptx', 'pdf', 'zip'],
    phrases: ['example bullet problems', 'level 2 looks ok', 'level 1 no bullet symbol'],
  },
  { id: 'tika-teststaroffice-6.0-draw.sxd', extension: 'sxd', targets: ['pdf', 'png', 'jpg', 'bmp', 'zip'], phrases: [] },
  {
    id: 'office-60685.pub',
    extension: 'pub',
    targets: ['pdf', 'png', 'jpg', 'bmp'],
    phrases: ['professional experience', 'caring registered nurse with six years experience'],
  },
  {
    id: 'tika-teststaroffice-5.2-writer.sdw',
    extension: 'sdw',
    targets: ['docx', 'pdf', 'txt', 'odt', 'zip'],
    phrases: ['this is an example staroffice 5 2 document'],
  },
  { id: 'lo-hello.zabw', extension: 'zabw', targets: ['docx', 'pdf', 'txt', 'zip', 'html', 'md', 'odt'], phrases: ['hello world'] },
  {
    id: 'tika-teststaroffice-5.2-calc.sdc',
    extension: 'sdc',
    targets: ['ods', 'xlsx', 'csv', 'zip'],
    phrases: ['this is an example staroffice 5 2 spreadsheet'],
  },
  {
    id: 'opf-testquattro.qpw',
    extension: 'qpw',
    targets: ['xlsx', 'csv', 'zip'],
    phrases: ['this is an example spreadsheet made with quattro pro x3'],
  },
  {
    id: 'tika-teststaroffice-5.2-draw.sda',
    extension: 'sda',
    targets: ['pdf', 'png', 'jpg', 'bmp', 'zip'],
    phrases: ['this is an example staroffice 5 2 drawing'],
  },
  {
    id: 'opf-lorem-ipsum-090.lrf',
    extension: 'lrf',
    targets: ['epub', 'pdf', 'txt', 'rtf', 'azw3', 'mobi', 'oeb', 'pdb', 'zip'],
    phrases: ['variatio ipsius', 'lorem ipsum dolor sit amet consectetur adipiscing elit'],
  },
  {
    id: 'lo-plucker.pdb',
    extension: 'pdb',
    targets: ['txt', 'pdf', 'epub', 'azw3', 'mobi', 'lrf', 'oeb', 'zip'],
    phrases: ['universal declaration of human rights', 'adopted and proclaimed by general assembly resolution'],
  },
];

const IMAGE_TARGETS: ReadonlySet<string> = new Set(['png', 'jpg', 'bmp']);
/** E-book targets read back from their container: the Palm family, the Sony format and the Open eBook package of text. */
const EBOOK_CONTAINER_TARGETS: ReadonlySet<string> = new Set(['azw3', 'mobi', 'pdb', 'lrf', 'oeb']);
/** Targets whose text is read by converting the output back to PDF with the office suite (spreadsheets: to CSV). */
const OFFICE_RENDERED_TARGETS: ReadonlySet<string> = new Set(['docx', 'odt', 'pptx', 'odp', 'doc', 'ppt', 'rtf']);
const TEXT_TARGETS: ReadonlySet<string> = new Set(['txt', 'md', 'csv']);
/** The UTF-8 byte order mark that the office suite's text export writes unless told not to. */
const UTF8_BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf]);

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH);
}

/** The words of spreadsheet cells: letters only, because the display of a number (thousands separators, a currency suffix) differs between versions of the office suite. */
function cellWordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH);
}

/** The text in lower case with every run of characters that are no letters or digits (spaces, line ends, punctuation, markup remnants) as one space. */
function normalizedText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function pdfText(pdf: Buffer): string {
  return extractTextWithExternalPdftotext(pdf) ?? '';
}

function stripMarkup(markup: string): string {
  return markup
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Spreadsheet formats: their words are the cells, which the office suite's CSV export holds without the headers and page numbers of a printed page. */
const SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xlt', 'ots', 'numbers', 'sdc', 'qpw']);
/** The office suite's CSV export of the first sheet with every cell as it is shown (UTF-8, comma, double quote): the text of a CSV that Excel saves. */
const CSV_AS_SHOWN = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true';
const SPREADSHEET_TARGETS: ReadonlySet<string> = new Set(['xlsx', 'xls', 'ods']);

/** The office suite's own reading of the sample: the words on its pages, or the cells of a spreadsheet. */
function referenceWords(sample: Buffer, extension: string): Set<string> {
  if (SPREADSHEET_EXTENSIONS.has(extension)) {
    return new Set(sofficeConvert(sample, `in.${extension}`, CSV_AS_SHOWN, (output) => cellWordsOf(output.read().toString('utf-8'))));
  }
  return new Set(sofficeConvert(sample, `in.${extension}`, 'pdf', (output) => wordsOf(pdfText(output.read()))));
}

/** The e-book formats calibre also reads, which gives a second reference for their words. */
const CALIBRE_EXTENSIONS: ReadonlySet<string> = new Set(['lrf', 'pdb']);

/** The text of an e-book as calibre reads it (`ebook-convert` to plain text), or undefined when the tool is not installed. */
function calibreText(book: Buffer, extension: string): string | undefined {
  const tool = defaultResolver()('ebook-convert');
  if (!tool) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibre-ref-'));
  try {
    fs.writeFileSync(path.join(dir, `in.${extension}`), book);
    execFileSync(tool, [path.join(dir, `in.${extension}`), path.join(dir, 'out.txt')], { stdio: 'ignore', timeout: 120_000 });
    return fs.readFileSync(path.join(dir, 'out.txt'), 'utf-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** calibre's words of an e-book source, or undefined when `ebook-convert` is not installed (or the format is not an e-book). */
function calibreWords(sample: Buffer, extension: string): Set<string> | undefined {
  const text = CALIBRE_EXTENSIONS.has(extension) ? calibreText(sample, extension) : undefined;
  return text === undefined ? undefined : new Set(wordsOf(text));
}

async function epubText(epub: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(epub);
  const parts: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (/\.(xhtml|html|htm)$/i.test(name)) parts.push(stripMarkup(await zip.files[name].async('string')));
  }
  return parts.join(' ');
}

/** The text of an output, or undefined for a target that holds none to read here (pictures, e-book containers). */
async function outputText(output: Buffer, target: string): Promise<string | undefined> {
  if (target === 'pdf') return pdfText(output);
  if (target === 'html') return stripMarkup(output.toString('utf-8'));
  if (TEXT_TARGETS.has(target)) return output.toString('utf-8');
  if (target === 'epub') return epubText(output);
  if (target === 'xps') return xpsGlyphText(output);
  if (SPREADSHEET_TARGETS.has(target)) return sofficeConvert(output, `out.${target}`, CSV_AS_SHOWN, (rendered) => rendered.read().toString('utf-8'));
  if (OFFICE_RENDERED_TARGETS.has(target)) return sofficeConvert(output, `out.${target}`, 'pdf', (rendered) => pdfText(rendered.read()));
  return undefined;
}

/** The words of an output text: the letters of the cells for a spreadsheet, any word of a document. */
function wordsOfOutput(text: string, target: string): string[] {
  return target === 'csv' || SPREADSHEET_TARGETS.has(target) ? cellWordsOf(text) : wordsOf(text);
}

/** The type and creator of a Palm database ([Palm database header]: bytes 60 to 67) of the Palm-family outputs. */
const PALM_TYPE_AND_CREATOR: Readonly<Record<string, string>> = { azw3: 'BOOKMOBI', mobi: 'BOOKMOBI', pdb: 'TEXtREAd' };

/** The pages of an image output: the file itself, or the entries of the ZIP that several pages arrive in, in page order. */
async function pageImages(output: Buffer): Promise<Buffer[]> {
  if (output.subarray(0, 2).toString('latin1') !== 'PK') return [output];
  const pages = await JSZip.loadAsync(output);
  return Promise.all(
    Object.keys(pages.files)
      .sort()
      .map(async (name) => Buffer.from(await pages.files[name].async('uint8array')))
  );
}

/** The size of the first page of a PDF in points, as Poppler's pdfinfo reads it. */
function firstPageSize(pdf: Buffer): { width: number; height: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-size-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    const info = execFileSync(defaultResolver()('pdfinfo') ?? 'pdfinfo', [path.join(dir, 'in.pdf')], { encoding: 'utf-8' });
    const match = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
    expect(match, 'pdfinfo reports a page size').not.toBeNull();
    return { width: Number(match?.[1]), height: Number(match?.[2]) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Largest difference between the aspect ratio of a page image and of the PDF page that the office suite prints: rounding to whole pixels only. */
const MAX_ASPECT_RATIO_DIFFERENCE = 0.01;

/** The PDF the office suite prints of the sample: the pages that every page image has to match. */
interface PrintedPages {
  count: number;
  width: number;
  height: number;
}

function printedPages(sample: Buffer, extension: string): PrintedPages {
  return sofficeConvert(sample, `in.${extension}`, 'pdf', (output) => {
    const pdf = output.read();
    return { count: pdfinfoPages(pdf), ...firstPageSize(pdf) };
  });
}

/**
 * Page images are pictures of the right kind, one for every printed page, with the aspect ratio of the page, and the first one is
 * not a single flat colour. BMP is read from its header: the decoder reads no BMP.
 */
async function expectPageImages(output: Buffer, target: string, printed: PrintedPages | undefined, label: string): Promise<void> {
  const images = await pageImages(output);
  if (printed !== undefined) expect({ label, pages: images.length }).toEqual({ label, pages: printed.count });
  for (const image of images) {
    if (target === 'bmp') {
      expect(image.subarray(0, 2).toString('latin1')).toBe('BM');
      expect(image.readInt32LE(18)).toBeGreaterThan(0);
      expect(Math.abs(image.readInt32LE(22))).toBeGreaterThan(0);
      continue;
    }
    const metadata = await sharp(image).metadata();
    expect(metadata.format).toBe(target === 'png' ? 'png' : 'jpeg');
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
    if (printed !== undefined && metadata.width !== undefined && metadata.height !== undefined) {
      expect(Math.abs(metadata.width / metadata.height - printed.width / printed.height), `${label} aspect ratio`).toBeLessThan(MAX_ASPECT_RATIO_DIFFERENCE);
    }
  }
  if (target === 'bmp') return;
  const { channels } = await sharp(images[0]).stats();
  expect(Math.max(...channels.map((channel) => channel.max - channel.min)), `${label} first page is not one flat colour`).toBeGreaterThan(0);
}

/** The signature of a compound file (MS-CFB) and the name of the stream that makes the container a Word or PowerPoint 97-2003 file, as the directory entry spells it (UTF-16LE). */
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const STREAM_OF_LEGACY_TARGET: Readonly<Record<string, string>> = { doc: 'WordDocument', ppt: 'PowerPoint Document' };

function expectLegacyOfficeContainer(output: Buffer, target: string, label: string): void {
  expect(output.subarray(0, COMPOUND_FILE_SIGNATURE.length).equals(COMPOUND_FILE_SIGNATURE), `${label} is a compound file`).toBe(true);
  expect(output.includes(Buffer.from(STREAM_OF_LEGACY_TARGET[target], 'utf16le')), `${label} holds the ${STREAM_OF_LEGACY_TARGET[target]} stream`).toBe(true);
}

/** The mimetype of an OpenDocument package: a template converted to a document is no longer a template. */
async function packageMimetype(output: Buffer): Promise<string> {
  const archive = await JSZip.loadAsync(output);
  return (await archive.files['mimetype'].async('string')).trim();
}

/** The `zip` target packs the source file as it is: the archive holds one entry with the bytes of the sample. */
async function expectArchiveOfSource(output: Buffer, sample: Buffer, label: string): Promise<void> {
  const archive = await JSZip.loadAsync(output);
  const names = Object.keys(archive.files);
  expect({ label, entries: names.length }).toEqual({ label, entries: 1 });
  expect(Buffer.from(await archive.files[names[0]].async('uint8array')).equals(sample), label).toBe(true);
}

/**
 * The words of the reference that the produced words lack. `unspaced` is the produced text without its separators, for the
 * plain-text export, which writes the text of neighbouring frames (a letterhead) run together: a word that is there but joined
 * to its neighbours is found in it.
 */
function expectWordsOf(reference: ReadonlySet<string>, produced: readonly string[], label: string, unspaced = ''): void {
  const have = new Set(produced);
  const missing = [...reference].filter((word) => !have.has(word) && !unspaced.includes(word));
  if (reference.size < MIN_WORDS_FOR_SHARE) {
    expect({ label, missing }).toEqual({ label, missing: [] });
    return;
  }
  expect({ label, missing: missing.slice(0, 10), withinLimit: missing.length <= reference.size * MAX_MISSING_SHARE }).toEqual({
    label,
    missing: missing.slice(0, 10),
    withinLimit: true,
  });
}

function expectPhrases(phrases: readonly string[], text: string, label: string): void {
  const normalized = normalizedText(text);
  expect({ label, missing: phrases.filter((phrase) => !normalized.includes(phrase)) }).toEqual({ label, missing: [] });
}

describe.skipIf(toolsMissing)('real files of the formats the office suite reads', () => {
  for (const { id, extension, targets, phrases, phrasesInSourceBytes, resaveAs } of SAMPLES) {
    it(
      `${id} as .${extension}: converts to ${targets.join(', ')} with the words the office suite shows`,
      async (ctx) => {
        const { bytes: original } = await requireRealworldSample(ctx, id);
        const sample = resaveAs === undefined ? original : sofficeConvert(original, id, resaveAs, (output) => output.read());
        const reference = referenceWords(sample, extension);
        const calibre = calibreWords(sample, extension);
        const printed = targets.some((target) => IMAGE_TARGETS.has(target)) ? printedPages(sample, extension) : undefined;
        if (phrasesInSourceBytes) expectPhrases(phrases, sample.toString('latin1'), `${id} (pinned phrases in the bytes of the file)`);
        // The Palm, Kindle, Sony and Open eBook targets are written by calibre and read back by the e-book suite below.
        for (const target of targets.filter((candidate) => !EBOOK_CONTAINER_TARGETS.has(candidate))) {
          const label = `${id} -> ${target}`;
          const result = await dispatchConversion(sample, extension, target, {}, id);
          // A document of several pages becomes one image per page, in a ZIP.
          const extensions = IMAGE_TARGETS.has(target) ? [`.${target}`, '.zip'] : [`.${target}`];
          expect(extensions, label).toContain(path.extname(result.filename));
          expect(result.buffer.length, label).toBeGreaterThan(0);
          if (target === 'zip') {
            await expectArchiveOfSource(result.buffer, sample, label);
            continue;
          }
          if (IMAGE_TARGETS.has(target)) {
            await expectPageImages(result.buffer, target, printed, label);
            continue;
          }
          if (target in STREAM_OF_LEGACY_TARGET) expectLegacyOfficeContainer(result.buffer, target, label);
          if (target === 'ods') expect(await packageMimetype(result.buffer), `${label} is a spreadsheet, not a template`).toBe('application/vnd.oasis.opendocument.spreadsheet');
          if (target === 'txt') expect(result.buffer.subarray(0, UTF8_BYTE_ORDER_MARK.length), `${label} starts with a byte order mark`).not.toEqual(UTF8_BYTE_ORDER_MARK);
          const text = await outputText(result.buffer, target);
          expect(text, label).toBeDefined();
          const produced = wordsOfOutput(text ?? '', target);
          expectWordsOf(reference, produced, label, target === 'txt' ? normalizedText(text ?? '').replaceAll(' ', '') : '');
          expectPhrases(phrases, text ?? '', `${label} (pinned phrases)`);
          if (calibre && (target === 'txt' || target === 'epub')) expectWordsOf(calibre, produced, `${label} (calibre)`);
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});

/**
 * E-book outputs read back: the Palm, Kindle, Sony and Open eBook targets are written by calibre, and each is read by a reader
 * that is not the writer (tests/helpers/calibre-books.ts: the PalmDOC text of a MOBI book decompressed by the MobileRead layout,
 * calibre's plain-text export for AZW3 and PDB, `lrf2lrs` for LRF, the XHTML of the package for OEB).
 */
describe.skipIf(toolsMissing || calibreMissing)('e-book outputs of the formats the office suite reads', () => {
  for (const { id, extension, targets, phrases } of SAMPLES.filter((sample) => sample.targets.some((target) => EBOOK_CONTAINER_TARGETS.has(target)))) {
    for (const target of targets.filter((candidate) => EBOOK_CONTAINER_TARGETS.has(candidate))) {
      it(
        `${id} as .${extension}: the .${target} output holds the words of the book`,
        async (ctx) => {
          const { bytes: sample } = await requireRealworldSample(ctx, id);
          const reference = referenceWords(sample, extension);
          const label = `${id} -> ${target}`;
          const output = (await dispatchConversion(sample, extension, target, {}, id)).buffer;
          const palm = PALM_TYPE_AND_CREATOR[target];
          if (palm !== undefined) expect(output.subarray(60, 68).toString('latin1'), label).toBe(palm);
          const text = await textOfCalibreTarget(output, target);
          expectWordsOf(reference, wordsOf(text), label);
          expectPhrases(phrases, text, `${label} (pinned phrases)`);
        },
        CONVERSION_TIMEOUT_MS
      );
    }
  }
});

/** The drawings and metafiles are converted from real files by tests/vector-sources-real-samples.test.ts, which checks its own coverage of the registry. */
const DRAWING_FORMATS_OF_OTHER_TEST_FILE: ReadonlySet<string> = new Set(['vsd', 'cdr', 'emf', 'wmf', 'cgm']);

describe('the conversions of the real files cover the registry', () => {
  const sampleTargets = (extension: string): Set<string> => new Set(SAMPLES.filter((sample) => sample.extension === extension).flatMap((sample) => sample.targets));

  it.each(OFFICE_SUITE_SOURCE_FORMATS.filter((format) => isOfficeSuiteOnlySource(format) && !DRAWING_FORMATS_OF_OTHER_TEST_FILE.has(format)))(
    'every target the registry advertises for .%s has a conversion of a real file above',
    (extension) => {
      const advertised = getFormatByExtension(extension)?.targetFormats ?? [];
      expect(advertised.length).toBeGreaterThan(0);
      expect({ extension, uncovered: advertised.filter((target) => !sampleTargets(extension).has(target)) }).toEqual({ extension, uncovered: [] });
    }
  );
});
