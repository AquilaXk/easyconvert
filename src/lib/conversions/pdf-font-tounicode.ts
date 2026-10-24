import { ConversionFailedError } from '../types';
import { InflateBudget } from './bounded-inflate';
import type { CompositeFontDictionary, PdfDocument, PdfUpdateBase, SimpleFontDictionary } from './pdf-document';
import { numericGlyphNameTexts } from './pdf-numeric-glyph-names';
import { PDF_CONTENT_MAX_FONTS } from './pdf-text-types';
import { type CidText, standardOrderTexts } from './standard-font-glyph-order';
import { type UnicodeCmap, readUnicodeCmap, sfntTableTags } from './truetype-cmap';

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
/** Entries of one bfchar block (the CMap specification allows at most 100). */
const BFCHAR_BLOCK = 100;
const HEX_STRING = /^(?:[0-9A-Fa-f]{2}|\s)+$/;

/** Bytes of a code: two for the Identity CMaps of composite fonts, one for a simple font (section 9.6.5). */
type CodeBytes = 1 | 2;

interface FontMap {
  font: CompositeFontDictionary | SimpleFontDictionary;
  entries: CidText[];
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

/** An Identity font with neither a /ToUnicode map nor a registered collection: pdfjs gives the CID itself as its text. */
function lacksTextMap(font: CompositeFontDictionary): boolean {
  return (
    !font.hasToUnicode &&
    font.encoding !== null &&
    IDENTITY_ENCODINGS.has(font.encoding) &&
    !hasRegisteredCollection(font)
  );
}

/** What a TrueType program says of its glyphs: its Unicode cmap, and whether it names none at all (no `cmap`, no `post`). */
interface ProgramText {
  cmap: UnicodeCmap | null;
  namesNoGlyph: boolean;
}

/** What the programs read so far say, by program: fonts that share a program (the same bytes object) read it once. */
type TextsByProgram = Map<Buffer, ProgramText>;

function programTextOf(program: Buffer, known: TextsByProgram): ProgramText {
  let text = known.get(program);
  if (text === undefined) {
    const cmap = readUnicodeCmap(program);
    const tags = cmap === null ? sfntTableTags(program) : null;
    text = { cmap, namesNoGlyph: tags !== null && !tags.has('cmap') && !tags.has('post') };
    known.set(program, text);
  }
  return text;
}

/** The CIDs whose text the program's cmap gives and the CID itself does not. */
function cmapTexts(cmap: UnicodeCmap, cidToGid: 'identity' | Buffer): CidText[] {
  const glyphCount = cmap.codePointOfGlyph.length;
  const cids = cidToGid === 'identity' ? glyphCount : Math.min(CID_COUNT, Math.floor(cidToGid.length / 2));
  const entries: CidText[] = [];
  for (let cid = 0; cid < cids; cid++) {
    const glyph = cidToGid === 'identity' ? cid : cidToGid.readUInt16BE(cid * 2);
    const codePoint = glyph < glyphCount ? cmap.codePointOfGlyph[glyph] : 0;
    if (codePoint !== 0 && cmap.glyphOfBmpCodePoint[cid] !== glyph) entries.push([cid, codePoint]);
  }
  return entries;
}

/**
 * The text of the font's CIDs: from the cmap of its TrueType program, or, when the program names no glyph (a TrueType
 * program without `cmap` and `post` whose CIDs are its glyph ids, or a CID-keyed CFF program), from the glyph order of the
 * Arial or Times New Roman font its name and widths show it to be (standard-font-glyph-order.ts).
 */
function cidTexts(font: CompositeFontDictionary, known: TextsByProgram): CidText[] {
  if (!lacksTextMap(font)) return [];
  if (font.descendant === CFF_CIDFONT) return font.program === 'cid-cff' ? standardOrderTexts(font.descendantName, font.cidWidths) : [];
  if (font.descendant !== TRUETYPE_CIDFONT) return [];
  const cidToGid = font.cidToGidMap();
  const program = cidToGid === null ? null : font.trueTypeProgram();
  if (cidToGid === null || program === null) return [];
  const { cmap, namesNoGlyph } = programTextOf(program, known);
  if (cmap !== null) return cmapTexts(cmap, cidToGid);
  return namesNoGlyph && cidToGid === 'identity' ? standardOrderTexts(font.descendantName, font.cidWidths) : [];
}

function fontMaps(fonts: CompositeFontDictionary[], simpleFonts: SimpleFontDictionary[]): FontMap[] {
  const maps: FontMap[] = [];
  const known: TextsByProgram = new Map();
  let mapped = 0;
  const add = (font: FontMap['font'], entries: CidText[], codeBytes: CodeBytes): void => {
    if (entries.length === 0 || mapped + entries.length > MAX_MAPPED_CIDS) return;
    mapped += entries.length;
    maps.push({ font, entries, codeBytes });
  };
  for (const font of fonts) add(font, cidTexts(font, known), 2);
  const numericTexts = numericGlyphNameTexts(simpleFonts);
  simpleFonts.forEach((font, index) => add(font, font.hasToUnicode ? [] : numericTexts[index], 1));
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

/** A ToUnicode CMap (section 9.10.3) of codes of `codeBytes` bytes that maps each code to its code point. */
function toUnicodeCMap(entries: CidText[], codeBytes: CodeBytes): string {
  const digits = codeBytes * 2;
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    `<${'0'.repeat(digits)}> <${'F'.repeat(digits)}>`,
    'endcodespacerange',
  ];
  for (let start = 0; start < entries.length; start += BFCHAR_BLOCK) {
    const block = entries.slice(start, start + BFCHAR_BLOCK);
    lines.push(`${block.length} beginbfchar`, ...block.map(([code, codePoint]) => `<${hex(code, digits)}> <${utf16Hex(codePoint)}>`), 'endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n');
}

/**
 * An incremental update that appends, for each font, a ToUnicode stream and the font dictionary again with that stream
 * named, followed by a cross-reference section for those objects and a trailer whose /Prev is the file's last section.
 */
function incrementalUpdate(fileLength: number, base: PdfUpdateBase, maps: FontMap[]): Buffer {
  let out = '\n';
  const defined: Array<{ num: number; gen: number; at: number }> = [];
  const define = (num: number, gen: number, body: string): void => {
    defined.push({ num, gen, at: fileLength + out.length });
    out += `${num} ${gen} obj\n${body}\nendobj\n`;
  };
  maps.forEach(({ font, entries, codeBytes }, index) => {
    const streamNumber = base.nextObjectNumber + index;
    const cmap = toUnicodeCMap(entries, codeBytes);
    define(streamNumber, 0, `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
    define(font.objectNumber, font.generation, `<< /ToUnicode ${streamNumber} 0 R ${font.text.slice(2)}`);
  });
  const xrefAt = fileLength + out.length;
  out += 'xref\n0 1\n0000000000 65535 f \n';
  for (const { num, gen, at } of defined.sort((a, b) => a.num - b.num)) out += `${num} 1\n${String(at).padStart(10, '0')} ${String(gen).padStart(5, '0')} n \n`;
  const root = `${base.root.num} ${base.root.gen} R`;
  out += `trailer\n<< /Size ${base.nextObjectNumber + maps.length} /Root ${root} /Prev ${base.previousXref} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * `pdf` with a /ToUnicode map added to every composite font whose TrueType program gives text its CIDs lack, and to every
 * simple font whose numeric glyph names give text; the same bytes when there is none. A font whose program, map or tables do not read is left as it is. A stream that inflates past
 * a limit ends the pass: the file is then passed on as it is, so a limit is met once and never papered over for some fonts.
 */
export function withFontProgramToUnicode(pdf: Buffer, document: PdfDocument): Buffer {
  try {
    const base = document.updateBase();
    if (base === null) return pdf;
    const maps = fontMaps(document.compositeFonts(MAX_FONTS, new InflateBudget(FONT_PROGRAM_BUDGET_BYTES)), document.simpleFonts(PDF_CONTENT_MAX_FONTS));
    return maps.length === 0 ? pdf : Buffer.concat([pdf, incrementalUpdate(pdf.length, base, maps)]);
  } catch (error) {
    if (error instanceof ConversionFailedError) return pdf;
    throw error;
  }
}
