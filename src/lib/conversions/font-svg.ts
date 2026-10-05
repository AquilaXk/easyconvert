import { ConversionFailedError } from '../types';

/**
 * SVG 1.1 font document reader (section 20): the font, font-face, missing-glyph and glyph
 * elements with the attributes the font engine honours (units-per-em, ascent, descent,
 * horiz-adv-x, unicode, glyph-name and d). It only reads the XML layer; the path data of every
 * glyph is returned unparsed for font-svg-path.ts, and building the font is left to font.ts.
 */

/** Largest glyph count a TrueType font can address (65535 including .notdef). */
export const MAX_SVG_FONT_GLYPHS = 0xfffe;

/** The SVG font document is malformed or uses a value the engine cannot represent. */
export class SvgFontFormatError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'SvgFontFormatError';
  }
}

export interface SvgFontGlyph {
  /** Single code point of the unicode attribute; null when absent or a multi-character sequence. */
  codePoint: number | null;
  /** The unicode attribute has more than one character (a ligature, which needs GSUB to apply). */
  isSequence: boolean;
  glyphName: string | null;
  advance: number;
  d: string | null;
  /** Human readable identification used in error messages. */
  label: string;
}

export interface SvgFont {
  family: string | null;
  unitsPerEm: number;
  ascent: number;
  /** Distance below the baseline as a positive number. */
  descent: number;
  /** Default horizontal advance of the font element (0 when absent, as SVG specifies). */
  advance: number;
  missingGlyph: { advance: number; d: string | null } | null;
  glyphs: SvgFontGlyph[];
}

const DEFAULT_UNITS_PER_EM = 1000;
/** SVG 1.1 leaves descent unspecified; a fifth of an em is the conventional value. */
const DEFAULT_DESCENT_PER_EM = 0.2;
const MAX_ADVANCE = 0xffff;
const CODE_POINT_MAX = 0x10ffff;
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;
const BYTE_ORDER_MARK = '﻿';

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
// Element start tags: attribute values may contain '>' inside quotes.
const TAG_PATTERN = /<(font|font-face|missing-glyph|glyph)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const FONT_END_PATTERN = /<\/font\s*>/;
const ATTRIBUTE_PATTERN = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ENTITY_PATTERN =/&([^&;]*)(;?)/g;

/** XML 1.0 Char production: the code points a document may contain, directly or as a reference. */
export function isXmlCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= CODE_POINT_MAX)
  );
}

function decodeEntities(value: string, attribute: string): string {
  return value.replace(ENTITY_PATTERN, (_match, body: string, semicolon: string) => {
    if (semicolon === '') {
      throw new SvgFontFormatError(`SVG font attribute ${attribute} has an unterminated entity reference ("&${body}").`);
    }
    const named = NAMED_ENTITIES.get(body);
    if (named !== undefined) return named;
    const hex = /^#[xX]([0-9a-fA-F]+)$/.exec(body);
    const decimal = /^#([0-9]+)$/.exec(body);
    if (hex === null && decimal === null) {
      throw new SvgFontFormatError(`SVG font attribute ${attribute} uses the unknown entity &${body};.`);
    }
    const codePoint = hex !== null ? Number.parseInt(hex[1], HEX_RADIX) : Number.parseInt((decimal as RegExpExecArray)[1], DECIMAL_RADIX);
    if (!Number.isFinite(codePoint) || !isXmlCharacter(codePoint)) {
      throw new SvgFontFormatError(`SVG font attribute ${attribute} has the character reference &${body}; which is not a valid XML character.`);
    }
    return String.fromCodePoint(codePoint);
  });
}

function readAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1];
    if (attributes.has(name)) continue;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? '', name));
  }
  return attributes;
}

function numberAttribute(attributes: Map<string, string>, name: string): number | null {
  const raw = attributes.get(name);
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  const value = NUMBER_PATTERN.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(value)) {
    throw new SvgFontFormatError(`SVG font attribute ${name}="${raw}" is not a finite number.`);
  }
  return value;
}

function advanceAttribute(attributes: Map<string, string>, fallback: number, label: string): number {
  const value = numberAttribute(attributes, 'horiz-adv-x');
  if (value === null) return fallback;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > MAX_ADVANCE) {
    throw new SvgFontFormatError(`SVG font ${label} has horiz-adv-x ${value}, outside the supported range 0-${MAX_ADVANCE}.`);
  }
  return rounded;
}

function describeGlyph(index: number, name: string | null, unicode: string | null): string {
  if (name !== null && name !== '') return `glyph "${name}"`;
  if (unicode !== null && unicode !== '') return `glyph for U+${(unicode.codePointAt(0) as number).toString(HEX_RADIX).toUpperCase().padStart(4, '0')}`;
  return `glyph #${index + 1}`;
}

/**
 * Reads the first font element of an SVG document. Returns null when the document has no font
 * element at all. Glyphs meant only for vertical text are skipped.
 */
export function parseSvgFontDocument(source: string): SvgFont | null {
  const text = (source.startsWith(BYTE_ORDER_MARK) ? source.slice(1) : source).replace(COMMENT_PATTERN, '');

  let fontAttributes: Map<string, string> | null = null;
  let fontFaceAttributes: Map<string, string> | null = null;
  let fontAdvance = 0;
  let unitsPerEm = DEFAULT_UNITS_PER_EM;
  let fontEnd = text.length;
  const glyphTags: Array<{ attributes: Map<string, string> }> = [];
  let missingTag: Map<string, string> | null = null;
  let bodyStart = 0;

  for (const match of text.matchAll(TAG_PATTERN)) {
    if (match[1] !== 'font') continue;
    fontAttributes = readAttributes(match[2]);
    bodyStart = (match.index as number) + match[0].length;
    const tail = text.slice(bodyStart);
    const end = FONT_END_PATTERN.exec(tail);
    fontEnd = end === null ? text.length : bodyStart + end.index;
    break;
  }
  if (fontAttributes === null) return null;

  fontAdvance = advanceAttribute(fontAttributes, 0, 'font element');
  const body = text.slice(bodyStart, fontEnd);
  for (const match of body.matchAll(TAG_PATTERN)) {
    const attributes = readAttributes(match[2]);
    if (match[1] === 'font-face') {
      if (fontFaceAttributes === null) fontFaceAttributes = attributes;
    } else if (match[1] === 'missing-glyph') {
      if (missingTag === null) missingTag = attributes;
    } else if (match[1] === 'glyph') {
      if (attributes.get('orientation') === 'v') continue;
      glyphTags.push({ attributes });
      if (glyphTags.length > MAX_SVG_FONT_GLYPHS) {
        throw new SvgFontFormatError(`SVG font has more than ${MAX_SVG_FONT_GLYPHS} glyphs, which a TrueType font cannot address.`);
      }
    }
  }

  const face = fontFaceAttributes ?? new Map<string, string>();
  const declaredUnits = numberAttribute(face, 'units-per-em');
  if (declaredUnits !== null) unitsPerEm = declaredUnits;
  const declaredDescent = numberAttribute(face, 'descent');
  const descent = declaredDescent === null ? unitsPerEm * DEFAULT_DESCENT_PER_EM : Math.abs(declaredDescent);
  const declaredAscent = numberAttribute(face, 'ascent');
  const ascent = declaredAscent === null ? unitsPerEm - descent : declaredAscent;

  const glyphs: SvgFontGlyph[] = glyphTags.map(({ attributes }, index) => {
    const unicode = attributes.get('unicode') ?? null;
    const glyphName = attributes.get('glyph-name') ?? null;
    const label = describeGlyph(index, glyphName, unicode);
    const characters = unicode === null ? [] : Array.from(unicode);
    const first = characters.length > 0 ? (characters[0].codePointAt(0) as number) : null;
    if (first !== null && (first === 0 || (first >= SURROGATE_MIN && first <= SURROGATE_MAX))) {
      throw new SvgFontFormatError(`SVG font ${label} has a unicode attribute with an invalid character.`);
    }
    return {
      codePoint: characters.length === 1 ? first : null,
      isSequence: characters.length > 1,
      glyphName: glyphName === '' ? null : glyphName,
      advance: advanceAttribute(attributes, fontAdvance, label),
      d: attributes.get('d') ?? null,
      label,
    };
  });

  const family = face.get('font-family') ?? fontAttributes.get('id') ?? null;
  return {
    family: family === '' ? null : family,
    unitsPerEm,
    ascent,
    descent,
    advance: fontAdvance,
    missingGlyph:
      missingTag === null ? null : { advance: advanceAttribute(missingTag, fontAdvance, 'missing-glyph'), d: missingTag.get('d') ?? null },
    glyphs,
  };
}
