import { CadGeometryUnavailableError, ConversionFailedError, UnsupportedOptionError } from '../types';
import { placeBitmapGlyphText, UNMAPPABLE_CHARACTER, type PdfPageText, type PlacedText } from './bitmap-glyph-text';
import { BitmapGlyphs } from './svg-bitmap-glyph';
import { parseSvgGeometries, type ParsedSvgVectorDocument } from './svg-geometry';

/**
 * DXF writer for vector pages: the page drawn as SVG geometry (flattened curves in device coordinates, every
 * transform and glyph instance already applied) becomes AutoCAD R12 LINE and POLYLINE entities. R12 needs no
 * handles or subclass markers, so every DXF reader opens it. One DXF unit is one SVG user unit, which for a
 * page rendered from PDF or PostScript is one PostScript point; the Y axis points up as in PostScript.
 *
 * A stroke is written as its centre line: width, paint and opacity are not written, and a dash array is an LTYPE entry that the
 * stroke's entities name (svg-pen.ts says what the geometry reader does with each pen attribute, policy 79).
 *
 * The characters of a bitmap font, which Poppler draws as pictures, are written as TEXT in the STANDARD style (font `txt`,
 * AutoCAD's default) from the PDF's text layer (bitmap-glyph-text.ts): each run left-aligned on its baseline and fitted to its
 * advance width (alignment 5, Fit: ezdxf entities/text.py `set_placement`), the field layout ezdxf writes for an R12 TEXT.
 */

const DXF_VERSION = 'AC1009';
const DXF_COORDINATE_DECIMALS = 6;
const DXF_LAYER = '0';
const DXF_LINETYPE = 'CONTINUOUS';
/** The most dash line types one document defines (this writer's own bound, so that a hostile page cannot grow the LTYPE table without end). */
export const MAX_DASH_LINETYPES = 256;
/** Bit 128 of the POLYLINE flags (group 70): the line type pattern runs on across the vertices, where it would start again at each (ezdxf lldxf/const.py `POLYLINE_GENERATE_LINETYPE_PATTERN`). */
const DXF_POLYLINE_PATTERN_GENERATED = 128;
const DXF_DASH_LINETYPE_PREFIX = 'DASH';
const DXF_DASH_DESCRIPTION = 'Dash pattern of the source drawing';
/** AutoCAD Color Index 7: white on a dark background, black on a light one. */
const DXF_ACI_WHITE = 7;
/** Bit 1 of the POLYLINE flags (group 70): the polyline is closed. */
const DXF_POLYLINE_CLOSED = 1;
/** Group codes are right-aligned in three columns. */
const DXF_CODE_WIDTH = 3;
/** Two points closer than this are the same point, so a repeated first vertex marks a closed outline. */
const CLOSURE_EPSILON = 1e-9;
const SVG_ROOT_PATTERN = /<svg\b/i;
const DXF_TEXT_STYLE = 'STANDARD';
const DXF_TEXT_FONT = 'txt';
/** Group 72 of a TEXT: 5 is Fit, the text runs between the two alignment points at its own height. */
const DXF_TEXT_FIT = 5;
/** The longest TEXT string an R12 reader holds (ezdxf tools/text.py `plain_text`: TEXT is a short string, at most 255 in R12). */
const DXF_TEXT_MAX_CHARS = 255;
/** The STYLE entry's last height used (group 42), ezdxf's default for a new text style (entities/textstyle.py). */
const DXF_STYLE_LAST_HEIGHT = 2.5;
const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7e;
/** Characters from the end of the C1 controls to the end of the Basic Multilingual Plane, but for the UTF-16 surrogates. */
const FIRST_ESCAPED = 0xa0;
const FIRST_SURROGATE = 0xd800;
const LAST_SURROGATE = 0xdfff;
const LAST_BMP = 0xffff;
/** Characters a TEXT reader would read as a code: `%%` starts a special character, `^` a control character, `\U+` a code point. */
const TEXT_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['%', '%%%'],
  ['^', '^ '],
  ['\\', '\\U+005C'],
]);

function isEscapedAsCodePoint(code: number): boolean {
  return code >= FIRST_ESCAPED && code <= LAST_BMP && (code < FIRST_SURROGATE || code > LAST_SURROGATE);
}

interface Point {
  x: number;
  y: number;
}

/** Writes one group-code and value pair per line, the code right-aligned as DXF readers expect. */
function pair(code: number, value: string | number): string {
  return `${String(code).padStart(DXF_CODE_WIDTH, ' ')}\n${value}`;
}

/** A DXF number as this writer writes it; `toFixed` writes 1e21 and above with an exponent, and Infinity and NaN as words. */
const PLAIN_DECIMAL_PATTERN = new RegExp(`^-?\\d+\\.\\d{${DXF_COORDINATE_DECIMALS}}$`);

function coordinate(value: number): string {
  const text = value.toFixed(DXF_COORDINATE_DECIMALS);
  if (!PLAIN_DECIMAL_PATTERN.test(text)) {
    throw new CadGeometryUnavailableError('The page cannot be written as DXF: a coordinate or a dash length is too large to write as a plain decimal number.');
  }
  return text;
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= CLOSURE_EPSILON && Math.abs(a.y - b.y) <= CLOSURE_EPSILON;
}

/** The linetype of an entity (group 6) when it is not the layer's: absent for a solid line. */
function linetypePair(linetype: string | null): string[] {
  return linetype === null ? [] : [pair(6, linetype)];
}

function lineEntity(a: Point, b: Point, linetype: string | null): string {
  return [
    pair(0, 'LINE'),
    pair(8, DXF_LAYER),
    ...linetypePair(linetype),
    pair(10, coordinate(a.x)),
    pair(20, coordinate(a.y)),
    pair(30, coordinate(0)),
    pair(11, coordinate(b.x)),
    pair(21, coordinate(b.y)),
    pair(31, coordinate(0)),
  ].join('\n');
}

function polylineEntity(points: Point[], closed: boolean, linetype: string | null): string {
  const flags = (closed ? DXF_POLYLINE_CLOSED : 0) | (linetype === null ? 0 : DXF_POLYLINE_PATTERN_GENERATED);
  const lines = [
    pair(0, 'POLYLINE'),
    pair(8, DXF_LAYER),
    ...linetypePair(linetype),
    pair(66, 1),
    pair(10, coordinate(0)),
    pair(20, coordinate(0)),
    pair(30, coordinate(0)),
    pair(70, flags),
  ];
  for (const p of points) {
    lines.push(pair(0, 'VERTEX'), pair(8, DXF_LAYER), pair(10, coordinate(p.x)), pair(20, coordinate(p.y)), pair(30, coordinate(0)));
  }
  lines.push(pair(0, 'SEQEND'), pair(8, DXF_LAYER));
  return lines.join('\n');
}

/**
 * A TEXT string as the DXF reference stores it: printable ASCII as it is, the code characters escaped, any other character of
 * the Basic Multilingual Plane as `\U+XXXX` (ezdxf lldxf/encoding.py), and a control character or one beyond the plane as `#`.
 */
function dxfTextValue(text: string): string {
  let value = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const escape = TEXT_ESCAPES.get(character);
    if (escape !== undefined) value += escape;
    else if (code >= FIRST_PRINTABLE && code <= LAST_PRINTABLE) value += character;
    else if (isEscapedAsCodePoint(code)) value += `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else value += UNMAPPABLE_CHARACTER;
    if (value.length > DXF_TEXT_MAX_CHARS) {
      throw new ConversionFailedError(`The page cannot be written as DXF: a run of bitmap-font text is longer than the ${DXF_TEXT_MAX_CHARS} characters a TEXT entity holds.`);
    }
  }
  return value;
}

function textEntity(text: PlacedText, pageHeight: number): string {
  const baseline = coordinate(pageHeight - text.baseline);
  return [
    pair(0, 'TEXT'),
    pair(8, DXF_LAYER),
    pair(10, coordinate(text.x)),
    pair(20, baseline),
    pair(30, coordinate(0)),
    pair(40, coordinate(text.height)),
    pair(1, dxfTextValue(text.text)),
    pair(72, DXF_TEXT_FIT),
    pair(11, coordinate(text.x + text.width)),
    pair(21, baseline),
    pair(31, coordinate(0)),
  ].join('\n');
}

/** The STYLE table the TEXT entities name: STANDARD in AutoCAD's default font, as ezdxf writes it for R12. */
function styleTable(): string[] {
  return [
    pair(0, 'TABLE'),
    pair(2, 'STYLE'),
    pair(70, 1),
    pair(0, 'STYLE'),
    pair(2, DXF_TEXT_STYLE),
    pair(70, 0),
    pair(40, coordinate(0)),
    pair(41, coordinate(1)),
    pair(50, coordinate(0)),
    pair(71, 0),
    pair(42, coordinate(DXF_STYLE_LAST_HEIGHT)),
    pair(3, DXF_TEXT_FONT),
    pair(4, ''),
    pair(0, 'ENDTAB'),
  ];
}

/** Runs the reading and placing steps, turning what the page draws and DXF cannot hold into a typed refusal. */
function refusingUnsupported<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof UnsupportedOptionError) {
      throw new ConversionFailedError(`The page cannot be written as DXF: ${error.message.replace(' by metafile encoders', '')}`);
    }
    throw error;
  }
}

function readSvgPage(svg: Buffer, bitmapGlyphs: BitmapGlyphs): ParsedSvgVectorDocument {
  const text = svg.toString('utf-8');
  if (!SVG_ROOT_PATTERN.test(text)) {
    throw new CadGeometryUnavailableError('DXF encoding failed: input is not an SVG document.');
  }
  return refusingUnsupported(() => parseSvgGeometries(text, bitmapGlyphs, 'centre-line'));
}

/** The page geometry of an SVG document as DXF text; fails closed when the page draws no vector geometry or a bitmap glyph. */
export function encodeSvgPageToDxf(svg: Buffer): Buffer {
  return writeDxf(readSvgPage(svg, new BitmapGlyphs()), []);
}

/**
 * The page geometry of an SVG page that Poppler drew from a PDF page, with its bitmap-font characters as TEXT from the page's
 * text layer; `readText` is called only for a page that draws such characters.
 */
export async function encodeSvgPageToDxfWithText(svg: Buffer, readText: () => Promise<PdfPageText>): Promise<Buffer> {
  const bitmapGlyphs = new BitmapGlyphs(true);
  const parsed = readSvgPage(svg, bitmapGlyphs);
  if (bitmapGlyphs.marks.length === 0) return writeDxf(parsed, []);
  const page = await readText();
  return writeDxf(parsed, refusingUnsupported(() => finitePlacements(placeBitmapGlyphText(bitmapGlyphs.marks, page, parsed.width, parsed.height))));
}

/** The placed texts, refused when one has a position or size that is not a finite number (a Type 3 font of zero widths gives a run of infinite width). */
function finitePlacements(texts: readonly PlacedText[]): readonly PlacedText[] {
  if (!texts.every((text) => [text.x, text.baseline, text.width, text.height].every(Number.isFinite))) {
    throw new UnsupportedOptionError('bitmap-font text with a position or size that is not a finite number is not supported.');
  }
  return texts;
}

/** The dash line types of a document: one LTYPE per distinct pattern, named in order of first use (ezdxf entities/ltype.py writes an R12 LTYPE as groups 2, 70, 3, 72, 73, 40 and one 49 per element). */
class DashLinetypes {
  private readonly names = new Map<string, string>();
  readonly definitions: string[] = [];

  /** The name of the line type that draws `pattern` (dash and gap lengths in turn), or null when its length is too small for the written precision to hold. */
  nameOf(pattern: readonly number[]): string | null {
    const lengths = pattern.map((length) => Number(coordinate(length)));
    if (lengths.reduce((total, length) => total + length, 0) === 0) return null;
    const elements = lengths.map((length, index) => coordinate(index % 2 === 0 ? length : -length));
    const key = elements.join(' ');
    const known = this.names.get(key);
    if (known !== undefined) return known;
    if (this.names.size >= MAX_DASH_LINETYPES) {
      throw new ConversionFailedError(`The page cannot be written as DXF: it draws more than ${MAX_DASH_LINETYPES} different dash patterns.`);
    }
    const name = `${DXF_DASH_LINETYPE_PREFIX}${this.names.size + 1}`;
    this.names.set(key, name);
    this.definitions.push(
      [
        pair(0, 'LTYPE'),
        pair(2, name),
        pair(70, 0),
        pair(3, DXF_DASH_DESCRIPTION),
        pair(72, 65),
        pair(73, elements.length),
        pair(40, coordinate(lengths.reduce((total, length) => total + length, 0))),
        ...elements.map((element) => pair(49, element)),
      ].join('\n')
    );
    return name;
  }
}

function writeDxf(parsed: ParsedSvgVectorDocument, texts: readonly PlacedText[]): Buffer {
  const entities: string[] = [];
  const dashes = new DashLinetypes();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of parsed.elements) {
    for (const subpath of element.subpaths) {
      // Device space has Y pointing down; DXF has it pointing up.
      const points = subpath.map((p) => ({ x: p.x, y: parsed.height - p.y }));
      if (points.length < 2) continue;
      const closed = points.length > 2 && samePoint(points[0], points[points.length - 1]);
      const vertices = closed ? points.slice(0, -1) : points;
      for (const p of vertices) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      const linetype = element.strokeDash ? dashes.nameOf(element.strokeDash) : null;
      entities.push(vertices.length === 2 && !closed ? lineEntity(vertices[0], vertices[1], linetype) : polylineEntity(vertices, closed, linetype));
    }
  }
  for (const text of texts) {
    const baseline = parsed.height - text.baseline;
    minX = Math.min(minX, text.x);
    minY = Math.min(minY, baseline);
    maxX = Math.max(maxX, text.x + text.width);
    maxY = Math.max(maxY, baseline + text.height);
    entities.push(textEntity(text, parsed.height));
  }
  if (entities.length === 0) {
    throw new ConversionFailedError('The page draws no vector geometry, so there is nothing to write as DXF.');
  }

  const sections = [
    [
      pair(0, 'SECTION'),
      pair(2, 'HEADER'),
      pair(9, '$ACADVER'),
      pair(1, DXF_VERSION),
      pair(9, '$EXTMIN'),
      pair(10, coordinate(minX)),
      pair(20, coordinate(minY)),
      pair(30, coordinate(0)),
      pair(9, '$EXTMAX'),
      pair(10, coordinate(maxX)),
      pair(20, coordinate(maxY)),
      pair(30, coordinate(0)),
      pair(0, 'ENDSEC'),
    ],
    [
      pair(0, 'SECTION'),
      pair(2, 'TABLES'),
      pair(0, 'TABLE'),
      pair(2, 'LTYPE'),
      pair(70, 1 + dashes.definitions.length),
      pair(0, 'LTYPE'),
      pair(2, DXF_LINETYPE),
      pair(70, 0),
      pair(3, 'Solid line'),
      pair(72, 65),
      pair(73, 0),
      pair(40, coordinate(0)),
      ...dashes.definitions,
      pair(0, 'ENDTAB'),
      pair(0, 'TABLE'),
      pair(2, 'LAYER'),
      pair(70, 1),
      pair(0, 'LAYER'),
      pair(2, DXF_LAYER),
      pair(70, 0),
      pair(62, DXF_ACI_WHITE),
      pair(6, DXF_LINETYPE),
      pair(0, 'ENDTAB'),
      ...(texts.length > 0 ? styleTable() : []),
      pair(0, 'ENDSEC'),
    ],
    [pair(0, 'SECTION'), pair(2, 'ENTITIES'), ...entities, pair(0, 'ENDSEC')],
    [pair(0, 'EOF')],
  ];
  return Buffer.from(`${sections.map((section) => section.join('\n')).join('\n')}\n`, 'utf-8');
}
