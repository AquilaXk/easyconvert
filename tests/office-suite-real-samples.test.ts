import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ConversionFailedError } from '../src/lib/types';
import { requireRealworldSample } from './helpers/realworld-sample';
import { defaultResolver } from '../bench/tools';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { sofficeConvert } from './helpers/soffice-convert';
import { xpsGlyphText } from './helpers/xps-glyphs';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Real files of the formats the office suite reads and the in-process engine does not (Works, WordPerfect, OpenOffice.org 1.x,
 * Numbers, Publisher, the Sony, Palm and RocketBook e-books) or reads as another format (Word, Excel and OpenDocument templates,
 * PowerPoint slide shows). Until #783 these were handed to the in-process text extractor, which either refused the bytes with an
 * untyped error or, for some targets, returned the raw bytes read as text. Each file here is converted to the targets the
 * registry advertises for it; the oracle for the words is the office suite's own PDF export of the same file, read by
 * pdftotext, and for the e-books also calibre's `ebook-convert` when it is installed. The files are fetched, digest-checked and
 * cached like the nightly corpus run does (bench/realworld/manifest.json).
 */

const toolsMissing = skipWithoutTools('soffice', 'pdftotext');
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
  /** The office suite's filter that saves the sample again in `extension` (a real Word document saved as a Word template). */
  resaveAs?: string;
}

const SAMPLES: readonly SampleCase[] = [
  { id: 'lo-tdf120761_zorder.dot', extension: 'dot', targets: ['docx', 'odt', 'pdf', 'txt'] },
  { id: 'govdocs1-000003.doc', extension: 'dot', targets: ['docx', 'odt', 'pdf', 'txt', 'html', 'xps'], resaveAs: 'dot:MS Word 97 Vorlage' },
  { id: 'tika-testworks.wps', extension: 'wps', targets: ['docx', 'odt', 'pdf', 'txt', 'html', 'md'] },
  { id: 'opf-testwordperfect_6_61.wpd', extension: 'wpd', targets: ['docx', 'odt', 'pdf', 'txt', 'html', 'md'] },
  { id: 'lo-tdf151375.ott', extension: 'ott', targets: ['odt', 'docx', 'pdf', 'txt'] },
  { id: 'lo-ooo32780-1.sxw', extension: 'sxw', targets: ['odt', 'docx', 'pdf', 'txt'] },
  { id: 'tika-testexcel_template.xlt', extension: 'xlt', targets: ['xlsx', 'csv', 'pdf'] },
  { id: 'tika-testnumbers.numbers', extension: 'numbers', targets: ['xlsx', 'xls', 'csv'] },
  { id: 'govdocs1-764092.pps', extension: 'pps', targets: ['pptx', 'odp', 'pdf', 'html', 'txt'] },
  { id: 'lo-impress.otp', extension: 'otp', targets: ['odp', 'pptx', 'pdf'] },
  { id: 'tika-teststaroffice-6.0-draw.sxi', extension: 'sxi', targets: ['odp', 'pptx', 'pdf'] },
  { id: 'tika-teststaroffice-6.0-draw.sxd', extension: 'sxd', targets: ['pdf', 'png'] },
  { id: 'office-60685.pub', extension: 'pub', targets: ['pdf', 'png', 'jpg', 'bmp'] },
  { id: 'opf-lorem-ipsum-090.lrf', extension: 'lrf', targets: ['epub', 'pdf', 'txt', 'rtf', 'azw3', 'pdb'] },
  { id: 'lo-plucker.pdb', extension: 'pdb', targets: ['txt', 'pdf', 'epub', 'mobi', 'lrf'] },
  { id: 'opf-lorem-ipsum-090.rb', extension: 'rb', targets: ['epub', 'pdf', 'txt', 'oeb'] },
];

const IMAGE_TARGETS: ReadonlySet<string> = new Set(['png', 'jpg', 'bmp']);
/** E-book targets read back only for their container: the Palm family, the Sony format and the Open eBook package of text. */
const EBOOK_CONTAINER_TARGETS: ReadonlySet<string> = new Set(['azw3', 'mobi', 'pdb', 'lrf', 'oeb']);
/** Targets whose text is read by converting the output back to PDF with the office suite (spreadsheets: to CSV). */
const OFFICE_RENDERED_TARGETS: ReadonlySet<string> = new Set(['docx', 'odt', 'pptx', 'odp', 'doc', 'ppt']);
const TEXT_TARGETS: ReadonlySet<string> = new Set(['txt', 'md', 'csv', 'rtf']);

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

function pdfWords(pdf: Buffer): string[] {
  return wordsOf(extractTextWithExternalPdftotext(pdf) ?? '');
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
const SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xlt', 'numbers']);
/** Source formats the office suite opens in its word processor, which exports plain text. */
const WORD_PROCESSOR_EXTENSIONS: ReadonlySet<string> = new Set(['dot', 'wps', 'wpd', 'ott', 'sxw', 'lrf', 'pdb', 'rb']);
/** The office suite's CSV export of the first sheet with every cell as it is shown (UTF-8, comma, double quote): the text of a CSV that Excel saves. */
const CSV_AS_SHOWN = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true';
const SPREADSHEET_TARGETS: ReadonlySet<string> = new Set(['xlsx', 'xls', 'ods']);

/** The office suite's own reading of the sample: the words on its pages, or the cells of a spreadsheet. */
function referenceWords(sample: Buffer, extension: string): Set<string> {
  if (SPREADSHEET_EXTENSIONS.has(extension)) {
    return new Set(sofficeConvert(sample, `in.${extension}`, CSV_AS_SHOWN, (output) => cellWordsOf(output.read().toString('utf-8'))));
  }
  return new Set(sofficeConvert(sample, `in.${extension}`, 'pdf', (output) => pdfWords(output.read())));
}

/** The e-book formats calibre also reads, which gives a second reference for their words. */
const CALIBRE_EXTENSIONS: ReadonlySet<string> = new Set(['lrf', 'pdb', 'rb']);

/** The words of the office suite's plain-text export of a word-processor document, or undefined for a format it exports no text of. */
function textExportWords(sample: Buffer, extension: string): Set<string> | undefined {
  if (SPREADSHEET_EXTENSIONS.has(extension) || !WORD_PROCESSOR_EXTENSIONS.has(extension)) return undefined;
  try {
    return new Set(sofficeConvert(sample, `in.${extension}`, 'txt:Text (encoded):UTF8', (output) => wordsOf(output.read().toString('utf-8'))));
  } catch {
    return undefined;
  }
}

/** The reference words, or undefined for a format of which this office suite has no import filter (it cannot load the file). */
function referenceOrRefusal(sample: Buffer, extension: string): Set<string> | undefined {
  try {
    return referenceWords(sample, extension);
  } catch (error) {
    if (extension === 'rb') return undefined;
    throw error;
  }
}

/** calibre's text of an e-book, or undefined when `ebook-convert` is not installed (or the format is not an e-book). */
function calibreWords(sample: Buffer, extension: string): Set<string> | undefined {
  const tool = defaultResolver()('ebook-convert');
  if (!tool || !CALIBRE_EXTENSIONS.has(extension)) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibre-ref-'));
  try {
    fs.writeFileSync(path.join(dir, `in.${extension}`), sample);
    execFileSync(tool, [path.join(dir, `in.${extension}`), path.join(dir, 'out.txt')], { stdio: 'ignore', timeout: 120_000 });
    return new Set(wordsOf(fs.readFileSync(path.join(dir, 'out.txt'), 'utf-8')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function epubWords(epub: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(epub);
  const parts: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (/\.(xhtml|html|htm)$/i.test(name)) parts.push(stripMarkup(await zip.files[name].async('string')));
  }
  return wordsOf(parts.join(' '));
}

async function outputWords(output: Buffer, target: string): Promise<string[] | undefined> {
  if (target === 'pdf') return pdfWords(output);
  if (target === 'html') return wordsOf(stripMarkup(output.toString('utf-8')));
  if (target === 'csv') return cellWordsOf(output.toString('utf-8'));
  if (TEXT_TARGETS.has(target)) return wordsOf(output.toString('utf-8'));
  if (target === 'epub') return epubWords(output);
  if (target === 'xps') return wordsOf(await xpsGlyphText(output));
  if (SPREADSHEET_TARGETS.has(target)) return sofficeConvert(output, `out.${target}`, CSV_AS_SHOWN, (rendered) => cellWordsOf(rendered.read().toString('utf-8')));
  if (OFFICE_RENDERED_TARGETS.has(target)) return sofficeConvert(output, `out.${target}`, 'pdf', (rendered) => pdfWords(rendered.read()));
  return undefined;
}

/** The type and creator of a Palm database ([Palm database header]: bytes 60 to 67) of the Palm-family outputs. */
const PALM_TYPE_AND_CREATOR: Readonly<Record<string, string>> = { azw3: 'BOOKMOBI', mobi: 'BOOKMOBI', pdb: 'TEXtREAd' };

function expectEbookContainer(output: Buffer, target: string): void {
  expect(output.length).toBeGreaterThan(0);
  const palm = PALM_TYPE_AND_CREATOR[target];
  if (palm !== undefined) expect(output.subarray(60, 68).toString('latin1')).toBe(palm);
}

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

function expectWordsOf(reference: ReadonlySet<string>, produced: readonly string[], label: string): void {
  const have = new Set(produced);
  const missing = [...reference].filter((word) => !have.has(word));
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

describe.skipIf(toolsMissing)('real files of the formats the office suite reads', () => {
  for (const { id, extension, targets, resaveAs } of SAMPLES) {
    it(
      `${id} as .${extension}: converts to ${targets.join(', ')} with the words the office suite shows`,
      async (ctx) => {
        const { bytes: original } = await requireRealworldSample(ctx, id);
        const sample = resaveAs === undefined ? original : sofficeConvert(original, id, resaveAs, (output) => output.read());
        const reference = referenceOrRefusal(sample, extension);
        if (reference === undefined) {
          // The office suite of this machine has no import filter for the format: the answer is a typed refusal that says so.
          const refusal = await dispatchConversion(sample, extension, targets[0], {}, id).catch((error: unknown) => error);
          expect(refusal).toBeInstanceOf(ConversionFailedError);
          expect((refusal as Error).message).toMatch(/has no import filter/);
          return;
        }
        const textReference = textExportWords(sample, extension);
        const calibre = calibreWords(sample, extension);
        for (const target of targets) {
          const label = `${id} -> ${target}`;
          const result = await dispatchConversion(sample, extension, target, {}, id);
          // A document of several pages becomes one image per page, in a ZIP.
          const extensions = IMAGE_TARGETS.has(target) ? [`.${target}`, '.zip'] : [`.${target}`];
          expect(extensions, label).toContain(path.extname(result.filename));
          expect(result.buffer.length, label).toBeGreaterThan(0);
          if (IMAGE_TARGETS.has(target)) {
            await expectPageImage(result.buffer, target);
            continue;
          }
          if (EBOOK_CONTAINER_TARGETS.has(target)) {
            expectEbookContainer(result.buffer, target);
            continue;
          }
          const produced = await outputWords(result.buffer, target);
          expect(produced, label).toBeDefined();
          // The text export of a word processor leaves out page headers and frames, as the plain-text target does.
          expectWordsOf(target === 'txt' && textReference !== undefined ? textReference : reference, produced ?? [], label);
          if (calibre && (target === 'txt' || target === 'epub')) expectWordsOf(calibre, produced ?? [], `${label} (calibre)`);
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});
