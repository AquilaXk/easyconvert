import { ADOBE_GLYPH_LIST, ZAPF_DINGBATS_GLYPH_LIST } from './pdf-glyph-list';

/**
 * The text a PDF font glyph name stands for, by the algorithm of the Adobe Glyph List specification ("Unicode and Glyph
 * Names", https://github.com/adobe-type-tools/agl-aglfn): drop everything from the first period, split at underscores
 * into components (a ligature `f_f_i` is three letters), and map each component through the Adobe Glyph List, a
 * `uniXXXX` name (one or more four-digit UTF-16 code units) or a `uXXXX` to `uXXXXXX` name (one scalar value).
 *
 * A glyph named like nothing the specification maps has no text: the result is `null`, never a guess. A ligature with
 * one component that maps to nothing is `null` as a whole, so a half-mapped ligature never reaches the text.
 */

const HEX_RADIX = 16;
const ENTRY_SEPARATOR = ',';
const NAME_SEPARATOR = ';';
const CODE_POINT_SEPARATOR = ' ';
const COMPONENT_SEPARATOR = '_';
/** `uni` followed by groups of four uppercase hexadecimal digits. */
const UNI_NAME = /^uni((?:[0-9A-F]{4})+)$/;
/** `u` followed by four to six uppercase hexadecimal digits. */
const U_NAME = /^u([0-9A-F]{4,6})$/;
const UNI_GROUP = /[0-9A-F]{4}/g;
const MAX_CODE_POINT = 0x10ffff;
const SURROGATES_START = 0xd800;
const SURROGATES_END = 0xdfff;
/** The Latin ligature characters U+FB00 to U+FB06 are written as the letters they join, as every text reader does. */
const LATIN_LIGATURES = /[ﬀ-ﬆ]/g;

function parseList(entries: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const entry of entries.split(ENTRY_SEPARATOR)) {
    const [name, points] = entry.split(NAME_SEPARATOR);
    const codePoints = points.split(CODE_POINT_SEPARATOR).map((hex) => Number.parseInt(hex, HEX_RADIX));
    names.set(name, String.fromCodePoint(...codePoints));
  }
  return names;
}

let adobeGlyphs: ReadonlyMap<string, string> | undefined;
let dingbatGlyphs: ReadonlyMap<string, string> | undefined;

function adobeGlyphList(): ReadonlyMap<string, string> {
  adobeGlyphs ??= parseList(ADOBE_GLYPH_LIST);
  return adobeGlyphs;
}

function dingbatGlyphList(): ReadonlyMap<string, string> {
  dingbatGlyphs ??= parseList(ZAPF_DINGBATS_GLYPH_LIST);
  return dingbatGlyphs;
}

function isScalarValue(codePoint: number): boolean {
  return codePoint <= MAX_CODE_POINT && !(codePoint >= SURROGATES_START && codePoint <= SURROGATES_END);
}

/** The text of a `uniXXXX...` name, or null when a code unit is a surrogate (the specification maps those to nothing). */
function textOfUniName(groups: string): string | null {
  const units = (groups.match(UNI_GROUP) ?? []).map((hex) => Number.parseInt(hex, HEX_RADIX));
  return units.every(isScalarValue) ? String.fromCharCode(...units) : null;
}

function textOfComponent(component: string, dingbats: boolean): string | null {
  if (dingbats) {
    const dingbat = dingbatGlyphList().get(component);
    if (dingbat !== undefined) return dingbat;
  }
  const listed = adobeGlyphList().get(component);
  if (listed !== undefined) return listed;
  const uni = UNI_NAME.exec(component);
  if (uni) return textOfUniName(uni[1]);
  const scalar = U_NAME.exec(component);
  if (scalar) {
    const codePoint = Number.parseInt(scalar[1], HEX_RADIX);
    return isScalarValue(codePoint) ? String.fromCodePoint(codePoint) : null;
  }
  return null;
}

export interface GlyphNameOptions {
  /**
   * The font is Zapf Dingbats, whose `a1` to `a206` names the Zapf Dingbats list maps. Any other font may use such a
   * name for something else (a bitmap font from a typesetting system numbers its glyphs `a16`, `a17`), so the list
   * applies to a Zapf Dingbats font only.
   */
  dingbats?: boolean;
}

/** The text the glyph name stands for, or null when no rule of the specification maps it. */
export function glyphNameToText(glyphName: string, options: GlyphNameOptions = {}): string | null {
  const base = glyphName.split('.', 1)[0];
  if (base === '') return null;
  let text = '';
  for (const component of base.split(COMPONENT_SEPARATOR)) {
    const part = textOfComponent(component, options.dingbats === true);
    if (part === null) return null;
    text += part;
  }
  return text === '' ? null : text.replace(LATIN_LIGATURES, (ligature) => ligature.normalize('NFKC'));
}
