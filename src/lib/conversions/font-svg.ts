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
  /**
   * True for the glyph form that serves a character in every context: no lang attribute, and an
   * arabic-form that is absent or isolated (SVG 1.1 20.8.3). Other glyphs are contextual variants
   * that a character map must not point to.
   */
  isDefaultForm: boolean;
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
const ARABIC_FORM_ISOLATED = 'isolated';
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

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
/**
 * Names of the elements the engine reads, matched at a fixed position right after '<' (sticky), so
 * the cost of a candidate tag never depends on what follows it. Longer names come first.
 */
const ELEMENT_NAME_PATTERN = /(font-face|missing-glyph|glyph|font)(?=[ \t\r\n/>])/y;
const FONT_END_PATTERN = /<\/font\s*>/;
// Digits, an optional fraction and an optional exponent, written without overlapping alternatives so
// that a long run of digits followed by junk fails in linear time.
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ENTITY_PATTERN =/&([^&;]*)(;?)/g;

const FONT_ELEMENT: ReadonlySet<string> = new Set(['font']);
const READ_ELEMENTS: ReadonlySet<string> = new Set(['font-face', 'missing-glyph', 'glyph']);

const CODE_LESS_THAN = 0x3c;
const CODE_GREATER_THAN = 0x3e;
const CODE_DOUBLE_QUOTE = 0x22;
const CODE_SINGLE_QUOTE = 0x27;
const CODE_EQUALS = 0x3d;
const CODE_SLASH = 0x2f;
/** XML 1.0 white space (production S): space, tab, carriage return and line feed. */
const XML_WHITESPACE = new Set([0x20, 0x09, 0x0d, 0x0a]);
/** Characters that end an attribute name. */
const ATTRIBUTE_NAME_STOPS = new Set([CODE_EQUALS, CODE_SLASH, CODE_GREATER_THAN, CODE_DOUBLE_QUOTE, CODE_SINGLE_QUOTE]);

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

function isAttributeNameCode(code: number): boolean {
  return !XML_WHITESPACE.has(code) && !ATTRIBUTE_NAME_STOPS.has(code);
}

/**
 * Reads name="value" and name='value' pairs from the inside of a start tag in one pass: the first
 * value of a repeated name wins, and quoted text that is not the value of an attribute is skipped.
 * The tag scanner has already checked that every quote in `source` is closed.
 */
function readAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const length = source.length;
  let pos = 0;
  while (pos < length) {
    const code = source.charCodeAt(pos);
    if (code === CODE_DOUBLE_QUOTE || code === CODE_SINGLE_QUOTE) {
      const close = source.indexOf(source[pos], pos + 1);
      pos = close === -1 ? length : close + 1;
      continue;
    }
    if (!isAttributeNameCode(code)) {
      pos++;
      continue;
    }
    let nameEnd = pos + 1;
    while (nameEnd < length && isAttributeNameCode(source.charCodeAt(nameEnd))) nameEnd++;
    let cursor = nameEnd;
    while (cursor < length && XML_WHITESPACE.has(source.charCodeAt(cursor))) cursor++;
    if (source.charCodeAt(cursor) === CODE_EQUALS) {
      cursor++;
      while (cursor < length && XML_WHITESPACE.has(source.charCodeAt(cursor))) cursor++;
      const quote = source.charCodeAt(cursor);
      if (quote === CODE_DOUBLE_QUOTE || quote === CODE_SINGLE_QUOTE) {
        const close = source.indexOf(source[cursor], cursor + 1);
        if (close !== -1) {
          const name = source.slice(pos, nameEnd);
          if (!attributes.has(name)) attributes.set(name, decodeEntities(source.slice(cursor + 1, close), name));
          pos = close + 1;
          continue;
        }
      }
    }
    pos = nameEnd;
  }
  return attributes;
}

/** Removes <!-- ... --> comments in one pass; a comment that is never closed is a format error. */
function stripComments(text: string): string {
  let open = text.indexOf(COMMENT_OPEN);
  if (open === -1) return text;
  const kept: string[] = [];
  let from = 0;
  while (open !== -1) {
    const close = text.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length);
    if (close === -1) throw new SvgFontFormatError('SVG font document has a comment that is never closed.');
    kept.push(text.slice(from, open));
    from = close + COMMENT_CLOSE.length;
    open = text.indexOf(COMMENT_OPEN, from);
  }
  kept.push(text.slice(from));
  return kept.join('');
}

interface StartTag {
  name: string;
  attributes: Map<string, string>;
  /** Index just past the closing '>'. */
  end: number;
}

/**
 * Yields the start tags of the wanted elements in document order. Each character is visited a
 * bounded number of times: attribute values are skipped with indexOf up to their closing quote, a
 * '>' inside a value does not end the tag, and a '<' outside a value (not well-formed XML) or a tag
 * or value that is never closed throws SvgFontFormatError.
 */
function* startTags(text: string, wanted: ReadonlySet<string>): Generator<StartTag> {
  let open = text.indexOf('<');
  while (open !== -1) {
    ELEMENT_NAME_PATTERN.lastIndex = open + 1;
    const named = ELEMENT_NAME_PATTERN.exec(text);
    if (named === null || !wanted.has(named[1])) {
      open = text.indexOf('<', open + 1);
      continue;
    }
    const name = named[1];
    const insideStart = open + 1 + name.length;
    let pos = insideStart;
    for (;;) {
      if (pos >= text.length) {
        throw new SvgFontFormatError(`SVG font <${name}> tag is not closed: the document ends before its '>'.`);
      }
      const code = text.charCodeAt(pos);
      if (code === CODE_GREATER_THAN) break;
      if (code === CODE_LESS_THAN) {
        throw new SvgFontFormatError(`SVG font <${name}> tag contains a '<' before its closing '>'.`);
      }
      if (code === CODE_DOUBLE_QUOTE || code === CODE_SINGLE_QUOTE) {
        const close = text.indexOf(text[pos], pos + 1);
        if (close === -1) throw new SvgFontFormatError(`SVG font <${name}> tag has an attribute value whose closing quote is missing.`);
        pos = close + 1;
      } else {
        pos++;
      }
    }
    yield { name, attributes: readAttributes(text.slice(insideStart, pos)), end: pos + 1 };
    open = text.indexOf('<', pos + 1);
  }
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
  const text = stripComments(source.startsWith(BYTE_ORDER_MARK) ? source.slice(1) : source);

  let fontAttributes: Map<string, string> | null = null;
  let fontFaceAttributes: Map<string, string> | null = null;
  let fontAdvance = 0;
  let unitsPerEm = DEFAULT_UNITS_PER_EM;
  let fontEnd = text.length;
  const glyphTags: Array<{ attributes: Map<string, string> }> = [];
  let missingTag: Map<string, string> | null = null;
  let bodyStart = 0;

  for (const tag of startTags(text, FONT_ELEMENT)) {
    fontAttributes = tag.attributes;
    bodyStart = tag.end;
    const tail = text.slice(bodyStart);
    const end = FONT_END_PATTERN.exec(tail);
    fontEnd = end === null ? text.length : bodyStart + end.index;
    break;
  }
  if (fontAttributes === null) return null;

  fontAdvance = advanceAttribute(fontAttributes, 0, 'font element');
  const body = text.slice(bodyStart, fontEnd);
  for (const { name, attributes } of startTags(body, READ_ELEMENTS)) {
    if (name === 'font-face') {
      if (fontFaceAttributes === null) fontFaceAttributes = attributes;
    } else if (name === 'missing-glyph') {
      if (missingTag === null) missingTag = attributes;
    } else if (name === 'glyph') {
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
      isDefaultForm: !attributes.has('lang') && (!attributes.has('arabic-form') || attributes.get('arabic-form')?.trim() === ARABIC_FORM_ISOLATED),
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
