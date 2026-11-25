import { BLACK, GlyphColours, ItemColours, parseColour, type Rgb } from './pdf-content-colours';
import { isLightColour, markFillBehindLightText, ShapeCollector, type Paint, type Subpath } from './pdf-content-shapes';
import { hasUnmappedGlyphs, recoverUnmappedGlyphs, type RecoverableFont } from './pdf-glyph-recovery';
import { ImageExtractor, type ImageSource } from './pdf-text-images';
import {
  axialShadingGradient,
  boxDisjointFromClip,
  boxFromList,
  clipBoxOfSubpaths,
  clipRule,
  intersectClip,
  isEmptyClip,
  matrixFromList,
  shadingViewportBox,
  subpathHullBox,
  transformBBoxToClip,
  type ClipBox,
  type RectBox,
  type ShadingRef,
} from './pdf-text-shading';
import {
  PDF_CONTENT_MAX_FONTS,
  PDF_CONTENT_MAX_IMAGES_PER_PAGE,
  PDF_CONTENT_MAX_OPERATORS_PER_PAGE,
  PDF_CONTENT_MAX_RULES_PER_PAGE,
  PDF_CONTENT_MAX_SHAPES_PER_PAGE,
  PDF_CONTENT_MAX_STATE_DEPTH,
  PDF_TEXT_MAX_ITEM_CHARS,
  PDF_TEXT_MAX_CHARS_PER_PAGE,
  PDF_TEXT_MAX_ITEMS_PER_PAGE,
  PdfTextGeometryError,
  type PdfContentFont,
  type PdfContentImage,
  type PdfContentItem,
  type PdfContentRule,
  type PdfContentShape,
  type PdfPageContent,
  visibleGlyphsOf,
} from './pdf-text-types';

/**
 * Positioned text, ruling lines and images of one PDF page, read with pdfjs inside the text worker thread
 * (ISO 32000-2 sections 9.4 and 9.10 define the text model the items follow).
 *
 * Text comes from `getTextContent()`, so fonts' ToUnicode maps, ligatures and /ActualText are pdfjs's: every run
 * is already Unicode, and right-to-left runs are already in logical order. Everything is converted with the page
 * viewport (scale 1), which applies /Rotate and flips y, so coordinates are the page as displayed.
 *
 * Rules and images come from the page's operator list under a current-transformation-matrix walk. They only serve
 * the layout (tables, figures), so a page whose operator list is too large keeps its text and loses them, flagged.
 */

/** pdfjs encodes path data as a flat number array with these opcodes (pdfjs `DrawOPS`). */
const PATH_MOVE_TO = 0;
const PATH_LINE_TO = 1;
const PATH_CURVE_TO = 2;
const PATH_QUADRATIC_TO = 3;
const PATH_CLOSE = 4;
const CURVE_OPERANDS = 6;
const QUADRATIC_OPERANDS = 4;
const POINT_OPERANDS = 2;

/** A baseline this many radians off the horizontal still counts as horizontal (about 1.7 degrees). */
const HORIZONTAL_TOLERANCE_RAD = 0.03;
/** Ruling lines: at most this thick, at least this long, and straight to within this many points. */
const RULE_MAX_THICKNESS = 3;
const RULE_MIN_LENGTH = 4;
const AXIS_TOLERANCE = 0.5;
const TRANSFORM_VALUES = 6;
const MATRIX_IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** Stroked lines of this width or less count as hairlines, drawn at one device pixel by viewers. */
const HAIRLINE_FLOOR = 0.25;
/** Private-use code points the Symbol and Wingdings families give bullets, mapped to what they draw. */
const SYMBOL_BULLETS: ReadonlyMap<number, string> = new Map([
  [0xf0b7, '•'],
  [0xf0a7, '▪'],
  [0xf076, '❖'],
  [0xf0d8, '➢'],
  [0xf0fc, '✓'],
  [0xf0a8, '□'],
  [0xf06e, '■'],
  [0xf09f, '•'],
  [0xf8f4, '\u23aa'],
]);

type Matrix = [number, number, number, number, number, number];

interface Viewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
}

interface TextItemLike {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  /** Set on the items the annotation walk adds (pdf-annotation-text.ts). */
  annotation?: true;
}

interface PageStyle {
  fontFamily?: string;
  vertical?: boolean;
}

interface PageTextContent {
  items: unknown[];
  styles: Record<string, PageStyle>;
}

export interface OperatorListLike {
  fnArray: number[];
  argsArray: unknown[][];
}

/** The slice of a pdfjs page this module reads. */
export interface ContentPage {
  getViewport(options: { scale: number }): Viewport;
  getOperatorList(): Promise<OperatorListLike>;
  commonObjs: { has(id: string): boolean; get(id: string, callback?: (data: unknown) => void): unknown };
  objs: { has(id: string): boolean; get(id: string, callback?: (data: unknown) => void): unknown };
}

/** Per-document table of fonts; items refer to entries by index. */
export class FontTable {
  readonly fonts: PdfContentFont[] = [];
  private readonly byName = new Map<string, number>();

  /** Index for a pdfjs font id, adding it on first sight; -1 once the table is full. */
  indexOf(fontId: string, make: () => PdfContentFont): number {
    const known = this.byName.get(fontId);
    if (known !== undefined) return known;
    if (this.fonts.length >= PDF_CONTENT_MAX_FONTS) return -1;
    const index = this.fonts.length;
    this.fonts.push(make());
    this.byName.set(fontId, index);
    return index;
  }
}

function isTextItem(candidate: unknown): candidate is TextItemLike {
  const item = candidate as Partial<TextItemLike> | null;
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof item.str === 'string' &&
    Array.isArray(item.transform) &&
    item.transform.length === TRANSFORM_VALUES &&
    item.transform.every((value) => Number.isFinite(value)) &&
    typeof item.width === 'number' &&
    Number.isFinite(item.width)
  );
}

const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

/** Maps the private-use bullets of the Symbol and Wingdings families to the characters they draw. */
export function normalizeSymbolBullets(text: string): string {
  let result = text;
  for (const [code, replacement] of SYMBOL_BULLETS) {
    const symbol = String.fromCodePoint(code);
    if (result.includes(symbol)) result = result.split(symbol).join(replacement);
  }
  return result;
}

const BOLD_NAME = /bold|black|heavy|demi|extrabd|semibd|\bbd\b|-bd/i;
const ITALIC_NAME = /italic|oblique|-it\b|\bital\b/i;
const MONO_NAME = /mono|courier|consolas|typewriter|menlo/i;
const SUBSET_TAG = /^[A-Z]{6}\+/;
const TYPE3_FONT = 'Type3';

function describeFont(page: ContentPage, fontId: string, style: PageStyle | undefined): PdfContentFont {
  let name = '';
  if (page.commonObjs.has(fontId)) {
    const font = page.commonObjs.get(fontId) as { name?: unknown } | null;
    if (typeof font?.name === 'string') name = font.name.replace(SUBSET_TAG, '');
  }
  const family = style?.fontFamily ?? '';
  return {
    name,
    bold: BOLD_NAME.test(name),
    italic: ITALIC_NAME.test(name),
    monospace: family === 'monospace' || MONO_NAME.test(name),
    serif: family === 'serif',
  };
}

function pageCharactersError(pageNumber: number): PdfTextGeometryError {
  return new PdfTextGeometryError(`PDF page ${pageNumber} has more than ${PDF_TEXT_MAX_CHARS_PER_PAGE} characters of text.`);
}

/** Throws when the page holds more items, or more text, than the limits allow. */
function checkItemLimits(content: PageTextContent, pageNumber: number): void {
  if (content.items.length > PDF_TEXT_MAX_ITEMS_PER_PAGE) {
    throw new PdfTextGeometryError(`PDF page ${pageNumber} has more than ${PDF_TEXT_MAX_ITEMS_PER_PAGE} text items.`);
  }
  let characters = 0;
  for (const item of content.items) {
    if (!isTextItem(item)) continue;
    if (item.str.length > PDF_TEXT_MAX_ITEM_CHARS) {
      throw new PdfTextGeometryError(`PDF page ${pageNumber} has a text item longer than ${PDF_TEXT_MAX_ITEM_CHARS} characters.`);
    }
    characters += item.str.length;
    if (characters > PDF_TEXT_MAX_CHARS_PER_PAGE) {
      throw pageCharactersError(pageNumber);
    }
  }
}

interface ItemGeometry {
  x: number;
  baseline: number;
  width: number;
  angled: boolean;
}

function geometryOf(item: TextItemLike, viewport: Viewport, vertical: boolean): ItemGeometry {
  const [a, b, , , e, f] = item.transform;
  const scale = Math.hypot(a, b) || 1;
  const [x0, y0] = viewport.convertToViewportPoint(e, f);
  const [x1, y1] = viewport.convertToViewportPoint(e + (item.width * a) / scale, f + (item.width * b) / scale);
  if (vertical) {
    // A vertical run advances downwards from its origin; its glyph cells are centred on the origin.
    return { x: x0, baseline: Math.min(y0, y1), width: Math.abs(y1 - y0), angled: false };
  }
  const angled = Math.abs(Math.atan2(y1 - y0, x1 - x0)) > HORIZONTAL_TOLERANCE_RAD && Math.hypot(x1 - x0, y1 - y0) > 0;
  return { x: Math.min(x0, x1), baseline: y0, width: Math.hypot(x1 - x0, y1 - y0), angled };
}

/** The font pdfjs resolved for a font id; it is there once the operator list has been read (pdfjs resolves fonts while it runs). */
function resolvedFont(page: ContentPage, fontId: string): RecoverableFont | null {
  return page.commonObjs.has(fontId) ? (page.commonObjs.get(fontId) as RecoverableFont | null) : null;
}

/**
 * The items of the page. The glyphs of an item that no Unicode value was found for are read from the names of the font's
 * encoding where they have one and left out (or written as `unmappedMark`) otherwise; `content.items` gets the same text, so
 * the word geometry and the density analysis that read it afterwards see no glyph that is not text.
 */
function textItemsOf(
  page: ContentPage,
  content: PageTextContent,
  viewport: Viewport,
  fonts: FontTable,
  pageNumber: number,
  reading: { unmappedMark: string; colours: ItemColours | null }
): { items: PdfContentItem[]; unmapped: number; unmappedType3: number } {
  const { unmappedMark, colours } = reading;
  checkItemLimits(content, pageNumber);
  const items: PdfContentItem[] = [];
  let unmapped = 0;
  let unmappedType3 = 0;
  // The font of each item, for the pass over a page that is mostly unmapped.
  const itemFonts: string[] = [];
  // A ligature name makes a glyph several characters long, so the page limit is read again over the recovered text.
  let characters = 0;
  for (const candidate of content.items) {
    if (!isTextItem(candidate) || candidate.str.length === 0) continue;
    const style = content.styles[candidate.fontName];
    const vertical = style?.vertical === true || candidate.dir === 'ttb';
    const geometry = geometryOf(candidate, viewport, vertical);
    let text = normalizeSymbolBullets(candidate.str);
    if (hasUnmappedGlyphs(text)) {
      const font = resolvedFont(page, candidate.fontName);
      const recovered = recoverUnmappedGlyphs(text, font, PDF_TEXT_MAX_CHARS_PER_PAGE - characters, unmappedMark);
      text = recovered.text;
      unmapped += recovered.unmapped;
      if (font?.type === TYPE3_FONT) unmappedType3 += recovered.unmapped;
    }
    characters += text.length;
    if (characters > PDF_TEXT_MAX_CHARS_PER_PAGE) {
      throw pageCharactersError(pageNumber);
    }
    candidate.str = text;
    if (text.length === 0) continue;
    const [a, b] = candidate.transform;
    const colors = candidate.annotation === true ? undefined : colours?.of(text);
    items.push({
      text,
      x: geometry.x,
      baseline: geometry.baseline,
      width: geometry.width,
      size: Math.hypot(a, b),
      font: fonts.indexOf(candidate.fontName, () => describeFont(page, candidate.fontName, style)),
      rtl: candidate.dir === 'rtl' || RTL_LETTER.test(text),
      angled: geometry.angled,
      vertical,
      ...(candidate.annotation === true ? { annotation: true } : {}),
      ...(colors ? { colors } : {}),
    });
    itemFonts.push(candidate.fontName);
  }
  if (unmapped > 0 && unmapped > visibleGlyphsOf(items)) markType3Items(page, items, itemFonts);
  return { items, unmapped, unmappedType3 };
}

/**
 * Marks the items set in Type 3 fonts, on a page where glyphs without a Unicode value outnumber the others and a reader may
 * keep the text of the other fonts (pdf-text-document.ts). `itemFonts[i]` is the font of `items[i]`.
 */
function markType3Items(page: ContentPage, items: PdfContentItem[], itemFonts: readonly string[]): void {
  const isType3 = new Map<string, boolean>();
  items.forEach((item, index) => {
    const name = itemFonts[index];
    if (!isType3.has(name)) isType3.set(name, resolvedFont(page, name)?.type === TYPE3_FONT);
    if (isType3.get(name) === true) item.type3Font = true;
  });
}

// ---------------------------------------------------------------------------------------------
// Operator list: rules and images
// ---------------------------------------------------------------------------------------------

function multiply(m: Matrix, n: Matrix): Matrix {
  // m is applied first, then n (PDF concatenation: a new transform goes in front of the current matrix).
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

interface Point {
  x: number;
  y: number;
}

/** Whether the value is a flat list of numbers (an array or a typed array). */
function isNumberList(data: unknown): data is ArrayLike<number> {
  if (data === null || typeof data !== 'object') return false;
  const candidate = data as ArrayLike<unknown>;
  return typeof candidate.length === 'number' && (candidate.length === 0 || typeof candidate[0] === 'number');
}

/** The path arrays of a `constructPath` operand: pdfjs wraps them in a list, each one a typed array of path data. */
function pathArrays(operand: unknown): ArrayLike<number>[] {
  if (isNumberList(operand)) return [operand];
  if (!Array.isArray(operand)) return [];
  return operand.filter(isNumberList);
}

/**
 * Subpaths (lists of points, with a closed flag) of a pdfjs path array; curves are reduced to their end points. With `keepSegments`
 * each subpath also keeps its segments as pdf.js encodes them, for the shapes of the page.
 */
function subpathsOf(data: ArrayLike<number>, limit: number, keepSegments: boolean): Subpath[] {
  const subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  let at = 0;
  const readPoint = (offset: number): Point => ({ x: data[at + offset], y: data[at + offset + 1] });
  const keep = (code: number, count: number): void => {
    if (!current?.segments) return;
    current.segments.push(code);
    for (let i = 0; i < count; i++) current.segments.push(data[at + i]);
  };
  while (at < data.length && subpaths.length < limit) {
    const op = data[at++];
    if (op === PATH_MOVE_TO) {
      current = { points: [readPoint(0)], closed: false, ...(keepSegments ? { segments: [] } : {}) };
      subpaths.push(current);
      keep(op, POINT_OPERANDS);
      at += POINT_OPERANDS;
    } else if (op === PATH_LINE_TO) {
      current?.points.push(readPoint(0));
      keep(op, POINT_OPERANDS);
      at += POINT_OPERANDS;
    } else if (op === PATH_CURVE_TO) {
      current?.points.push({ x: data[at + CURVE_OPERANDS - 2], y: data[at + CURVE_OPERANDS - 1] });
      keep(op, CURVE_OPERANDS);
      if (current) current.curved = true;
      at += CURVE_OPERANDS;
    } else if (op === PATH_QUADRATIC_TO) {
      current?.points.push({ x: data[at + QUADRATIC_OPERANDS - 2], y: data[at + QUADRATIC_OPERANDS - 1] });
      keep(op, QUADRATIC_OPERANDS);
      if (current) current.curved = true;
      at += QUADRATIC_OPERANDS;
    } else if (op === PATH_CLOSE) {
      if (current) current.closed = true;
      keep(op, 0);
    } else {
      break;
    }
  }
  return subpaths;
}

interface PaintKinds {
  stroke: Set<number>;
  fill: Set<number>;
}

function paintKinds(ops: Record<string, number>): PaintKinds {
  return {
    stroke: new Set([ops.stroke, ops.closeStroke, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]),
    fill: new Set([ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]),
  };
}

interface PageObjectsLike {
  has?(id: string): boolean;
  get?(id: string): unknown;
}

interface GraphicsState {
  ctm: Matrix;
  /** Initial transform of the page or innermost Form XObject (for Pattern Space). */
  baseTransform: Matrix;
  lineWidth: number;
  /** Fill and stroke colour; null when a pattern, shading or transparent colour is in force. */
  fill: Rgb | null;
  stroke: Rgb | null;
  /** Active pattern-space shading fill when `setFillColorN` chose `Shading`, or null. */
  fillShading: ShadingRef | null;
  /** Opacity of fills (`ca` of the graphics state). */
  fillAlpha: number;
  /** Opacity of strokes (`CA` of the graphics state). */
  strokeAlpha: number;
  /** Whether strokes use a non-empty dash pattern (`setDash` / `D`). */
  dashed: boolean;
  /** Explicit transparent fill or stroke colour (`setFillTransparent` / `setStrokeTransparent`). */
  fillTransparent: boolean;
  strokeTransparent: boolean;
  /** Text render mode (`Tr`). */
  textMode: number;
  /** Active clip bounding box in viewport points, or null when unclipped. */
  clip: ClipBox | null;
  /** Nesting depth inside soft-mask definition groups (`beginGroup` with `smask`). */
  smaskDepth: number;
}

/** What a rule is painted with: its colour (left out for black) and, in a job that reads colour, its place in the paint order. */
interface RuleInk {
  color: Rgb | null;
  strokeAlpha?: number;
  dashed?: boolean;
  z?: number;
  inShape?: true;
}

class RuleCollector {
  readonly rules: PdfContentRule[] = [];
  truncated = false;

  constructor(
    private readonly viewport: Viewport,
    private readonly colour: boolean
  ) {}

  private toPage(point: Point, ctm: Matrix): Point {
    const x = ctm[0] * point.x + ctm[2] * point.y + ctm[4];
    const y = ctm[1] * point.x + ctm[3] * point.y + ctm[5];
    const [vx, vy] = this.viewport.convertToViewportPoint(x, y);
    return { x: vx, y: vy };
  }

  clip: ClipBox | null = null;

  pagePoint(point: Point, ctm: Matrix): Point {
    return this.toPage(point, ctm);
  }

  private add(from: Point, to: Point, thickness: number, ink: RuleInk): void {
    if (this.rules.length >= PDF_CONTENT_MAX_RULES_PER_PAGE) {
      this.truncated = true;
      return;
    }
    const horizontal = Math.abs(from.y - to.y) <= AXIS_TOLERANCE;
    const vertical = Math.abs(from.x - to.x) <= AXIS_TOLERANCE;
    if (horizontal === vertical) return;
    if (Math.hypot(to.x - from.x, to.y - from.y) < RULE_MIN_LENGTH) return;
    const x0 = Math.min(from.x, to.x);
    const y0 = Math.min(from.y, to.y);
    const x1 = Math.max(from.x, to.x);
    const y1 = Math.max(from.y, to.y);
    const clipped = this.clip !== null ? clipRule(x0, y0, x1, y1, this.clip, RULE_MIN_LENGTH) : null;
    if (this.clip !== null && clipped === null) return;
    this.rules.push({
      x0: clipped ? clipped[0] : x0,
      y0: clipped ? clipped[1] : y0,
      x1: clipped ? clipped[2] : x1,
      y1: clipped ? clipped[3] : y1,
      thickness,
      ...(this.colour && ink.color !== null && ink.color !== BLACK ? { color: ink.color } : {}),
      ...(this.colour && ink.strokeAlpha !== undefined && ink.strokeAlpha < 1 ? { strokeAlpha: ink.strokeAlpha } : {}),
      ...(this.colour && ink.dashed ? { dashed: true } : {}),
      ...(ink.z === undefined ? {} : { z: ink.z }),
      ...(ink.inShape ? { inShape: true as const } : {}),
    });
  }

  /** Scale of line width and rectangle sides under the matrix and the viewport (which only rotates and flips). */
  private static scaleOf(ctm: Matrix): number {
    return Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
  }

  /** `inShape[i]` tells that subpath `i` is drawn by a shape of its own. */
  stroke(subpaths: Subpath[], state: GraphicsState, z: number | undefined, inShape: readonly boolean[] = []): void {
    const thickness = Math.max(state.lineWidth * RuleCollector.scaleOf(state.ctm), HAIRLINE_FLOOR);
    const strokeAlpha = state.strokeAlpha < 1 ? state.strokeAlpha : undefined;
    subpaths.forEach((subpath, index) => {
      const ink: RuleInk = {
        color: state.stroke,
        ...(strokeAlpha === undefined ? {} : { strokeAlpha }),
        ...(state.dashed ? { dashed: true } : {}),
        z,
        ...(inShape[index] ? { inShape: true as const } : {}),
      };
      const points = subpath.points.map((point) => this.toPage(point, state.ctm));
      for (let i = 1; i < points.length; i++) this.add(points[i - 1], points[i], thickness, ink);
      if (subpath.closed && points.length > 2) this.add(points[points.length - 1], points[0], thickness, ink);
    });
  }

  /** A filled rectangle thin enough to be a line is a rule; larger fills are backgrounds and are ignored. */
  fill(subpaths: Subpath[], state: GraphicsState, z: number | undefined, inShape: readonly boolean[] = []): void {
    if (state.fill !== null && isLightColour(state.fill)) return;
    subpaths.forEach((subpath, index) => {
      const ink: RuleInk = { color: state.fill, z, ...(inShape[index] ? { inShape: true as const } : {}) };
      this.addFilled(subpath, state, ink);
    });
  }

  private addFilled(subpath: Subpath, state: GraphicsState, ink: RuleInk): void {
    if (subpath.points.length < 4 || subpath.points.length > 5) return;
    const points = subpath.points.map((point) => this.toPage(point, state.ctm));
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const thin = Math.min(width, height);
    if (thin > RULE_MAX_THICKNESS || Math.max(width, height) < RULE_MIN_LENGTH) return;
    const centre = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    if (width >= height) {
      this.add({ x: Math.min(...xs), y: centre.y }, { x: Math.max(...xs), y: centre.y }, Math.max(thin, HAIRLINE_FLOOR), ink);
    } else {
      this.add({ x: centre.x, y: Math.min(...ys) }, { x: centre.x, y: Math.max(...ys) }, Math.max(thin, HAIRLINE_FLOOR), ink);
    }
  }
}

interface OperatorScan {
  rules: PdfContentRule[];
  images: PdfContentImage[];
  /** For each image, how the operator list paints it. */
  sources: ImageSource[];
  rulesTruncated: boolean;
  /** In a job that reads colour: the shapes, and the glyphs of the page with their colours. */
  shapes?: PdfContentShape[];
  glyphs?: GlyphColours;
}

function imageBox(viewport: Viewport, ctm: Matrix): { x: number; y: number; width: number; height: number } {
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([u, v]) => viewport.convertToViewportPoint(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]));
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function isAxialShadingIr(ir: unknown): boolean {
  return Array.isArray(ir) && ir[0] === 'RadialAxial' && ir[1] === 'axial';
}

function shadingOperand(args: unknown[] | undefined): ShadingRef | null {
  if (args?.[0] !== 'Shading' || typeof args[1] !== 'string') return null;
  return { objId: args[1], matrix: matrixFromList(args[2]) };
}

function applyGState(entries: unknown, state: GraphicsState): GraphicsState {
  if (!Array.isArray(entries)) return state;
  let next = state;
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const [key, value] = entry;
    if (key === 'ca' && typeof value === 'number' && Number.isFinite(value)) {
      next = { ...next, fillAlpha: Math.min(1, Math.max(0, value)) };
    } else if (key === 'CA' && typeof value === 'number' && Number.isFinite(value)) {
      next = { ...next, strokeAlpha: Math.min(1, Math.max(0, value)) };
    } else if (key === 'LW' && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      next = { ...next, lineWidth: value };
    } else if (key === 'D' && Array.isArray(value)) {
      next = { ...next, dashed: isNumberList(value[0]) && value[0].length > 0 };
    }
  }
  return next;
}

/** The operators that set a colour or dash/opacity graphics state. */
function withColour(fn: number, args: unknown[] | undefined, ops: Record<string, number>, state: GraphicsState, colour: boolean): GraphicsState | null {
  if (fn === ops.setFillRGBColor || fn === ops.setFillGray) {
    return { ...state, fill: parseColour(args?.[0]) ?? state.fill, fillShading: null, fillTransparent: false };
  }
  if (!colour) return null;
  if (fn === ops.setStrokeRGBColor || fn === ops.setStrokeGray) {
    return { ...state, stroke: parseColour(args?.[0]) ?? state.stroke, strokeTransparent: false };
  }
  if (fn === ops.setFillColorN) return { ...state, fill: null, fillShading: shadingOperand(args), fillTransparent: false };
  if (fn === ops.setStrokeColorN) return { ...state, stroke: null, strokeTransparent: false };
  if (fn === ops.setFillTransparent) return { ...state, fill: null, fillShading: null, fillTransparent: true };
  if (fn === ops.setStrokeTransparent) return { ...state, stroke: null, strokeTransparent: true };
  if (fn === ops.setDash) return { ...state, dashed: isNumberList(args?.[0]) && args[0].length > 0 };
  if (fn === ops.setTextRenderingMode && typeof args?.[0] === 'number') return { ...state, textMode: args[0] };
  if (fn === ops.setGState) return applyGState(args?.[0], state);
  return null;
}

interface GroupOperand {
  matrix?: unknown;
  bbox?: unknown;
  smask?: unknown;
  isolated?: boolean;
  knockout?: boolean;
}

function beginGroupState(raw: unknown, state: GraphicsState, collector: RuleCollector): GraphicsState {
  if (raw === null || typeof raw !== 'object') return state;
  const group = raw as GroupOperand;
  let next = state;
  const groupMatrix = matrixFromList(group.matrix);
  const clipBBox = boxFromList(group.bbox);
  if (clipBBox !== null) {
    const clipCtm = groupMatrix !== null ? multiply(groupMatrix, state.ctm) : state.ctm;
    const clipped = transformBBoxToClip(clipBBox, (pt) => collector.pagePoint(pt, clipCtm));
    if (clipped !== null) next = { ...next, clip: intersectClip(next.clip, clipped) };
  }
  if (group.smask || group.isolated || group.knockout) {
    next = { ...next, fillAlpha: 1, strokeAlpha: 1 };
  }
  if (group.smask) {
    next = { ...next, smaskDepth: next.smaskDepth + 1 };
  }
  return next;
}

/** Walks the operator list of a page with the graphics state it keeps (matrix, line width, colours, clip, groups), collecting rules, images and, with colour, shapes and glyph colours. */
class OperatorScanner {
  private readonly kinds: PaintKinds;
  private readonly collector: RuleCollector;
  private readonly shapes: ShapeCollector | null;
  private readonly glyphs: GlyphColours | null;
  private readonly showsText: ReadonlySet<number>;
  private readonly images: PdfContentImage[] = [];
  private readonly sources: ImageSource[] = [];
  private readonly stack: GraphicsState[] = [];
  private overflowDepth = 0;
  private pendingClip = false;
  private state: GraphicsState = {
    ctm: MATRIX_IDENTITY,
    baseTransform: MATRIX_IDENTITY,
    lineWidth: 1,
    fill: BLACK,
    stroke: BLACK,
    fillShading: null,
    fillAlpha: 1,
    strokeAlpha: 1,
    dashed: false,
    fillTransparent: false,
    strokeTransparent: false,
    textMode: 0,
    clip: null,
    smaskDepth: 0,
  };

  constructor(
    private readonly ops: Record<string, number>,
    private readonly viewport: Viewport,
    private readonly colour: boolean,
    private readonly pageObjs: PageObjectsLike | null
  ) {
    this.kinds = paintKinds(ops);
    this.collector = new RuleCollector(viewport, colour);
    this.shapes = colour ? new ShapeCollector(viewport) : null;
    this.glyphs = colour ? new GlyphColours() : null;
    this.showsText = new Set([ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText]);
  }

  private pushState(): void {
    if (this.stack.length < PDF_CONTENT_MAX_STATE_DEPTH) this.stack.push(this.state);
    else this.overflowDepth++;
  }

  private popState(): void {
    this.pendingClip = false;
    if (this.overflowDepth > 0) {
      this.overflowDepth--;
      return;
    }
    this.state = this.stack.pop() ?? this.state;
  }

  private subpathBox(subpath: Subpath): RectBox | null {
    return subpathHullBox(subpath, (pt) => this.collector.pagePoint(pt, this.state.ctm));
  }

  private resolveShading(shading: ShadingRef, box: RectBox) {
    if (!this.pageObjs?.has?.(shading.objId)) return null;
    const ir = this.pageObjs.get?.(shading.objId);
    const patternCtm = shading.matrix ? multiply(shading.matrix, this.state.baseTransform) : this.state.baseTransform;
    return axialShadingGradient(ir, box, (pt) => this.collector.pagePoint(pt, patternCtm), this.state.fillAlpha);
  }

  private applyResolvedShading(shape: PdfContentShape, shading: ShadingRef): boolean {
    const resolved = this.resolveShading(shading, shape);
    if (resolved?.kind === 'gradient') {
      delete shape.fill;
      delete shape.alpha;
      shape.gradient = resolved.gradient;
      return true;
    }
    if (resolved?.kind === 'solid') {
      shape.fill = resolved.color;
      if (resolved.alpha < 1) shape.alpha = resolved.alpha;
      else delete shape.alpha;
      return true;
    }
    if (shape.stroke !== undefined) {
      delete shape.fill;
      delete shape.alpha;
      return true;
    }
    return false;
  }

  private finishShadedShapes(before: number, prevFillMissing: boolean, shading: ShadingRef): void {
    if (!this.shapes) return;
    const list = this.shapes.shapes;
    if (prevFillMissing && before > 0) {
      const prev = list[before - 1];
      if (prev.fill !== undefined && !this.applyResolvedShading(prev, shading)) {
        list.splice(before - 1, 1);
        before--;
      }
    }
    for (let i = list.length - 1; i >= before; i--) {
      const shape = list[i];
      if (shape.fill !== undefined && !this.applyResolvedShading(shape, shading)) {
        list.splice(i, 1);
      }
    }
  }

  private paintSubpaths(subpaths: Subpath[], painted: Paint, place: number, z: number | undefined): void {
    const clip = this.state.clip;
    const visible = clip
      ? subpaths.filter((sp) => {
          const box = this.subpathBox(sp);
          return box !== null && !boxDisjointFromClip(box, clip);
        })
      : subpaths;
    if (visible.length === 0) return;
    const shadingRef = this.colour && painted.fill ? this.state.fillShading : null;
    const shadingIr = shadingRef && this.pageObjs?.has?.(shadingRef.objId) ? this.pageObjs.get?.(shadingRef.objId) : undefined;
    const useShading = isAxialShadingIr(shadingIr);
    const paintState = useShading ? { ...this.state, fill: BLACK, shading: true } : this.state;
    const before = this.shapes?.shapes.length ?? 0;
    const prevFillMissing = Boolean(
      this.shapes && before > 0 && this.shapes.shapes[before - 1].fill === undefined && this.shapes.shapes[before - 1].gradient === undefined
    );
    const drawn = this.shapes?.paint(visible, painted, paintState, place);
    if (useShading && shadingRef) this.finishShadedShapes(before, prevFillMissing, shadingRef);
    this.collector.clip = this.state.clip;
    if (painted.stroke) this.collector.stroke(visible, this.state, z, drawn?.stroke);
    if (painted.fill && !useShading) this.collector.fill(visible, this.state, z, drawn?.fill);
  }

  /** A painted path: its shapes and the rules its subpaths make. `place` is the operator's place in the paint order. */
  private path(args: unknown[] | undefined, place: number): void {
    const paint = args?.[0];
    const clipTarget = this.pendingClip;
    this.pendingClip = false;
    if (typeof paint !== 'number') return;
    const arrays = pathArrays(args?.[1]);
    const canPaint = this.state.smaskDepth === 0 && !isEmptyClip(this.state.clip);
    const fillAllowed = canPaint && this.kinds.fill.has(paint) && (!this.colour || (!this.state.fillTransparent && this.state.fillAlpha > 0));
    const strokeAllowed = canPaint && this.kinds.stroke.has(paint) && (!this.colour || (!this.state.strokeTransparent && this.state.strokeAlpha > 0));
    const z = this.colour ? place : undefined;
    const clippedSubpaths: Subpath[] | null = clipTarget ? [] : null;
    for (const data of arrays) {
      const subpaths = subpathsOf(data, PDF_CONTENT_MAX_RULES_PER_PAGE, this.colour || clipTarget);
      if (fillAllowed || strokeAllowed) this.paintSubpaths(subpaths, { fill: fillAllowed, stroke: strokeAllowed }, place, z);
      if (clippedSubpaths !== null) for (const sp of subpaths) clippedSubpaths.push(sp);
    }
    if (clippedSubpaths !== null) {
      const nextClip = clipBoxOfSubpaths(clippedSubpaths, (pt) => this.collector.pagePoint(pt, this.state.ctm));
      if (nextClip !== null) this.state = { ...this.state, clip: intersectClip(this.state.clip, nextClip) };
    }
  }

  private shading(args: unknown[] | undefined, place: number): void {
    if (!this.colour || !this.shapes || this.state.smaskDepth > 0 || isEmptyClip(this.state.clip)) return;
    if (this.state.fillAlpha <= 0 || this.shapes.shapes.length >= PDF_CONTENT_MAX_SHAPES_PER_PAGE) return;
    const objId = args?.[0];
    if (typeof objId !== 'string' || !this.pageObjs?.has?.(objId)) return;
    const ir = this.pageObjs.get?.(objId);
    const toPage = (pt: { x: number; y: number }): { x: number; y: number } => this.collector.pagePoint(pt, this.state.ctm);
    const box = shadingViewportBox(ir, this.state.clip, this.viewport.width, this.viewport.height, toPage);
    if (box === null) return;
    const resolved = axialShadingGradient(ir, box, toPage, this.state.fillAlpha);
    if (resolved === null) return;
    this.shapes.shapes.push(
      resolved.kind === 'gradient'
        ? { kind: 'rect', ...box, gradient: resolved.gradient, z: place }
        : { kind: 'rect', ...box, fill: resolved.color, ...(resolved.alpha < 1 ? { alpha: resolved.alpha } : {}), z: place }
    );
  }

  private image(fn: number, args: unknown[] | undefined, place: number): void {
    if (this.state.smaskDepth > 0 || isEmptyClip(this.state.clip)) return;
    if (this.images.length >= PDF_CONTENT_MAX_IMAGES_PER_PAGE) return;
    const named = fn === this.ops.paintImageXObject;
    const target = named ? (args as unknown[]) : [undefined, (args?.[0] as { width?: number })?.width, (args?.[0] as { height?: number })?.height];
    const pixelWidth = target[1];
    const pixelHeight = target[2];
    if (typeof pixelWidth !== 'number' || typeof pixelHeight !== 'number') return;
    const placed = imageBox(this.viewport, this.state.ctm);
    if (boxDisjointFromClip({ x0: placed.x, y0: placed.y, x1: placed.x + placed.width, y1: placed.y + placed.height }, this.state.clip)) return;
    this.images.push({ ...placed, pixelWidth, pixelHeight, ...(this.colour ? { z: place } : {}) });
    this.sources.push(named ? { objId: String(args?.[0]) } : { inline: args?.[0] });
  }

  private apply(fn: number, args: unknown[] | undefined): void {
    const { ops, state } = this;
    if (fn === ops.save) {
      this.pushState();
    } else if (fn === ops.restore) {
      this.popState();
    } else if (fn === ops.transform) {
      const m = matrixFromList(args);
      if (m !== null) this.state = { ...state, ctm: multiply(m, state.ctm) };
    } else if (fn === ops.paintFormXObjectBegin) {
      this.pushState();
      const formMatrix = matrixFromList(args?.[0]);
      const nextCtm = formMatrix !== null ? multiply(formMatrix, state.ctm) : state.ctm;
      let nextClip = state.clip;
      const formBBox = boxFromList(args?.[1]);
      if (formBBox !== null) {
        const clipped = transformBBoxToClip(formBBox, (pt) => this.collector.pagePoint(pt, nextCtm));
        if (clipped !== null) nextClip = intersectClip(nextClip, clipped);
      }
      this.state = { ...state, ctm: nextCtm, baseTransform: nextCtm, clip: nextClip };
      this.pendingClip = false;
    } else if (fn === ops.paintFormXObjectEnd || fn === ops.endGroup) {
      this.popState();
    } else if (fn === ops.beginGroup) {
      this.pushState();
      this.state = beginGroupState(args?.[0], state, this.collector);
      this.pendingClip = false;
    } else if (fn === ops.clip || fn === ops.eoClip) {
      this.pendingClip = true;
    } else if (fn === ops.setLineWidth) {
      const width = args?.[0];
      if (typeof width === 'number' && Number.isFinite(width)) this.state = { ...state, lineWidth: width };
    } else if (this.glyphs && this.showsText.has(fn)) {
      this.glyphs.show(args?.[fn === ops.nextLineSetSpacingShowText ? 2 : 0], state.fill, state.stroke, state.textMode);
    } else {
      this.state = withColour(fn, args, ops, state, this.colour) ?? state;
    }
  }

  scan(list: OperatorListLike): OperatorScan {
    const { ops } = this;
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i];
      const args = list.argsArray[i];
      if (fn === ops.constructPath) this.path(args, i);
      else if (fn === ops.shadingFill) this.shading(args, i);
      else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject) this.image(fn, args, i);
      else this.apply(fn, args);
    }
    return {
      rules: this.collector.rules,
      images: this.images,
      sources: this.sources,
      rulesTruncated: this.collector.truncated,
      ...(this.shapes ? { shapes: this.shapes.shapes } : {}),
      ...(this.glyphs ? { glyphs: this.glyphs } : {}),
    };
  }
}

function scanOperators(list: OperatorListLike, ops: Record<string, number>, viewport: Viewport, colour: boolean, pageObjs: PageObjectsLike | null = null): OperatorScan {
  return new OperatorScanner(ops, viewport, colour, pageObjs).scan(list);
}

/** How one page's content is read: whether its operator list is walked, where its images go, what an unmapped glyph becomes. */
export interface PageContentReading {
  readOperators: boolean;
  imageExtractor: ImageExtractor | null;
  /** The text a glyph without a Unicode value becomes; empty leaves it out. */
  unmappedMark: string;
  /** Also read the colours of the text and the shapes, and the paint order of rules and images. */
  colour?: boolean;
}

/**
 * Reads one page: its positioned text and, when the operator list is affordable, its fonts, ruling lines and images.
 * @throws PdfTextGeometryError when the page exceeds the item or text limits.
 */
export async function readPageContent(
  ops: Record<string, number>,
  page: ContentPage,
  content: PageTextContent,
  pageNumber: number,
  fonts: FontTable,
  { readOperators, imageExtractor, unmappedMark, colour = false }: PageContentReading
): Promise<PdfPageContent> {
  const viewport = page.getViewport({ scale: 1 });
  let scan: OperatorScan = { rules: [], images: [], sources: [], rulesTruncated: false };
  let operatorsSkipped = !readOperators;
  if (readOperators) {
    const list = await page.getOperatorList();
    if (list.fnArray.length > PDF_CONTENT_MAX_OPERATORS_PER_PAGE) operatorsSkipped = true;
    else scan = scanOperators(list, ops, viewport, colour, (page as { objs?: PageObjectsLike }).objs ?? null);
  }
  if (imageExtractor) await imageExtractor.attach(pageNumber - 1, page, scan.images, scan.sources);
  // Fonts are described after the operator list is read: pdfjs resolves their names while it runs.
  const { items, unmapped, unmappedType3 } = textItemsOf(page, content, viewport, fonts, pageNumber, { unmappedMark, colours: scan.glyphs ? new ItemColours(scan.glyphs.glyphs) : null });
  if (scan.shapes) markFillBehindLightText(items, scan.shapes);
  return {
    pageNumber,
    width: viewport.width,
    height: viewport.height,
    items,
    rules: scan.rules,
    images: scan.images,
    ...(scan.shapes ? { shapes: scan.shapes } : {}),
    unmappedGlyphs: unmapped,
    ...(unmappedType3 > 0 ? { unmappedType3Glyphs: unmappedType3 } : {}),
    operatorsSkipped,
    rulesTruncated: scan.rulesTruncated,
  };
}
