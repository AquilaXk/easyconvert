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
import { ConversionFailedError } from '../src/lib/types';
import { requireRealworldSample } from './helpers/realworld-sample';
import { defaultResolver } from '../bench/tools';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { sofficeConvert } from './helpers/soffice-convert';
import { mobiText } from './helpers/mobi-text';
import { xpsGlyphText } from './helpers/xps-glyphs';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * Real files of the formats the office suite reads and the in-process engine does not (Works, WordPerfect, OpenOffice.org 1.x,
 * Numbers, Publisher, StarOffice, AbiWord, Quattro Pro, the Sony, Palm and RocketBook e-books) or reads as another format (Word, Excel and OpenDocument templates,
 * PowerPoint slide shows). Until #783 these were handed to the in-process text extractor, which either refused the bytes with an
 * untyped error or, for some targets, returned the raw bytes read as text. Each file here is converted to every target the
 * registry advertises for it (a test below fails when one has no conversion). Two oracles read the result and neither is the
 * converter's own text export: the words of the office suite's PDF export of the same file, read by pdftotext, and phrases
 * pinned as literals, read from the document by a reader other than the converter and its text filter (how is said per
 * sample). The e-book outputs are read back by calibre's `ebook-convert` and by the MobileRead layout of a MOBI book. The files
 * are fetched, digest-checked and cached like the nightly corpus run does (bench/realworld/manifest.json).
 */

const toolsMissing = skipWithoutTools('soffice', 'pdftotext');
const calibreMissing = skipUnless('ebook-convert', defaultResolver()('ebook-convert') !== null);
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
  /** The format has an import filter in some builds of the office suite only: a build without it must refuse with the typed answer, one with it need only write a file of the target. */
  importFilterOptional?: true;
}

const SAMPLES: readonly SampleCase[] = [
  { id: 'lo-tdf120761_zorder.dot', extension: 'dot', targets: ['docx', 'odt', 'pdf', 'txt'], phrases: ['blah blah blah'] },
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
    targets: ['docx', 'odt', 'pdf', 'txt', 'html', 'md', 'zip'],
    phrases: ['this is an example document made with microsoft works word processor'],
  },
  {
    id: 'opf-testwordperfect_6_61.wpd',
    extension: 'wpd',
    targets: ['docx', 'odt', 'pdf', 'txt', 'html', 'md', 'zip'],
    phrases: ['sluwe sjaantje sloeg de slome slager'],
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
    targets: ['xlsx', 'xls', 'csv', 'zip'],
    phrases: ['category amount home', 'food', 'gas', 'credit card', 'entertainment', 'total'],
  },
  {
    id: 'govdocs1-764092.pps',
    extension: 'pps',
    targets: ['pptx', 'odp', 'pdf', 'html', 'txt'],
    phrases: ['so you want an instrument approach', 'new york flight procedures office'],
  },
  { id: 'lo-impress.otp', extension: 'otp', targets: ['odp', 'pptx', 'pdf'], phrases: ['title of impress template'] },
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
  {
    id: 'opf-lorem-ipsum-090.rb',
    extension: 'rb',
    targets: ['epub', 'pdf', 'txt', 'rtf', 'azw3', 'lrf', 'mobi', 'oeb', 'pdb', 'zip'],
    // The RocketBook filter exists in LibreOffice 26.8 and not in 24.2 (CI), and 26.8 reads this file as binary noise, so no phrase of the book can be pinned.
    phrases: [],
    importFilterOptional: true,
  },
];

const IMAGE_TARGETS: ReadonlySet<string> = new Set(['png', 'jpg', 'bmp']);
/** E-book targets read back from their container: the Palm family, the Sony format and the Open eBook package of text. */
const EBOOK_CONTAINER_TARGETS: ReadonlySet<string> = new Set(['azw3', 'mobi', 'pdb', 'lrf', 'oeb']);
/** Targets whose text is read by converting the output back to PDF with the office suite (spreadsheets: to CSV). */
const OFFICE_RENDERED_TARGETS: ReadonlySet<string> = new Set(['docx', 'odt', 'pptx', 'odp', 'doc', 'ppt']);
const TEXT_TARGETS: ReadonlySet<string> = new Set(['txt', 'md', 'csv', 'rtf']);
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
const SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xlt', 'numbers', 'sdc', 'qpw']);
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
const CALIBRE_EXTENSIONS: ReadonlySet<string> = new Set(['lrf', 'pdb', 'rb']);

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

/** The first page of an image output: the file itself, or the first entry of the ZIP that several pages arrive in. */
async function firstPageImage(output: Buffer): Promise<Buffer> {
  if (output.subarray(0, 2).toString('latin1') !== 'PK') return output;
  const pages = await JSZip.loadAsync(output);
  const first = Object.keys(pages.files).sort()[0];
  return Buffer.from(await pages.files[first].async('uint8array'));
}

/** A page image is a picture of the right kind, with a size, and not one flat colour. BMP is read from its header: the decoder reads no BMP. */
async function expectPageImage(output: Buffer, target: string): Promise<void> {
  const image = await firstPageImage(output);
  if (target === 'bmp') {
    expect(image.subarray(0, 2).toString('latin1')).toBe('BM');
    expect(image.readInt32LE(18)).toBeGreaterThan(0);
    expect(Math.abs(image.readInt32LE(22))).toBeGreaterThan(0);
    return;
  }
  const metadata = await sharp(image).metadata();
  expect(metadata.format).toBe(target === 'png' ? 'png' : 'jpeg');
  expect(metadata.width).toBeGreaterThan(0);
  expect(metadata.height).toBeGreaterThan(0);
  const { channels } = await sharp(image).stats();
  expect(Math.max(...channels.map((channel) => channel.max - channel.min))).toBeGreaterThan(0);
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

/**
 * The conversion of a format whose import filter only some builds of the office suite have: the archive of the file, a typed
 * refusal that says the filter is missing, or a file of the target (a build with the filter reads the file; its words are
 * not compared here because the filter of 26.8 reads this sample as noise).
 */
async function expectRefusalOrFileOf(sample: Buffer, extension: string, target: string, id: string): Promise<void> {
  const label = `${id} -> ${target}`;
  const outcome = await dispatchConversion(sample, extension, target, {}, id).catch((error: unknown) => error);
  if (outcome instanceof ConversionFailedError) {
    expect(outcome.message, label).toMatch(/has no import filter/);
  } else if (target === 'zip') {
    await expectArchiveOfSource((outcome as { buffer: Buffer }).buffer, sample, label);
  } else {
    expect(path.extname((outcome as { filename: string }).filename), label).toBe(`.${target}`);
    expect((outcome as { buffer: Buffer }).buffer.length, label).toBeGreaterThan(0);
  }
}

describe.skipIf(toolsMissing)('real files of the formats the office suite reads', () => {
  for (const { id, extension, targets, phrases, resaveAs, importFilterOptional } of SAMPLES) {
    it(
      `${id} as .${extension}: converts to ${targets.join(', ')} with the words the office suite shows`,
      async (ctx) => {
        const { bytes: original } = await requireRealworldSample(ctx, id);
        const sample = resaveAs === undefined ? original : sofficeConvert(original, id, resaveAs, (output) => output.read());
        if (importFilterOptional) {
          for (const target of targets) await expectRefusalOrFileOf(sample, extension, target, id);
          return;
        }
        const reference = referenceWords(sample, extension);
        const calibre = calibreWords(sample, extension);
        for (const target of targets) {
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
            await expectPageImage(result.buffer, target);
            continue;
          }
          if (EBOOK_CONTAINER_TARGETS.has(target)) continue;
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
 * E-book outputs read back: the Palm family by calibre (PalmDOC) and by the MobileRead layout of the book, the Sony and Open
 * eBook outputs by their words in the file. No independent reader accepts the files of the Sony and Open eBook writers (calibre
 * refuses the LRF header and cannot open the OEB package), so for those two only the words in the bytes are checked.
 */
describe.skipIf(toolsMissing || calibreMissing)('e-book outputs of the formats the office suite reads', () => {
  for (const { id, extension, targets, phrases } of SAMPLES.filter((sample) => sample.importFilterOptional === undefined && sample.targets.some((target) => EBOOK_CONTAINER_TARGETS.has(target)))) {
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
          const readers: string[] = [];
          if (target === 'pdb') readers.push(calibreText(output, 'pdb') ?? '');
          if (target === 'mobi' || target === 'azw3') readers.push(mobiText(output));
          if (target === 'lrf' || target === 'oeb') readers.push(output.toString('utf-8'));
          expect(readers, label).toHaveLength(1);
          expectWordsOf(reference, wordsOf(readers[0]), label);
          expectPhrases(phrases, readers[0], `${label} (pinned phrases)`);
        },
        CONVERSION_TIMEOUT_MS
      );
    }
  }
});

/** The drawings and metafiles are converted from real files by tests/vector-sources-real-samples.test.ts, which checks its own coverage of the registry. */
const DRAWING_FORMATS_OF_OTHER_SUITE: ReadonlySet<string> = new Set(['vsd', 'cdr', 'emf', 'wmf', 'cgm']);

describe('the conversions of the real files cover the registry', () => {
  const sampleTargets = (extension: string): Set<string> => new Set(SAMPLES.filter((sample) => sample.extension === extension).flatMap((sample) => sample.targets));

  it.each(OFFICE_SUITE_SOURCE_FORMATS.filter((format) => isOfficeSuiteOnlySource(format) && !DRAWING_FORMATS_OF_OTHER_SUITE.has(format)))(
    'every target the registry advertises for .%s has a conversion of a real file above',
    (extension) => {
      const advertised = getFormatByExtension(extension)?.targetFormats ?? [];
      expect(advertised.length).toBeGreaterThan(0);
      expect({ extension, uncovered: advertised.filter((target) => !sampleTargets(extension).has(target)) }).toEqual({ extension, uncovered: [] });
    }
  );
});
