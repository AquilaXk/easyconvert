import { PDF_CONTENT_MAX_OPERATORS_PER_PAGE, PDF_CONTENT_MAX_STATE_DEPTH, PDF_TEXT_MAX_ITEMS_PER_PAGE } from './pdf-text-types';

/**
 * The text that annotation appearance streams draw, read from the page's operator list.
 *
 * pdfjs draws an annotation by adding its appearance stream to the page's operator list between `beginAnnotation` and
 * `endAnnotation` (src/core/annotation.js `Annotation.getOperatorList`, called for every annotation that
 * `mustBeViewed`: not Hidden, not NoView, and for non-widgets not Invisible; it also builds the appearance of a text field
 * the file has none for). Its text API reaches only a text field that has an appearance and FreeText
 * (`hasTextContent`, `Annotation.extractTextContent`), so a push button caption, a choice field, a check mark or a stamp
 * never arrive as text. The operator list has all of them, with glyphs that already carry their Unicode value, so the text
 * state is followed here the way pdfjs follows it for page text (src/core/evaluator.js `getTextContent`: `TextState`,
 * `buildTextContentItem`, `compareWithLastPosition`, `addFakeSpaces`) and the way it draws it (src/display/canvas.js
 * `beginAnnotation`, `showText`). Poppler prints the same annotations: `Page::displaySlice` draws every annotation and
 * `Annot::isVisible` leaves out Hidden and, on screen, NoView (poppler/Page.cc, poppler/Annot.cc).
 *
 * Each text-showing operator becomes one item in the shape of a pdfjs text item, in page user space, so the reader that
 * takes `getTextContent()` items takes these too. They follow the page's own items, in drawing order. Two kinds of run are left out
 * because pdfjs reorders them with a pass it does not expose: runs with right-to-left letters (its bidi pass) and runs of a
 * vertical font.
 */

/** A text item in the shape pdfjs's `getTextContent()` reports (the fields the readers use). */
export interface AnnotationTextItem {
  str: string;
  dir: 'ltr';
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: false;
}

export interface OperatorListLike {
  fnArray: number[];
  argsArray: unknown[][];
}

/** The slice of a pdfjs font the walk reads. */
interface WalkFont {
  fontMatrix?: unknown;
  vertical?: unknown;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const MATRIX_VALUES = 6;
/** Font units per em when the font reports no matrix (every font but Type 3). */
const DEFAULT_FONT_SCALE = 0.001;
const PERCENT = 100;
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
/** src/core/evaluator.js `getTextContent`: a gap wider than this (in em) is a space and one wider than the maximum starts a new item. */
const SPACE_IN_FLOW_MIN_EM = 0.102;
const SPACE_IN_FLOW_MAX_EM = 0.6;
/** A leftward move past this many em starts a new item (`NEGATIVE_SPACE_FACTOR`). */
const NEGATIVE_SPACE_MAX_EM = -0.2;
const GLYPH_UNITS_PER_EM = 1000;

interface TextState {
  ctm: Matrix;
  fontId: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  rise: number;
  leading: number;
  tm: Matrix;
  tlm: Matrix;
}

/** A run of shown text on its way to becoming an item: its text, the matrix at its start, and how far it advanced in text space. */
interface Run {
  text: string;
  transform: Matrix;
  advance: number;
  /** Length of the text-space unit in page units where the run starts. */
  scale: number;
}

interface ShownGlyph {
  unicode: string;
  width: number;
  isSpace?: unknown;
}

/** Everything the walk needs to know about the page's fonts and the text a run may be turned into. */
export interface AnnotationWalk {
  ops: Record<string, number>;
  /** The font pdfjs resolved for an id, or null while it has none. */
  fontOf(fontId: string): WalkFont | null;
  /** pdfjs's `normalizeUnicode`: the form `getTextContent()` reports ligatures and compatibility characters in. */
  normalize(text: string): string;
}

function isMatrix(args: unknown): args is Matrix {
  return Array.isArray(args) && args.length === MATRIX_VALUES && args.every((value) => typeof value === 'number' && Number.isFinite(value));
}

/** `m` applied first, then `n` (the concatenation order of ISO 32000-1 section 8.3.4). */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function translated(x: number, y: number, m: Matrix): Matrix {
  return multiply([1, 0, 0, 1, x, y], m);
}

function isShownGlyph(entry: unknown): entry is ShownGlyph {
  const glyph = entry as Partial<ShownGlyph> | null;
  return typeof glyph === 'object' && glyph !== null && typeof glyph.unicode === 'string' && typeof glyph.width === 'number';
}

function numberAt(args: unknown[] | undefined, index: number): number | undefined {
  const value = args?.[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The scale from glyph units to text-space units: the font's matrix (Type 3 fonts have their own) or a thousandth. */
function glyphScaleOf(font: WalkFont | null): number {
  const matrix = font?.fontMatrix;
  const scale = Array.isArray(matrix) ? matrix[0] : undefined;
  return typeof scale === 'number' && Number.isFinite(scale) && scale !== 0 ? Math.abs(scale) : DEFAULT_FONT_SCALE;
}

class AnnotationReader {
  readonly items: AnnotationTextItem[] = [];
  private state: TextState = AnnotationReader.freshState(IDENTITY);
  private readonly saved: TextState[] = [];
  private inside = false;

  constructor(
    private readonly walk: AnnotationWalk,
    private readonly limit: number
  ) {}

  private static freshState(ctm: Matrix): TextState {
    return { ctm, fontId: '', fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, rise: 0, leading: 0, tm: IDENTITY, tlm: IDENTITY };
  }

  get full(): boolean {
    return this.items.length >= this.limit;
  }

  /** Applies one operator; text-showing operators add items. */
  apply(fn: number, args: unknown[] | undefined): void {
    const { ops } = this.walk;
    if (fn === ops.beginAnnotation) {
      // pdfjs draws an annotation under the box-to-rectangle matrix and then the appearance's own matrix (canvas.js beginAnnotation).
      const placement = args?.[2];
      const own = args?.[3];
      let ctm = IDENTITY;
      if (isMatrix(placement)) ctm = multiply(placement, ctm);
      if (isMatrix(own)) ctm = multiply(own, ctm);
      this.state = AnnotationReader.freshState(ctm);
      this.saved.length = 0;
      this.inside = true;
    } else if (fn === ops.endAnnotation) {
      this.inside = false;
    } else if (this.inside) {
      this.applyInside(fn, args);
    }
  }

  private applyInside(fn: number, args: unknown[] | undefined): void {
    const { ops } = this.walk;
    const state = this.state;
    if (fn === ops.save || fn === ops.paintFormXObjectBegin) {
      if (this.saved.length < PDF_CONTENT_MAX_STATE_DEPTH) this.saved.push({ ...state });
      const matrix = fn === ops.paintFormXObjectBegin ? args?.[0] : undefined;
      if (isMatrix(matrix)) state.ctm = multiply(matrix, state.ctm);
    } else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) {
      this.state = this.saved.pop() ?? state;
    } else if (fn === ops.transform) {
      if (isMatrix(args)) state.ctm = multiply(args, state.ctm);
    } else if (fn === ops.beginText) {
      state.tm = IDENTITY;
      state.tlm = IDENTITY;
    } else if (fn === ops.setFont) {
      const size = numberAt(args, 1);
      if (typeof args?.[0] === 'string' && size !== undefined) {
        state.fontId = args[0];
        state.fontSize = Math.abs(size);
      }
    } else if (fn === ops.setCharSpacing) {
      state.charSpacing = numberAt(args, 0) ?? state.charSpacing;
    } else if (fn === ops.setWordSpacing) {
      state.wordSpacing = numberAt(args, 0) ?? state.wordSpacing;
    } else if (fn === ops.setHScale) {
      const percent = numberAt(args, 0);
      if (percent !== undefined) state.hScale = percent / PERCENT;
    } else if (fn === ops.setTextRise) {
      state.rise = numberAt(args, 0) ?? state.rise;
    } else if (fn === ops.setLeading) {
      state.leading = numberAt(args, 0) ?? state.leading;
    } else {
      this.applyTextPosition(fn, args);
    }
  }

  private applyTextPosition(fn: number, args: unknown[] | undefined): void {
    const { ops } = this.walk;
    const state = this.state;
    if (fn === ops.moveText || fn === ops.setLeadingMoveText) {
      const x = numberAt(args, 0);
      const y = numberAt(args, 1);
      if (x === undefined || y === undefined) return;
      if (fn === ops.setLeadingMoveText) state.leading = -y;
      state.tlm = translated(x, y, state.tlm);
      state.tm = state.tlm;
    } else if (fn === ops.nextLine) {
      this.carriageReturn();
    } else if (fn === ops.setTextMatrix) {
      if (isMatrix(args)) {
        state.tm = args;
        state.tlm = args;
      }
    } else if (fn === ops.showText) {
      this.show(args?.[0]);
    } else if (fn === ops.nextLineShowText) {
      this.carriageReturn();
      this.show(args?.[0]);
    } else if (fn === ops.nextLineSetSpacingShowText) {
      state.wordSpacing = numberAt(args, 0) ?? state.wordSpacing;
      state.charSpacing = numberAt(args, 1) ?? state.charSpacing;
      this.carriageReturn();
      this.show(args?.[2]);
    }
  }

  /** `T*`: the next line starts one leading below the last (src/core/evaluator.js `TextState.carriageReturn`). */
  private carriageReturn(): void {
    const state = this.state;
    state.tlm = translated(0, -state.leading, state.tlm);
    state.tm = state.tlm;
  }

  /** The text rendering matrix: font size, horizontal scale and rise in the text matrix and the current transformation matrix. */
  private renderingMatrix(): Matrix {
    const state = this.state;
    return multiply(multiply([state.fontSize * state.hScale, 0, 0, state.fontSize, 0, state.rise], state.tm), state.ctm);
  }

  /** Reads the glyphs and adjustments of one text-showing operator into items, moving the text matrix along. */
  private show(shown: unknown): void {
    if (!Array.isArray(shown) || this.full) return;
    const state = this.state;
    const font = this.walk.fontOf(state.fontId);
    if (font?.vertical === true) return;
    const glyphScale = glyphScaleOf(font);
    let run: Run | null = null;
    for (const entry of shown) {
      if (typeof entry === 'number') {
        const gap = (-entry / GLYPH_UNITS_PER_EM) * state.fontSize * state.hScale;
        state.tm = translated(gap, 0, state.tm);
        if (run === null) continue;
        const shift = state.fontSize === 0 ? 0 : gap / state.fontSize;
        if (shift < NEGATIVE_SPACE_MAX_EM || shift > SPACE_IN_FLOW_MAX_EM) {
          this.push(run);
          run = null;
        } else {
          run.advance += gap;
          if (shift > SPACE_IN_FLOW_MIN_EM) run.text += ' ';
        }
      } else if (isShownGlyph(entry)) {
        const spacing = state.charSpacing + (entry.isSpace === true ? state.wordSpacing : 0);
        const advance = (entry.width * glyphScale * state.fontSize + spacing) * state.hScale;
        run ??= this.startRun();
        run.text += entry.unicode;
        run.advance += advance;
        state.tm = translated(advance, 0, state.tm);
      }
    }
    if (run !== null) this.push(run);
  }

  private startRun(): Run {
    const state = this.state;
    const toPage = multiply(state.tm, state.ctm);
    return { text: '', transform: this.renderingMatrix(), advance: 0, scale: Math.hypot(toPage[0], toPage[1]) };
  }

  private push(run: Run): void {
    const text = this.walk.normalize(run.text);
    if (this.full || text.trim() === '' || RTL_LETTER.test(text)) return;
    this.items.push({
      str: text,
      dir: 'ltr',
      transform: run.transform,
      width: Math.abs(run.advance) * run.scale,
      height: Math.hypot(run.transform[2], run.transform[3]),
      fontName: this.state.fontId,
      hasEOL: false,
    });
  }
}

/**
 * The text items of the annotations in an operator list, in drawing order, at most `limit` of them (one more than the page
 * may still take, so that the caller's page limit refuses the page instead of this walk allocating without bound).
 */
export function annotationTextItems(list: OperatorListLike, walk: AnnotationWalk, limit: number): AnnotationTextItem[] {
  const reader = new AnnotationReader(walk, limit);
  const count = Math.min(list.fnArray.length, PDF_CONTENT_MAX_OPERATORS_PER_PAGE);
  for (let index = 0; index < count && !reader.full; index++) reader.apply(list.fnArray[index], list.argsArray[index]);
  return reader.items;
}

/** The slice of a pdfjs page that `appendAnnotationText` reads. */
export interface AnnotatedPage {
  getAnnotations(options: { intent: string }): Promise<Array<{ subtype?: unknown }>>;
  getOperatorList(): Promise<OperatorListLike>;
  commonObjs: { has(id: string): boolean; get(id: string): unknown };
}

/** Annotations that never draw text: a link is only a region and a popup is the window of another annotation. */
const SILENT_SUBTYPES: ReadonlySet<unknown> = new Set(['Link', 'Popup']);

/** Whether the page lists an annotation that could draw text; asking costs a round trip to the page, much less than its operator list. */
async function hasDrawingAnnotation(page: AnnotatedPage): Promise<boolean> {
  const annotations = await page.getAnnotations({ intent: 'display' });
  return annotations.some((annotation) => !SILENT_SUBTYPES.has(annotation.subtype));
}

/**
 * Adds the text of the page's annotation appearances to `content.items`, after the page's own items. The caller decides
 * whether the operator list is affordable. A caller that reads the operator list anyway says so (`operatorListIsRead`) and
 * the walk goes straight to it; for any other, a page with no annotation that could draw text reads none.
 */
export async function appendAnnotationText(
  pdfjs: { OPS: Record<string, number>; normalizeUnicode(text: string): string },
  page: AnnotatedPage,
  content: { items: unknown[] },
  { operatorListIsRead }: { operatorListIsRead: boolean }
): Promise<void> {
  if (!operatorListIsRead && !(await hasDrawingAnnotation(page))) return;
  const list = await page.getOperatorList();
  const walk: AnnotationWalk = {
    ops: pdfjs.OPS,
    fontOf: (fontId) => (page.commonObjs.has(fontId) ? (page.commonObjs.get(fontId) as WalkFont | null) : null),
    normalize: (text) => pdfjs.normalizeUnicode(text),
  };
  const room = PDF_TEXT_MAX_ITEMS_PER_PAGE + 1 - content.items.length;
  for (const item of annotationTextItems(list, walk, Math.max(room, 0))) content.items.push(item);
}
