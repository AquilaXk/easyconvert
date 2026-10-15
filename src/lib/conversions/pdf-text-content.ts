import { ImageExtractor, type ImageSource } from './pdf-text-images';
import {
  PDF_CONTENT_MAX_FONTS,
  PDF_CONTENT_MAX_IMAGES_PER_PAGE,
  PDF_CONTENT_MAX_OPERATORS_PER_PAGE,
  PDF_CONTENT_MAX_RULES_PER_PAGE,
  PDF_CONTENT_MAX_STATE_DEPTH,
  PDF_TEXT_MAX_ITEM_CHARS,
  PDF_TEXT_MAX_CHARS_PER_PAGE,
  PDF_TEXT_MAX_ITEMS_PER_PAGE,
  PdfTextGeometryError,
  type PdfContentFont,
  type PdfContentImage,
  type PdfContentItem,
  type PdfContentRule,
  type PdfPageContent,
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
/** A fill nearly white on every channel is a background, not a rule. */
const NEAR_WHITE = 0xf0;
const HEX_RADIX = 16;
const HEX_COLOR = /^#([0-9a-f]{6})$/i;
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
  commonObjs: { has(id: string): boolean; get(id: string): unknown };
  objs: { has(id: string): boolean; get(id: string): unknown };
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
/** Replacement characters and control codes other than white space: glyphs no Unicode value was found for. */
// eslint-disable-next-line no-control-regex
const UNMAPPED_TEXT = /[�\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

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
      throw new PdfTextGeometryError(`PDF page ${pageNumber} has more than ${PDF_TEXT_MAX_CHARS_PER_PAGE} characters of text.`);
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

function textItemsOf(
  page: ContentPage,
  content: PageTextContent,
  viewport: Viewport,
  fonts: FontTable,
  pageNumber: number
): { items: PdfContentItem[]; unmapped: number } {
  checkItemLimits(content, pageNumber);
  const items: PdfContentItem[] = [];
  let unmapped = 0;
  for (const candidate of content.items) {
    if (!isTextItem(candidate) || candidate.str.length === 0) continue;
    const style = content.styles[candidate.fontName];
    const vertical = style?.vertical === true || candidate.dir === 'ttb';
    const geometry = geometryOf(candidate, viewport, vertical);
    const text = normalizeSymbolBullets(candidate.str);
    if (UNMAPPED_TEXT.test(text)) unmapped++;
    const [a, b] = candidate.transform;
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
    });
  }
  return { items, unmapped };
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

function isMatrix(args: unknown): args is Matrix {
  return Array.isArray(args) && args.length === TRANSFORM_VALUES && args.every((value) => typeof value === 'number' && Number.isFinite(value));
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

/** Subpaths (lists of points, with a closed flag) of a pdfjs path array; curves are reduced to their end points. */
function subpathsOf(data: ArrayLike<number>, limit: number): { points: Point[]; closed: boolean }[] {
  const subpaths: { points: Point[]; closed: boolean }[] = [];
  let current: { points: Point[]; closed: boolean } | null = null;
  let at = 0;
  const readPoint = (offset: number): Point => ({ x: data[at + offset], y: data[at + offset + 1] });
  while (at < data.length && subpaths.length < limit) {
    const op = data[at++];
    if (op === PATH_MOVE_TO) {
      current = { points: [readPoint(0)], closed: false };
      subpaths.push(current);
      at += POINT_OPERANDS;
    } else if (op === PATH_LINE_TO) {
      current?.points.push(readPoint(0));
      at += POINT_OPERANDS;
    } else if (op === PATH_CURVE_TO) {
      current?.points.push({ x: data[at + CURVE_OPERANDS - 2], y: data[at + CURVE_OPERANDS - 1] });
      at += CURVE_OPERANDS;
    } else if (op === PATH_QUADRATIC_TO) {
      current?.points.push({ x: data[at + QUADRATIC_OPERANDS - 2], y: data[at + QUADRATIC_OPERANDS - 1] });
      at += QUADRATIC_OPERANDS;
    } else if (op === PATH_CLOSE) {
      if (current) current.closed = true;
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

interface GraphicsState {
  ctm: Matrix;
  lineWidth: number;
  fillIsWhite: boolean;
}

function isWhite(color: unknown): boolean {
  if (typeof color !== 'string') return false;
  const match = HEX_COLOR.exec(color);
  if (!match) return false;
  const value = Number.parseInt(match[1], HEX_RADIX);
  return ((value >> 16) & 0xff) >= NEAR_WHITE && ((value >> 8) & 0xff) >= NEAR_WHITE && (value & 0xff) >= NEAR_WHITE;
}

class RuleCollector {
  readonly rules: PdfContentRule[] = [];
  truncated = false;

  constructor(private readonly viewport: Viewport) {}

  private toPage(point: Point, ctm: Matrix): Point {
    const x = ctm[0] * point.x + ctm[2] * point.y + ctm[4];
    const y = ctm[1] * point.x + ctm[3] * point.y + ctm[5];
    const [vx, vy] = this.viewport.convertToViewportPoint(x, y);
    return { x: vx, y: vy };
  }

  private add(from: Point, to: Point, thickness: number): void {
    if (this.rules.length >= PDF_CONTENT_MAX_RULES_PER_PAGE) {
      this.truncated = true;
      return;
    }
    const horizontal = Math.abs(from.y - to.y) <= AXIS_TOLERANCE;
    const vertical = Math.abs(from.x - to.x) <= AXIS_TOLERANCE;
    if (horizontal === vertical) return;
    if (Math.hypot(to.x - from.x, to.y - from.y) < RULE_MIN_LENGTH) return;
    this.rules.push({
      x0: Math.min(from.x, to.x),
      y0: Math.min(from.y, to.y),
      x1: Math.max(from.x, to.x),
      y1: Math.max(from.y, to.y),
      thickness,
    });
  }

  /** Scale of line width and rectangle sides under the matrix and the viewport (which only rotates and flips). */
  private static scaleOf(ctm: Matrix): number {
    return Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
  }

  stroke(subpaths: { points: Point[]; closed: boolean }[], state: GraphicsState): void {
    const thickness = Math.max(state.lineWidth * RuleCollector.scaleOf(state.ctm), HAIRLINE_FLOOR);
    for (const subpath of subpaths) {
      const points = subpath.points.map((point) => this.toPage(point, state.ctm));
      for (let i = 1; i < points.length; i++) this.add(points[i - 1], points[i], thickness);
      if (subpath.closed && points.length > 2) this.add(points[points.length - 1], points[0], thickness);
    }
  }

  /** A filled rectangle thin enough to be a line is a rule; larger fills are backgrounds and are ignored. */
  fill(subpaths: { points: Point[]; closed: boolean }[], state: GraphicsState): void {
    if (state.fillIsWhite) return;
    for (const subpath of subpaths) {
      if (subpath.points.length < 4 || subpath.points.length > 5) continue;
      const points = subpath.points.map((point) => this.toPage(point, state.ctm));
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      const thin = Math.min(width, height);
      if (thin > RULE_MAX_THICKNESS || Math.max(width, height) < RULE_MIN_LENGTH) continue;
      const centre = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
      if (width >= height) {
        this.add({ x: Math.min(...xs), y: centre.y }, { x: Math.max(...xs), y: centre.y }, Math.max(thin, HAIRLINE_FLOOR));
      } else {
        this.add({ x: centre.x, y: Math.min(...ys) }, { x: centre.x, y: Math.max(...ys) }, Math.max(thin, HAIRLINE_FLOOR));
      }
    }
  }
}

interface OperatorScan {
  rules: PdfContentRule[];
  images: PdfContentImage[];
  /** For each image, how the operator list paints it. */
  sources: ImageSource[];
  rulesTruncated: boolean;
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

function scanOperators(list: OperatorListLike, ops: Record<string, number>, viewport: Viewport): OperatorScan {
  const kinds = paintKinds(ops);
  const collector = new RuleCollector(viewport);
  const images: PdfContentImage[] = [];
  const sources: ImageSource[] = [];
  const stack: GraphicsState[] = [];
  let state: GraphicsState = { ctm: MATRIX_IDENTITY, lineWidth: 1, fillIsWhite: false };
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === ops.save) {
      if (stack.length < PDF_CONTENT_MAX_STATE_DEPTH) stack.push(state);
    } else if (fn === ops.restore) {
      state = stack.pop() ?? state;
    } else if (fn === ops.transform) {
      if (isMatrix(args)) state = { ...state, ctm: multiply(args, state.ctm) };
    } else if (fn === ops.setLineWidth) {
      const width = args?.[0];
      if (typeof width === 'number' && Number.isFinite(width)) state = { ...state, lineWidth: width };
    } else if (fn === ops.setFillRGBColor || fn === ops.setFillGray) {
      state = { ...state, fillIsWhite: isWhite(args?.[0]) };
    } else if (fn === ops.constructPath) {
      const paint = args?.[0];
      if (typeof paint === 'number') {
        for (const data of pathArrays(args?.[1])) {
          const subpaths = subpathsOf(data, PDF_CONTENT_MAX_RULES_PER_PAGE);
          if (kinds.stroke.has(paint)) collector.stroke(subpaths, state);
          if (kinds.fill.has(paint)) collector.fill(subpaths, state);
        }
      }
    } else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject) {
      if (images.length < PDF_CONTENT_MAX_IMAGES_PER_PAGE) {
        const target = fn === ops.paintImageXObject ? (args as unknown[]) : [undefined, (args?.[0] as { width?: number })?.width, (args?.[0] as { height?: number })?.height];
        const pixelWidth = target[1];
        const pixelHeight = target[2];
        if (typeof pixelWidth === 'number' && typeof pixelHeight === 'number') {
          images.push({ ...imageBox(viewport, state.ctm), pixelWidth, pixelHeight });
          sources.push(fn === ops.paintImageXObject ? { objId: String(args?.[0]) } : { inline: args?.[0] });
        }
      }
    }
  }
  return { rules: collector.rules, images, sources, rulesTruncated: collector.truncated };
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
  readOperators: boolean,
  imageExtractor: ImageExtractor | null
): Promise<PdfPageContent> {
  const viewport = page.getViewport({ scale: 1 });
  let scan: OperatorScan = { rules: [], images: [], sources: [], rulesTruncated: false };
  let operatorsSkipped = !readOperators;
  if (readOperators) {
    const list = await page.getOperatorList();
    if (list.fnArray.length > PDF_CONTENT_MAX_OPERATORS_PER_PAGE) operatorsSkipped = true;
    else scan = scanOperators(list, ops, viewport);
  }
  if (imageExtractor) await imageExtractor.attach(pageNumber - 1, page.objs, scan.images, scan.sources);
  // Fonts are described after the operator list is read: pdfjs resolves their names while it runs.
  const { items, unmapped } = textItemsOf(page, content, viewport, fonts, pageNumber);
  return {
    pageNumber,
    width: viewport.width,
    height: viewport.height,
    items,
    rules: scan.rules,
    images: scan.images,
    unmappedItems: unmapped,
    operatorsSkipped,
    rulesTruncated: scan.rulesTruncated,
  };
}
