import fs from 'node:fs';
import JSZip from 'jszip';
import { OutputIntegrityError } from './errors';
import type { ReferenceServer } from './reference-server';

/**
 * The text of an office document as its format holds it, read without a converter, so that a conversion is scored against
 * what the file says and not against what another converter made of it. The OOXML and OpenDocument formats are ZIP packages of
 * XML and are read here; the 97-2003 binary formats are read by olefile and xlrd in bench/reference-server.py (`office.text`);
 * RTF and HTML are read by the small readers below. Each reader returns the text of the body: field codes, deleted revisions,
 * styles, macros and the fallback copy of a shape are not text, and a number in a cell is not a word.
 */

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the named XML entities and the numeric references of a piece of markup text. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return XML_ENTITIES[name.toLowerCase()] ?? match;
  });
}

const stripTags = (markup: string): string => decodeEntities(markup.replaceAll(/<[^>]+>/g, ' '));

/** The text of every element that matches (`<w:t>` runs and the like), one entry each. */
function elementTexts(xml: string, element: RegExp): string[] {
  return [...xml.matchAll(element)].map((match) => decodeEntities(match[1].replaceAll(/<[^>]+>/g, '')));
}

async function entryText(zip: JSZip, name: string): Promise<string> {
  return (await zip.file(name)?.async('string')) ?? '';
}

const byNumberedName = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

/** The text of the charts of a package: titles and labels, and the cached strings of the categories and series names (the numbers are not words). */
async function chartTexts(zip: JSZip, directory: string): Promise<string[]> {
  const texts: string[] = [];
  const prefix = new RegExp(`^${directory}/chart\\d+\\.xml$`);
  for (const name of Object.keys(zip.files).filter((entry) => prefix.test(entry)).sort(byNumberedName)) {
    const xml = await entryText(zip, name);
    texts.push(...elementTexts(xml, /<a:t>([^<]*)<\/a:t>/g));
    for (const cache of xml.matchAll(/<c:strCache>([\s\S]*?)<\/c:strCache>/g)) texts.push(...elementTexts(cache[1], /<c:v>([^<]*)<\/c:v>/g));
  }
  return texts;
}

/** The text of a WordprocessingML package: the body, the footnotes and the endnotes; revisions that were deleted and the fallback copy of a shape are not text. */
async function docxText(zip: JSZip): Promise<string> {
  const parts = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'];
  const texts: string[] = [];
  for (const name of parts) {
    const xml = (await entryText(zip, name)).replaceAll(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, ' ');
    texts.push(...elementTexts(xml, /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g));
  }
  texts.push(...(await chartTexts(zip, 'word/charts')));
  return texts.join(' ');
}

/** The text of a SpreadsheetML package: the shared strings and the inline strings; numbers are not words. */
async function xlsxText(zip: JSZip): Promise<string> {
  const shared = await entryText(zip, 'xl/sharedStrings.xml');
  const texts = elementTexts(shared, /<si\b[^>]*>([\s\S]*?)<\/si>/g);
  for (const name of Object.keys(zip.files).filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry)).sort(byNumberedName)) {
    texts.push(...elementTexts(await entryText(zip, name), /<is\b[^>]*>([\s\S]*?)<\/is>/g));
  }
  texts.push(...(await chartTexts(zip, 'xl/charts')));
  return texts.join(' ');
}

/** The text of a PresentationML package: the text runs of the slides, not of the notes or the masters. */
async function pptxText(zip: JSZip): Promise<string> {
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(byNumberedName);
  const texts: string[] = [];
  for (const name of slides) texts.push(...elementTexts(await entryText(zip, name), /<a:t>([^<]*)<\/a:t>/g));
  texts.push(...(await chartTexts(zip, 'ppt/charts')));
  return texts.join(' ');
}

/** The text of an OpenDocument package: every text node of the content part, which holds no style or font names as text. */
async function odfText(zip: JSZip): Promise<string> {
  const content = (await entryText(zip, 'content.xml')).replace(/<office:(?:automatic-styles|font-face-decls|scripts)\b[\s\S]*?<\/office:(?:automatic-styles|font-face-decls|scripts)>/g, ' ');
  return stripTags(content.replaceAll(/<text:(?:tab|s|line-break)\b[^>]*\/>/g, ' '));
}

/** Windows code pages an RTF file names with `\ansicpg`, by the label the WHATWG decoder knows. */
const RTF_CODE_PAGES: Readonly<Record<number, string>> = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257' };
/** Destinations whose content is not text of the body. */
const RTF_SKIPPED_DESTINATIONS: ReadonlySet<string> = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'datastore', 'themedata', 'colorschememapping',
  'latentstyles', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'fldinst', 'bkmkstart', 'bkmkend', 'template', 'filetbl', 'revtbl', 'wgrffmtfilter', 'pnseclvl', 'private', 'userprops', 'mmathPr',
]);
const HEX = /[0-9a-f]{2}/i;

/** The text of an RTF document: control words resolved to their characters, skipped destinations and groups marked `\\*` dropped. */
export function rtfText(source: Buffer): string {
  const text = source.toString('latin1');
  if (!text.startsWith('{\\rtf')) throw new OutputIntegrityError('the file does not start with an RTF header');
  const codePage = RTF_CODE_PAGES[Number(/\\ansicpg(\d+)/.exec(text)?.[1] ?? 1252)] ?? 'windows-1252';
  const decoder = new TextDecoder(codePage);
  const out: string[] = [];
  const pendingBytes: number[] = [];
  const flushBytes = (): void => {
    if (pendingBytes.length > 0) out.push(decoder.decode(Uint8Array.from(pendingBytes)));
    pendingBytes.length = 0;
  };
  const stack: Array<{ skip: boolean; unicodeSkip: number }> = [];
  let skip = false;
  let unicodeSkip = 1;
  let skipNext = 0;
  let at = 0;
  let firstWord = false;
  while (at < text.length) {
    const char = text[at];
    if (char === '{') {
      flushBytes();
      stack.push({ skip, unicodeSkip });
      firstWord = true;
      at++;
    } else if (char === '}') {
      flushBytes();
      const top = stack.pop();
      skip = top?.skip ?? false;
      unicodeSkip = top?.unicodeSkip ?? 1;
      firstWord = false;
      at++;
    } else if (char === '\\') {
      const next = text[at + 1];
      if (next === '*' && firstWord) {
        skip = true;
        at += 2;
      } else if (next === "'") {
        const hex = text.slice(at + 2, at + 4);
        if (skipNext > 0) skipNext--;
        else if (!skip && HEX.test(hex)) pendingBytes.push(Number.parseInt(hex, 16));
        at += 4;
      } else if (next !== undefined && /[a-z]/i.test(next)) {
        flushBytes();
        const word = /^\\([a-z]+)(-?\d+)? ?/i.exec(text.slice(at, at + 40));
        const name = word?.[1] ?? '';
        const value = word?.[2] === undefined ? null : Number(word[2]);
        if (firstWord && RTF_SKIPPED_DESTINATIONS.has(name)) skip = true;
        if (name === 'uc' && value !== null) unicodeSkip = value;
        else if (name === 'u' && value !== null && !skip) {
          out.push(String.fromCodePoint(value < 0 ? value + 65536 : value));
          skipNext = unicodeSkip;
        } else if (!skip && (name === 'par' || name === 'line' || name === 'row' || name === 'cell' || name === 'sect' || name === 'page')) out.push('\n');
        else if (!skip && (name === 'tab' || name === 'emspace' || name === 'enspace')) out.push(' ');
        firstWord = false;
        at += word?.[0].length ?? 2;
      } else {
        flushBytes();
        if (next === '~' && !skip) out.push(' ');
        else if (next === '\\' || next === '{' || next === '}') {
          if (!skip) out.push(next);
        }
        firstWord = false;
        at += 2;
      }
    } else {
      flushBytes();
      if (char !== '\r' && char !== '\n') {
        if (skipNext > 0) skipNext--;
        else if (!skip) out.push(char);
      }
      firstWord = false;
      at++;
    }
  }
  flushBytes();
  return out.join('');
}

/** The text of an HTML document: scripts, styles and the head are not text. */
export function htmlText(source: Buffer): string {
  const markup = source.toString('utf8');
  const body = markup.replaceAll(/<(?:script|style|head|noscript)\b[\s\S]*?<\/(?:script|style|head|noscript)>/gi, ' ').replaceAll(/<!--[\s\S]*?-->/g, ' ');
  return stripTags(body);
}

/** The text of a Markdown document: link targets, image paths and code fences' markers are not text. */
export function markdownText(source: Buffer): string {
  return source
    .toString('utf8')
    .replaceAll(/```[a-z]*\n?/gi, ' ')
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/^[#>*+\-\s|:]+/gm, ' ')
    .replaceAll(/[*_`~#|]/g, ' ');
}

const OOXML_READERS: Readonly<Record<string, (zip: JSZip) => Promise<string>>> = { docx: docxText, docm: docxText, xlsx: xlsxText, xlsm: xlsxText, pptx: pptxText, pptm: pptxText, odt: odfText, ods: odfText, odp: odfText };
const OLE_FORMATS: ReadonlySet<string> = new Set(['doc', 'xls', 'ppt']);

export interface TextReaders {
  /** The reference server that reads the 97-2003 formats (started by the family runner). */
  server: () => ReferenceServer;
}

/** The text of the document at `file`, read from the format; throws when the format has no reader here. */
export async function sourceText(format: string, file: string, readers: TextReaders): Promise<string> {
  const bytes = fs.readFileSync(file);
  const zipReader = OOXML_READERS[format];
  if (zipReader !== undefined) return zipReader(await JSZip.loadAsync(bytes));
  if (OLE_FORMATS.has(format)) return (await readers.server().call<{ text: string }>('office.text', { format, file })).text;
  if (format === 'rtf') return rtfText(bytes);
  if (format === 'html') return htmlText(bytes);
  if (format === 'md') return markdownText(bytes);
  throw new OutputIntegrityError(`no reader of the text of a ${format} document`);
}
