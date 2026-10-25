import { ConversionFailedError } from '../types';
import { InflateBudget } from './bounded-inflate';
import type { CompositeFontDictionary, PdfDocument, PdfUpdateBase, SimpleFontDictionary } from './pdf-document';
import { type PdfObjectDefinition, withIncrementalUpdate } from './pdf-incremental-update';
import { numericGlyphNameTexts } from './pdf-numeric-glyph-names';
import { PDF_CONTENT_MAX_FONTS } from './pdf-text-types';
import { readToUnicodeCoverage, type ToUnicodeCoverage } from './pdf-tounicode-coverage';
import { type CidText, standardOrderTexts } from './standard-font-glyph-order';
import { type UnicodeCmap, readGlyphCount, readUnicodeCmap, sfntTableTags } from './truetype-cmap';

/**
 * The text of composite fonts that carry no /ToUnicode map, read from the TrueType program they embed.
 *
 * ISO 32000-1 section 9.10.2 reads a glyph's text from the font's /ToUnicode map, then, for a composite font, from the
 * predefined CMap of a registered character collection (Adobe-GB1, -CNS1, -Japan1, -Korea1); after that the standard
 * gives no source. pdfjs then writes the CID itself as the character, which is wrong text for a font whose CIDs are glyph
 * ids, as the Identity-H fonts of CAD plot drivers are. For such a font (Identity-H or Identity-V, CIDFontType2,
 * no /ToUnicode, no registered collection) the CID leads to a glyph through the /CIDToGIDMap, and the program's own
 * Unicode `cmap` names the character of that glyph (truetype-cmap.ts). A program that names no glyph at all (TrueType
 * without `cmap` and `post`, or a CID-keyed CFF program of a CIDFontType0 font) leaves the font's name: an Arial or Times
 * New Roman font whose /W widths are those of that font at glyph id = CID reads through that font's glyph order
 * (standard-font-glyph-order.ts).
 *
 * The map reaches pdfjs the way the standard defines it: the copy of the file that the text thread reads gets an
 * incremental update (section 7.5.6) that gives each such font a /ToUnicode stream. pdfjs then builds its text, spacing
 * and reading order from real characters, and every glyph the map does not cover reads exactly as before. A CID that
 * already is the code point the cmap maps to its glyph is left out of the map, so text that read right before is
 * unchanged. A file with no such font, or whose fonts give nothing, is passed on as the same bytes.
 *
 * A simple font without a /ToUnicode map whose /Differences glyph names are numbers gets a map of one-byte codes the same
 * way, with the characters Poppler reads those names as (pdf-numeric-glyph-names.ts).
 *
 * A composite font whose /ToUnicode map lists some of its codes is read through the map alone by Poppler, and a code the map
 * lacks has no text (`poppler/GfxFont.cc` 26.09, `GfxCIDFont::getNextChar` lines 1939 to 1948, `CharCodeToUnicode::mapToUnicode`
 * lines 499 to 519; GPL, followed for its behaviour only). pdfjs gives such a code as itself (`src/core/fonts.js`
 * `_charToGlyph`, `toUnicode.get(charcode) || charcode`), which for the codes of a font that are its glyph ids is a wrong
 * letter. For a TrueType font the update therefore adds an entry for each code the font can select that its map lacks, in the
 * order of section 9.10.2: the program's cmap (as above, the CIDs that are their code point included, since the font no longer
 * falls back to the CID), and otherwise a run of private-use characters that the reader leaves out and counts
 * (pdf-glyph-recovery.ts). The font's own map follows the added entries in the new stream, and the later entry of a code wins
 * in pdfjs's CMap reader. A map that lists no code is no map (pdfjs and Poppler read the font as one without), so such a
 * font is read as above. The codes a map lists are read as pdfjs reads them (pdf-tounicode-coverage.ts).
 */

const IDENTITY_ENCODINGS = new Set(['Identity-H', 'Identity-V']);
const REGISTERED_REGISTRY = 'Adobe';
const REGISTERED_ORDERINGS = new Set(['GB1', 'CNS1', 'Japan1', 'Korea1']);
const TRUETYPE_CIDFONT = 'CIDFontType2';
const CFF_CIDFONT = 'CIDFontType0';
/** Most composite fonts of one document whose programs are read. */
const MAX_FONTS = 64;
/** Decoded bytes of font programs and CIDToGIDMap streams read for one document. */
const FONT_PROGRAM_BUDGET_BYTES = 64 * 1024 * 1024;
/** Most CIDs the maps of one document give text: a full CJK font has about 65,000 glyphs. */
const MAX_MAPPED_CIDS = 1 << 18;
/** Two-byte codes: Identity-H selects CIDs 0 to 65,535. */
const CID_COUNT = 0x10000;
/**
 * The text of the CIDs that have none: a run of private-use characters from U+E000, which pdfjs keeps as characters (a
 * non-empty string is true) and the reader leaves out and counts (pdf-glyph-recovery.ts). A `bfrange` maps a run to
 * consecutive characters; a run is cut at 4,096 codes so that its characters stay in U+E000 to U+EFFF, below the U+F000
 * to U+F0FF where the symbol-font tables keep their characters (symbol-font-map.ts), and so are never read as text.
 */
const NO_TEXT_FIRST = 0xe000;
const NO_TEXT_RUN = 0x1000;
/** Bytes of the fonts' own ToUnicode maps that the update of one document copies: a map follows the entries added in front of it, once for each font that names it. */
const MAX_COPIED_MAP_BYTES = 8 * 1024 * 1024;
/** Entries of one bfchar or bfrange block (the CMap specification allows at most 100). */
const BFCHAR_BLOCK = 100;
const HEX_STRING = /^(?:[0-9A-Fa-f]{2}|\s)+$/;

/** Bytes of a code: two for the Identity CMaps of composite fonts, one for a simple font (section 9.6.5). */
type CodeBytes = 1 | 2;

/** The codes `first` to `last` (inclusive) that have no text. */
type Gap = readonly [first: number, last: number];

/** What a ToUnicode stream the update adds holds. Fonts that read the same program and the same own map share one body. */
interface MapBody {
  /** The codes that have text. */
  entries: CidText[];
  /** The codes that have none. */
  gaps: Gap[];
  /** The font's own ToUnicode map, which follows the entries and wins over them; null when the entries are the whole map. */
  own: string | null;
}

interface FontMap {
  font: CompositeFontDictionary | SimpleFontDictionary;
  body: MapBody;
  codeBytes: CodeBytes;
}

/** The text of a string of the font dictionary: as written, and decoded when it is a hex string. */
function stringForms(raw: string | null): string[] {
  if (raw === null) return [];
  return HEX_STRING.test(raw) ? [raw, Buffer.from(raw.replace(/\s/g, ''), 'hex').toString('latin1')] : [raw];
}

function hasRegisteredCollection(font: CompositeFontDictionary): boolean {
  return stringForms(font.registry).includes(REGISTERED_REGISTRY) && stringForms(font.ordering).some((ordering) => REGISTERED_ORDERINGS.has(ordering));
}

function hasIdentityEncoding(font: CompositeFontDictionary): boolean {
  return font.encoding !== null && IDENTITY_ENCODINGS.has(font.encoding);
}

/** An Identity font with no registered collection and no map pdfjs reads: it gives the CID itself as its text. */
function readsCidAsText(font: CompositeFontDictionary): boolean {
  return hasIdentityEncoding(font) && !hasRegisteredCollection(font);
}

/** What a TrueType program says of its glyphs: its Unicode cmap, its glyph count, and whether it names none at all (no `cmap`, no `post`). */
interface ProgramText {
  cmap: UnicodeCmap | null;
  glyphCount: number | null;
  namesNoGlyph: boolean;
}

/** A font's own ToUnicode stream as text, and the codes it gives text (`inherits` when it names another CMap). */
interface OwnMap {
  text: string;
  coverage: ToUnicodeCoverage | 'inherits';
}

/** What has been read so far, by the bytes object of the stream: fonts that share a program or a map (the same bytes object) read it once. */
interface Known {
  programs: Map<Buffer, ProgramText>;
  maps: Map<Buffer, OwnMap>;
  /** The bodies built from a program's cmap, by own map, program and CID-to-glyph map: the 64 fonts of a document that were written from one font share one. */
  bodies: Map<string, MapBody | null>;
  /** Small numbers for the texts and bytes objects that key `bodies`. */
  keys: Map<string | Buffer, number>;
}

function programTextOf(program: Buffer, { programs }: Known): ProgramText {
  let text = programs.get(program);
  if (text === undefined) {
    const cmap = readUnicodeCmap(program);
    const tags = cmap === null ? sfntTableTags(program) : null;
    text = { cmap, glyphCount: readGlyphCount(program), namesNoGlyph: tags !== null && !tags.has('cmap') && !tags.has('post') };
    programs.set(program, text);
  }
  return text;
}

/** The CIDs whose text the program's cmap gives; without `keepIdentity`, those whose CID is not that text already. */
function cmapTexts(cmap: UnicodeCmap, cidToGid: 'identity' | Buffer, keepIdentity: boolean): CidText[] {
  const glyphCount = cmap.codePointOfGlyph.length;
  const cids = cidToGid === 'identity' ? glyphCount : Math.min(CID_COUNT, Math.floor(cidToGid.length / 2));
  const entries: CidText[] = [];
  for (let cid = 0; cid < cids; cid++) {
    const glyph = cidToGid === 'identity' ? cid : cidToGid.readUInt16BE(cid * 2);
    const codePoint = glyph < glyphCount ? cmap.codePointOfGlyph[glyph] : 0;
    if (codePoint !== 0 && (keepIdentity || cmap.glyphOfBmpCodePoint[cid] !== glyph)) entries.push([cid, codePoint]);
  }
  return entries;
}

/** The TrueType program of a CIDFontType2 font, what it says of its glyphs, and the map from CIDs to its glyphs. */
interface TrueTypeFont {
  cidToGid: 'identity' | Buffer;
  program: Buffer;
  text: ProgramText;
}

function trueTypeFontOf(font: CompositeFontDictionary, known: Known): TrueTypeFont | null {
  if (font.descendant !== TRUETYPE_CIDFONT) return null;
  const cidToGid = font.cidToGidMap();
  const program = cidToGid === null ? null : font.trueTypeProgram();
  return cidToGid === null || program === null ? null : { cidToGid, program, text: programTextOf(program, known) };
}

/** The CIDs of the font whose text its program gives: from the cmap, or, when the program names no glyph, from the glyph order of Arial or Times New Roman. */
function programTexts(font: CompositeFontDictionary, { cidToGid, text: { cmap, namesNoGlyph } }: TrueTypeFont, keepIdentity: boolean): CidText[] {
  if (cmap !== null) return cmapTexts(cmap, cidToGid, keepIdentity);
  return namesNoGlyph && cidToGid === 'identity' ? standardOrderTexts(font.descendantName, font.cidWidths) : [];
}

/**
 * The text of the font's CIDs: from the cmap of its TrueType program, or, when the program names no glyph (a TrueType
 * program without `cmap` and `post` whose CIDs are its glyph ids, or a CID-keyed CFF program), from the glyph order of the
 * Arial or Times New Roman font its name and widths show it to be (standard-font-glyph-order.ts). A CID that already is
 * the text it gets is left out: pdfjs gives the CID itself for a CID with no entry.
 */
function cidTexts(font: CompositeFontDictionary, known: Known): CidText[] {
  if (font.descendant === CFF_CIDFONT) return font.program === 'cid-cff' ? standardOrderTexts(font.descendantName, font.cidWidths) : [];
  const trueType = trueTypeFontOf(font, known);
  return trueType === null ? [] : programTexts(font, trueType, false);
}

/** The codes a TrueType font can select: a CID per glyph, or per two bytes of its CID-to-glyph stream. */
function cidCountOf({ cidToGid }: TrueTypeFont, glyphCount: number): number {
  return cidToGid === 'identity' ? glyphCount : Math.min(CID_COUNT, Math.floor(cidToGid.length / 2));
}

/**
 * The codes of a TrueType font that the font's own map gives no text, for a font whose own map pdfjs would complete with the
 * CID itself: the program's text where it has one, and a gap where it has none. Null when the codes cannot be counted
 * (a program without a glyph count).
 */
function missingCodes(font: CompositeFontDictionary, trueType: TrueTypeFont, own: string, coverage: ToUnicodeCoverage): MapBody | null {
  const glyphCount = trueType.text.glyphCount;
  if (glyphCount === null) return null;
  const texts = new Map(programTexts(font, trueType, true));
  const entries: CidText[] = [];
  const gaps: Gap[] = [];
  for (let cid = 0, cidCount = cidCountOf(trueType, glyphCount); cid < cidCount; cid++) {
    if (coverage.covers(cid)) continue;
    const text = texts.get(cid);
    const last = gaps[gaps.length - 1];
    if (text !== undefined) entries.push([cid, text]);
    else if (last !== undefined && last[1] === cid - 1) gaps[gaps.length - 1] = [last[0], cid];
    else gaps.push([cid, cid]);
  }
  return { entries, gaps, own };
}

/** A small number for a text or a bytes object, the same for the same one, to key what is built from them. */
function keyOf(value: string | Buffer, { keys }: Known): number {
  let key = keys.get(value);
  if (key === undefined) {
    key = keys.size;
    keys.set(value, key);
  }
  return key;
}

function ownMapOf(data: Buffer, { maps }: Known): OwnMap {
  let own = maps.get(data);
  if (own === undefined) {
    const text = data.toString('latin1');
    own = { text, coverage: readToUnicodeCoverage(text) };
    maps.set(data, own);
  }
  return own;
}

/** The map of a font that has no map pdfjs reads: its CIDs' text from the program, for the fonts pdfjs would give the CID itself. */
function mapFromProgram(font: CompositeFontDictionary, known: Known): MapBody | null {
  return readsCidAsText(font) ? { entries: cidTexts(font, known), gaps: [], own: null } : null;
}

/**
 * The map of a font whose /ToUnicode stream lists codes: an entry for each code the font can select that the map lacks, in
 * front of the map. Fonts of one document that were written from the same program, CID-to-glyph map and own map (a producer
 * that writes a font again for every page) get one body, built once; that holds when the text comes from the program's
 * cmap, and not when it comes from the name and widths of each font.
 */
function mapCompletingOwn(font: CompositeFontDictionary, known: Known): MapBody | null {
  const data = font.toUnicodeData();
  if (data === null || !hasIdentityEncoding(font) || !font.text.trimEnd().endsWith('>>')) return null;
  const own = ownMapOf(data, known);
  if (own.coverage === 'inherits') return null;
  if (!own.coverage.listsCodes) return mapFromProgram(font, known);
  const trueType = trueTypeFontOf(font, known);
  if (trueType === null) return null;
  const { text, coverage } = own;
  if (trueType.text.cmap === null) return missingCodes(font, trueType, text, coverage);
  const key = [keyOf(text, known), keyOf(trueType.program, known), trueType.cidToGid === 'identity' ? -1 : keyOf(trueType.cidToGid, known)].join(':');
  if (!known.bodies.has(key)) known.bodies.set(key, missingCodes(font, trueType, text, coverage));
  return known.bodies.get(key) ?? null;
}

/** What the document spends on the maps it adds: the codes they give an entry and the bytes of the fonts' own maps they copy. */
interface MapBudget {
  codes: number;
  copiedBytes: number;
}

const codesOf = ({ entries, gaps }: MapBody): number => entries.length + gaps.reduce((sum, [first, last]) => sum + last - first + 1, 0);

function fontMaps(fonts: CompositeFontDictionary[], simpleFonts: SimpleFontDictionary[]): FontMap[] {
  const maps: FontMap[] = [];
  const known: Known = { programs: new Map(), maps: new Map(), bodies: new Map(), keys: new Map() };
  const budget: MapBudget = { codes: 0, copiedBytes: 0 };
  const charged = new Set<MapBody>();
  const add = (font: FontMap['font'], body: MapBody | null, codeBytes: CodeBytes): void => {
    const size = body === null ? 0 : codesOf(body);
    if (body === null || size === 0) return;
    if (!charged.has(body)) {
      const copied = body.own?.length ?? 0;
      if (budget.codes + size > MAX_MAPPED_CIDS || budget.copiedBytes + copied > MAX_COPIED_MAP_BYTES) return;
      budget.codes += size;
      budget.copiedBytes += copied;
      charged.add(body);
    }
    maps.push({ font, body, codeBytes });
  };
  for (const font of fonts) add(font, font.hasToUnicode ? mapCompletingOwn(font, known) : mapFromProgram(font, known), 2);
  const numericTexts = numericGlyphNameTexts(simpleFonts);
  simpleFonts.forEach((font, index) => add(font, font.hasToUnicode ? null : { entries: numericTexts[index], gaps: [], own: null }, 1));
  return maps;
}

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

/** The UTF-16BE code units of a code point in hex: four digits, or eight for a surrogate pair. */
function utf16Hex(codePoint: number): string {
  const text = String.fromCodePoint(codePoint);
  let digits = '';
  for (let index = 0; index < text.length; index++) digits += hex(text.charCodeAt(index), 4);
  return digits;
}

/** The `count beginbfchar` blocks (or `beginbfrange` with `range`) that hold `lines`, a block holding at most 100 of them. */
function blocksOf(lines: string[], operator: 'bfchar' | 'bfrange'): string[] {
  const blocks: string[] = [];
  for (let start = 0; start < lines.length; start += BFCHAR_BLOCK) {
    const block = lines.slice(start, start + BFCHAR_BLOCK);
    blocks.push(`${block.length} begin${operator}`, ...block, `end${operator}`);
  }
  return blocks;
}

/** The blocks that map each code of the body, `codeBytes` bytes long, to its code point, and each gap to private-use characters. */
function bodyBlocks({ entries, gaps }: MapBody, codeBytes: CodeBytes): string[] {
  const digits = codeBytes * 2;
  const chars = entries.map(([code, codePoint]) => `<${hex(code, digits)}> <${utf16Hex(codePoint)}>`);
  const runs: string[] = [];
  for (const [first, last] of gaps) {
    for (let start = first; start <= last; start += NO_TEXT_RUN) {
      runs.push(`<${hex(start, digits)}> <${hex(Math.min(last, start + NO_TEXT_RUN - 1), digits)}> <${hex(NO_TEXT_FIRST, 4)}>`);
    }
  }
  return [...blocksOf(chars, 'bfchar'), ...blocksOf(runs, 'bfrange')];
}

/**
 * A ToUnicode CMap (section 9.10.3) of codes of `codeBytes` bytes that maps each code of the body to its text. With an own
 * map, that map follows the blocks and is the CMap's body: pdfjs reads the blocks in order and the later entry of a code
 * wins, and it stops at the first `endcmap`, so the added blocks come first and bring no `endcmap` of their own.
 */
function toUnicodeCMap(body: MapBody, codeBytes: CodeBytes): string {
  const blocks = bodyBlocks(body, codeBytes);
  if (body.own !== null) return [...blocks, body.own].join('\n');
  const digits = codeBytes * 2;
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    `<${'0'.repeat(digits)}> <${'F'.repeat(digits)}>`,
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

/**
 * The font dictionary with /ToUnicode naming `streamNumber`. A dictionary that has an entry of its own gets the new one
 * after it, since the later entry of a key wins in pdfjs's dictionary reader; one without gets it first.
 */
function fontDictionaryNaming(font: FontMap['font'], streamNumber: number): string {
  return font.hasToUnicode ? `${font.text.trimEnd().slice(0, -2)} /ToUnicode ${streamNumber} 0 R >>` : `<< /ToUnicode ${streamNumber} 0 R ${font.text.slice(2)}`;
}

/** A ToUnicode stream for each body, numbered from `base.nextObjectNumber`, and each font's dictionary again with its body's stream named. */
function toUnicodeObjects(base: PdfUpdateBase, maps: FontMap[]): PdfObjectDefinition[] {
  const streams = new Map<MapBody, number>();
  const objects: PdfObjectDefinition[] = [];
  for (const { font, body, codeBytes } of maps) {
    let streamNumber = streams.get(body);
    if (streamNumber === undefined) {
      streamNumber = base.nextObjectNumber + streams.size;
      streams.set(body, streamNumber);
      const cmap = toUnicodeCMap(body, codeBytes);
      objects.push({ num: streamNumber, gen: 0, body: `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream` });
    }
    objects.push({ num: font.objectNumber, gen: font.generation, body: fontDictionaryNaming(font, streamNumber) });
  }
  return objects;
}

/**
 * `pdf` with a /ToUnicode map added to every composite font whose TrueType program gives text its CIDs lack, and to every
 * simple font whose numeric glyph names give text; the same bytes when there is none. A font whose program, map or tables do not read is left as it is. A stream that inflates past
 * a limit ends the pass: the file is then passed on as it is, so a limit is met once and never papered over for some fonts.
 */
export function withFontProgramToUnicode(pdf: Buffer, document: PdfDocument): Buffer {
  const base = document.updateBase();
  return base === null ? pdf : withIncrementalUpdate(pdf, base, fontProgramToUnicodeObjects(document, base));
}

/** The objects of `withFontProgramToUnicode`'s update, for a caller that writes them with other objects in one update. */
export function fontProgramToUnicodeObjects(document: PdfDocument, base: PdfUpdateBase): PdfObjectDefinition[] {
  try {
    return toUnicodeObjects(base, fontMaps(document.compositeFonts(MAX_FONTS, new InflateBudget(FONT_PROGRAM_BUDGET_BYTES)), document.simpleFonts(PDF_CONTENT_MAX_FONTS)));
  } catch (error) {
    if (error instanceof ConversionFailedError) return [];
    throw error;
  }
}
