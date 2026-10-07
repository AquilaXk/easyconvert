import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { ConversionFailedError, EngineUnavailableError } from '../types';
import { resolveBinaryPath } from './pdf-postprocess/utils';

/**
 * Unicode font coverage for the in-process PDF writers (pdfkit).
 *
 * Every text run is drawn with an embedded font that has a real glyph for each of its characters:
 * a run whose characters no installed font covers fails with EngineUnavailableError instead of
 * being drawn as empty boxes or with glyphs from the wrong script. Code points no font can render
 * (unassigned, private-use, noncharacters) fail with ConversionFailedError.
 *
 * Installed fonts are found through the well-known files below, then through one fontconfig
 * listing per process (loadFontCoverageIndex) that records each font's character set.
 */

/** Engine name reported when no installed font covers some characters of the text. */
export const UNICODE_FONT_ENGINE = 'unicode-font';

/**
 * Well-known font files, in preference order: Latin/Greek/Cyrillic fonts first so Latin text keeps
 * Latin typography, then fonts covering Hangul, Kana and Han. Fonts from the fontconfig index are
 * used after these when a character is still uncovered.
 */
const CANDIDATE_FONT_FILES: readonly string[] = [
  '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/AppleSDGothicNeo.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  'C:\\Windows\\Fonts\\arial.ttf',
  'C:\\Windows\\Fonts\\malgun.ttf',
  'C:\\Windows\\Fonts\\msgothic.ttc',
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\arialuni.ttf',
];

/** Font file extensions pdfkit can embed. */
const EMBEDDABLE_FONT_FILE = /\.(?:ttf|otf|ttc)$/i;
/** pdfkit embeds TrueType (glyf) and CFF outlines; CFF2 and bitmap-only fonts are not embeddable. */
const OUTLINE_TABLES: readonly string[] = ['glyf', 'CFF '];
/** Colour glyph tables: pdfkit embeds only the base outline, which is blank or a placeholder. */
const COLOR_GLYPH_TABLES: readonly string[] = ['CBDT', 'sbix', 'COLR', 'SVG '];
/** Font families that draw a code-point box for characters they do not really support. */
const PLACEHOLDER_FONT_FAMILY = /unifont|last\s*resort/i;

const FONTCONFIG_BINARY_CANDIDATES: readonly string[] = ['/usr/bin/fc-list', '/usr/local/bin/fc-list', '/opt/homebrew/bin/fc-list'];
const FONTCONFIG_TIMEOUT_MS = 10_000;
const FONTCONFIG_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** A failed fontconfig listing (missing, failing or timed-out fc-list) is retried after this long. */
const FONTCONFIG_RETRY_MS = 60_000;
const FONTCONFIG_FIELD_SEPARATOR = '\t';
/** One line per installed face: file, face index, format, colour flag, first family name, character set. */
const FONTCONFIG_FORMAT = ['%{file}', '%{index}', '%{fontformat}', '%{color}', '%{family[0]}', '%{charset}'].join(FONTCONFIG_FIELD_SEPARATOR) + '\n';
const FONTCONFIG_FIELD_COUNT = 6;
/** fontconfig formats pdfkit can embed. */
const EMBEDDABLE_FONTCONFIG_FORMATS: ReadonlySet<string> = new Set(['TrueType', 'CFF']);
const FONTCONFIG_TRUE = 'True';
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;
const CODE_POINT_HEX_WIDTH = 4;

const LINE_FEED = 0x0a;
const SPACE = 0x20;
const TAB_STOP_SPACES = '    ';
/**
 * Tokens (runs without spaces or line breaks) at least this long are measured and broken to the
 * line width before pdfkit sees them: pdfkit re-measures a too-long word once per character it
 * removes, which is quadratic in the token length.
 */
const LONG_TOKEN_CHARS = 64;
/** Points kept free at the end of a pre-broken line, so kerning never pushes it past the width. */
const LINE_FIT_MARGIN = 1;
/** Characters that stay with the preceding character when a token is broken: marks, joiners, selectors. */
const CLUSTER_EXTENDER = /\p{M}|\u200D|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/u;
/** First code point that can extend a cluster (U+0300 COMBINING GRAVE ACCENT). */
const FIRST_CLUSTER_EXTENDER = 0x300;
const ASCII_LIMIT = 0x80;
const SUPPLEMENTARY_PLANE = 0x10000;
/** Variation selectors: kept after their base character when the font maps the sequence. */
const VARIATION_SELECTOR = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
/**
 * Invisible characters with no glyph of their own: controls other than line feed, and default
 * ignorables other than variation selectors. Default-ignorable code points are dropped even when
 * unassigned (for example U+2065 or U+E0000 to U+E0FFF): Unicode requires them to render as
 * nothing, so they are not refused as unrenderable.
 */
const NON_RENDERING_CHARACTERS = /(?![\uFE00-\uFE0F\u{E0100}-\u{E01EF}])[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu;
/** Most combining marks one character may carry; measuring a longer stack is quadratic in its length. */
const MAX_COMBINING_MARKS = 32;
const COMBINING_MARK = /\p{M}/u;
/** Code points no font can render: unassigned (including noncharacters), private-use and lone surrogates. */
const NON_FONTABLE_CODE_POINT = /[\p{Cn}\p{Co}\p{Cs}]/u;

/** Minimal surface of the fontkit font objects that pdfkit itself uses. */
interface FontkitFace {
  postscriptName: string | null;
  familyName?: string;
  unitsPerEm: number;
  directory: { tables: Record<string, unknown> };
  hasGlyphForCodePoint(codePoint: number): boolean;
  /** Shapes the text with the font's default features; advanceWidth is in font units. */
  layout(text: string): { advanceWidth: number; glyphs: { id: number }[] };
  /** fontkit's cmap processor; getVariationSelector resolves format-14 variation sequences. */
  _cmapProcessor?: { getVariationSelector?(codePoint: number, selector: number): number };
}

interface FontkitCollection {
  fonts: FontkitFace[];
}

interface FontkitModule {
  create(buffer: Buffer, postscriptName?: string): FontkitFace | FontkitCollection;
}

// fontkit ships without type declarations; it is the font engine pdfkit depends on.
const fontkit: FontkitModule = require('fontkit');

/** A loaded font face that pdfkit can embed. */
export interface PdfFontFace {
  /** Name the face is registered under in each pdfkit document. */
  readonly id: string;
  readonly path: string;
  /** Face name inside a font collection (.ttc); undefined for single-face files. */
  readonly collectionFace?: string;
  /** Index of the face inside its font file; 0 for single-face files. */
  readonly faceIndex: number;
  readonly data: Buffer;
  readonly font: FontkitFace;
}

/** A piece of text drawn with one font. */
export interface PdfFontRun {
  readonly text: string;
  readonly face: PdfFontFace;
  readonly link?: string;
}

/** A piece of text, optionally a hyperlink. */
export interface PdfTextSegment {
  readonly text: string;
  readonly link?: string;
}

/** An installed face from the fontconfig listing with its character set as sorted [first, last] pairs. */
interface IndexedFontFace {
  readonly path: string;
  readonly index: number;
  readonly ranges: Uint32Array;
}

let faceCounter = 0;
/** Faces by `path#index`; null marks a file or face that cannot be embedded. */
const faceCache = new Map<string, PdfFontFace | null>();
/** Faces that cover text, in preference order: well-known files first, then fontconfig discoveries. */
const systemFaces: PdfFontFace[] = [];
let wellKnownFacesLoaded = false;
/** Installed faces from one fontconfig listing; null until loadFontCoverageIndex has run. */
let fontconfigIndex: readonly IndexedFontFace[] | null = null;
let fontconfigIndexLoad: Promise<void> | null = null;
/** When the last fontconfig listing failed, or null when it succeeded or never ran. */
let fontconfigFailedAt: number | null = null;
/** System face per code point, once the fontconfig index is loaded. */
const coverageCache = new Map<number, PdfFontFace | null>();

function isCollection(value: FontkitFace | FontkitCollection): value is FontkitCollection {
  return Array.isArray((value as FontkitCollection).fonts);
}

function isEmbeddableFace(font: FontkitFace): boolean {
  const tables = font.directory?.tables ?? {};
  if (!OUTLINE_TABLES.some((tag) => tag in tables)) return false;
  if (COLOR_GLYPH_TABLES.some((tag) => tag in tables)) return false;
  const family = `${font.familyName ?? ''} ${font.postscriptName ?? ''}`;
  return !PLACEHOLDER_FONT_FAMILY.test(family);
}

/** Loads one face of a font file, or null when the file is missing, unreadable or not embeddable. */
function loadFace(filePath: string, faceIndex = 0): PdfFontFace | null {
  const key = `${filePath}#${faceIndex}`;
  const cached = faceCache.get(key);
  if (cached !== undefined) return cached;

  let face: PdfFontFace | null = null;
  try {
    if (EMBEDDABLE_FONT_FILE.test(filePath) && fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      const opened = fontkit.create(data);
      const font = isCollection(opened) ? opened.fonts[faceIndex] : opened;
      if (font && isEmbeddableFace(font)) {
        const collectionFace = isCollection(opened) ? font.postscriptName ?? undefined : undefined;
        if (!isCollection(opened) || collectionFace) {
          faceCounter += 1;
          face = { id: `UnicodeFont${faceCounter}`, path: filePath, collectionFace, faceIndex, data, font };
        }
      }
    }
  } catch {
    face = null;
  }
  faceCache.set(key, face);
  return face;
}

function ensureWellKnownFaces(): void {
  if (wellKnownFacesLoaded) return;
  wellKnownFacesLoaded = true;
  for (const filePath of CANDIDATE_FONT_FILES) {
    const face = loadFace(filePath);
    if (face && !systemFaces.includes(face)) systemFaces.push(face);
  }
}

/** Parses fontconfig character-set text ("20-7e a0-17f 2022") into sorted [first, last] pairs. */
function parseCharset(charset: string): Uint32Array {
  const tokens = charset.trim().split(/\s+/).filter((token) => token.length > 0);
  const ranges = new Uint32Array(tokens.length * 2);
  tokens.forEach((token, i) => {
    const dash = token.indexOf('-');
    const first = Number.parseInt(dash < 0 ? token : token.slice(0, dash), HEX_RADIX);
    const last = dash < 0 ? first : Number.parseInt(token.slice(dash + 1), HEX_RADIX);
    ranges[i * 2] = first;
    ranges[i * 2 + 1] = last;
  });
  return ranges;
}

function rangesContain(ranges: Uint32Array, codePoint: number): boolean {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (codePoint < ranges[mid * 2]) high = mid - 1;
    else if (codePoint > ranges[mid * 2 + 1]) low = mid + 1;
    else return true;
  }
  return false;
}

/** Keeps embeddable outline faces that are neither colour nor placeholder-box fonts. */
function parseFontconfigListing(listing: string): IndexedFontFace[] {
  const faces: IndexedFontFace[] = [];
  for (const line of listing.split('\n')) {
    const fields = line.split(FONTCONFIG_FIELD_SEPARATOR);
    if (fields.length !== FONTCONFIG_FIELD_COUNT) continue;
    const [file, index, format, color, family, charset] = fields;
    if (!EMBEDDABLE_FONT_FILE.test(file) || !EMBEDDABLE_FONTCONFIG_FORMATS.has(format)) continue;
    if (color === FONTCONFIG_TRUE || PLACEHOLDER_FONT_FAMILY.test(family)) continue;
    const faceIndex = Number.parseInt(index, DECIMAL_RADIX);
    faces.push({ path: file, index: Number.isFinite(faceIndex) ? faceIndex : 0, ranges: parseCharset(charset) });
  }
  return faces;
}

/** Lists installed fonts with fontconfig; null when fc-list is missing, fails or times out. */
function queryFontconfig(): Promise<IndexedFontFace[] | null> {
  const binary = resolveBinaryPath('FC_LIST_PATH', [...FONTCONFIG_BINARY_CANDIDATES], 'fc-list');
  if (!binary) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      binary,
      ['--format', FONTCONFIG_FORMAT],
      { encoding: 'utf-8', timeout: FONTCONFIG_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: FONTCONFIG_MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => resolve(error ? null : parseFontconfigListing(stdout))
    );
  });
}

/**
 * Loads the fontconfig coverage index: once per process when the listing succeeds, and again at
 * most every FONTCONFIG_RETRY_MS after a failed listing. Concurrent callers share one fc-list run.
 * Writers await it before drawing so that fonts outside the well-known paths are found; while no
 * listing has succeeded only the well-known files count.
 */
export function loadFontCoverageIndex(): Promise<void> {
  const retryDue = fontconfigFailedAt !== null && Date.now() - fontconfigFailedAt >= FONTCONFIG_RETRY_MS;
  if (!fontconfigIndexLoad || retryDue) {
    fontconfigFailedAt = null;
    fontconfigIndexLoad = queryFontconfig().then((faces) => {
      fontconfigIndex = faces ?? [];
      fontconfigFailedAt = faces ? null : Date.now();
      // Misses recorded against an earlier listing may now be covered.
      coverageCache.clear();
    });
  }
  return fontconfigIndexLoad;
}

/** Finds a system face covering the code point: well-known files first, then the fontconfig index. */
function systemFaceFor(codePoint: number): PdfFontFace | null {
  const cached = coverageCache.get(codePoint);
  if (cached !== undefined) return cached;
  ensureWellKnownFaces();
  let found = systemFaces.find((face) => face.font.hasGlyphForCodePoint(codePoint)) ?? null;
  for (const entry of found ? [] : fontconfigIndex ?? []) {
    if (!rangesContain(entry.ranges, codePoint)) continue;
    const face = loadFace(entry.path, entry.index);
    if (face && face.font.hasGlyphForCodePoint(codePoint)) {
      if (!systemFaces.includes(face)) systemFaces.push(face);
      found = face;
      break;
    }
  }
  // Before the index is loaded a miss is not final, so only hits are remembered.
  if (found || fontconfigIndex) coverageCache.set(codePoint, found);
  return found;
}

function orderedFaces(customFontPath?: string): PdfFontFace[] {
  ensureWellKnownFaces();
  const custom = customFontPath ? loadFace(customFontPath) : null;
  return custom ? [custom, ...systemFaces.filter((face) => face !== custom)] : [...systemFaces];
}

function faceFor(codePoint: number, customFontPath?: string): PdfFontFace | null {
  const preferred = orderedFaces(customFontPath).find((face) => face.font.hasGlyphForCodePoint(codePoint));
  return preferred ?? systemFaceFor(codePoint);
}

/**
 * Prepares text for drawing: normalises line breaks, expands tabs (fonts have no tab glyph) and
 * removes invisible characters that have no glyph of their own (controls, BOM, joiners).
 */
export function toDrawableText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, TAB_STOP_SPACES)
    .replace(NON_RENDERING_CHARACTERS, (ch) => (ch.codePointAt(0) === LINE_FEED ? ch : ''));
}

function isVariationSelector(codePoint: number): boolean {
  return VARIATION_SELECTOR.test(String.fromCodePoint(codePoint));
}

function needsGlyph(codePoint: number): boolean {
  return codePoint !== LINE_FEED && !isVariationSelector(codePoint);
}

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(HEX_RADIX).toUpperCase().padStart(CODE_POINT_HEX_WIDTH, '0')}`;
}

/** Throws ConversionFailedError for a code point no font can render. */
function assertFontable(codePoint: number): void {
  if (NON_FONTABLE_CODE_POINT.test(String.fromCodePoint(codePoint))) {
    throw new ConversionFailedError(
      `Text contains ${formatCodePoint(codePoint)}, an unassigned, private-use or noncharacter code point that no font can render`
    );
  }
}

function uncoveredError(codePoint: number): EngineUnavailableError {
  return new EngineUnavailableError(
    UNICODE_FONT_ENGINE,
    `No installed font has a glyph for ${formatCodePoint(codePoint)} '${String.fromCodePoint(codePoint)}'; install a font covering this script (for Chinese, Japanese and Korean text, Noto Sans CJK)`
  );
}

/**
 * Distinct code points of drawable text that need a glyph. Rejects code points no font can render
 * and characters stacked with more than MAX_COMBINING_MARKS combining marks.
 */
function glyphCodePoints(text: string): number[] {
  const codePoints = new Set<number>();
  let stackedMarks = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= FIRST_CLUSTER_EXTENDER && COMBINING_MARK.test(ch)) {
      stackedMarks++;
      if (stackedMarks > MAX_COMBINING_MARKS) {
        throw new ConversionFailedError(
          `Text stacks ${stackedMarks} combining marks on one character; at most ${MAX_COMBINING_MARKS} are supported`
        );
      }
    } else {
      stackedMarks = 0;
    }
    if (needsGlyph(cp)) codePoints.add(cp);
  }
  const distinct = Array.from(codePoints);
  distinct.forEach(assertFontable);
  return distinct;
}

/**
 * Throws ConversionFailedError for code points no font can render and EngineUnavailableError for
 * the first character no installed font covers.
 */
export function assertFontCoverage(text: string, customFontPath?: string): void {
  for (const cp of glyphCodePoints(toDrawableText(text))) {
    if (!faceFor(cp, customFontPath)) throw uncoveredError(cp);
  }
}

/** Code point of the first character no installed font covers, or null when all are covered. */
export function findUncoveredCodePoint(text: string, customFontPath?: string): number | null {
  for (const cp of glyphCodePoints(toDrawableText(text))) {
    if (!faceFor(cp, customFontPath)) return cp;
  }
  return null;
}

/** First face, in preference order, that covers every code point; null when no single face does. */
function singleCoveringFace(codePoints: readonly number[], customFontPath?: string): PdfFontFace | null {
  return orderedFaces(customFontPath).find((face) => codePoints.every((cp) => face.font.hasGlyphForCodePoint(cp))) ?? null;
}

function supportsVariationSequence(face: PdfFontFace, base: number, selector: number): boolean {
  if (face.font.hasGlyphForCodePoint(selector)) return true;
  return (face.font._cmapProcessor?.getVariationSelector?.(base, selector) ?? 0) !== 0;
}

/** Drops variation selectors the run's font cannot apply to the preceding character. */
function withSupportedSelectors(text: string, face: PdfFontFace): string {
  if (!VARIATION_SELECTOR.test(text)) return text;
  let out = '';
  let base = -1;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (!isVariationSelector(cp)) {
      base = cp;
      out += ch;
    } else if (base >= 0 && supportsVariationSequence(face, base, cp)) {
      out += ch;
    }
  }
  return out;
}

function pushRun(runs: PdfFontRun[], text: string, face: PdfFontFace, link: string | undefined): void {
  const kept = withSupportedSelectors(text, face);
  if (kept) runs.push({ text: kept, face, link });
}

/**
 * Splits drawable segments into runs, one font per run. A segment whose characters one face
 * covers is a single run; otherwise each character takes the current run's face when it covers
 * the character, else the first face that does. Throws ConversionFailedError for code points no
 * font can render and EngineUnavailableError at the first character no installed font covers.
 */
export function splitIntoFontRuns(segments: readonly PdfTextSegment[], customFontPath?: string): PdfFontRun[] {
  const runs: PdfFontRun[] = [];
  for (const segment of segments) {
    const text = toDrawableText(segment.text);
    if (text.length === 0) continue;
    const single = singleCoveringFace(glyphCodePoints(text), customFontPath);
    if (single) {
      pushRun(runs, text, single, segment.link);
      continue;
    }
    let current: PdfFontFace | null = null;
    let buffer = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0) as number;
      if (!needsGlyph(cp) || (current && current.font.hasGlyphForCodePoint(cp))) {
        buffer += ch;
        continue;
      }
      const face = faceFor(cp, customFontPath);
      if (!face) throw uncoveredError(cp);
      if (current && buffer) pushRun(runs, buffer, current, segment.link);
      buffer = current ? ch : buffer + ch;
      current = face;
    }
    if (current && buffer) pushRun(runs, buffer, current, segment.link);
  }
  return runs;
}

/** Path of the preferred installed Unicode font, or null when none is installed. */
export function preferredUnicodeFontPath(customFontPath?: string): string | null {
  return orderedFaces(customFontPath)[0]?.path ?? null;
}

/** Text options this writer accepts; `continued` and `link` are managed per run. */
export type PdfWriterTextOptions = Omit<PDFKit.Mixins.TextOptions, 'continued'>;

/**
 * Draws text into one pdfkit document with per-run embedded fonts.
 */
export class PdfUnicodeTextWriter {
  private readonly registered = new Set<string>();

  constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly customFontPath?: string
  ) {}

  /** Selects a face in the document, embedding it on first use. */
  useFace(face: PdfFontFace): void {
    if (!this.registered.has(face.id)) {
      if (face.collectionFace) {
        this.doc.registerFont(face.id, face.data, face.collectionFace);
      } else {
        this.doc.registerFont(face.id, face.data);
      }
      this.registered.add(face.id);
    }
    this.doc.font(face.id);
  }

  /** Selects the preferred face (the one Latin text uses); returns its name, or null when no font is installed. */
  usePrimaryFace(): string | null {
    const primary = orderedFaces(this.customFontPath)[0];
    if (!primary) return null;
    this.useFace(primary);
    return primary.id;
  }

  runs(content: string | readonly PdfTextSegment[]): PdfFontRun[] {
    const segments = typeof content === 'string' ? [{ text: content }] : content;
    return splitIntoFontRuns(segments, this.customFontPath);
  }

  /** Width lines wrap at for these options, or 0 when the text is not wrapped. */
  private lineWidth(options: PdfWriterTextOptions, x?: number): number {
    if (options.lineBreak === false) return 0;
    if (options.width !== undefined) return options.width;
    return this.doc.page.width - (x ?? this.doc.x) - this.doc.page.margins.right;
  }

  /** Index just past the character cluster that starts at `index`. */
  private static clusterEnd(token: string, index: number): number {
    let end = index + ((token.codePointAt(index) as number) >= SUPPLEMENTARY_PLANE ? 2 : 1);
    while (end < token.length) {
      const codePoint = token.codePointAt(end) as number;
      if (codePoint < FIRST_CLUSTER_EXTENDER || !CLUSTER_EXTENDER.test(String.fromCodePoint(codePoint))) break;
      end += codePoint >= SUPPLEMENTARY_PLANE ? 2 : 1;
    }
    return end;
  }

  /**
   * Breaks one long token into line-width pieces, measuring each distinct character cluster once
   * (ASCII through a table) and slicing the token by index, so the work is linear.
   */
  private splitToken(token: string, lineWidth: number, widths: Map<string, number>, asciiWidths: Float64Array): string {
    const limit = lineWidth - LINE_FIT_MARGIN;
    const pieces: string[] = [];
    let lineStart = 0;
    let lineWidthSoFar = 0;
    let index = 0;
    while (index < token.length) {
      const end = PdfUnicodeTextWriter.clusterEnd(token, index);
      const code = token.charCodeAt(index);
      let width: number;
      if (end === index + 1 && code < ASCII_LIMIT) {
        width = asciiWidths[code];
        if (Number.isNaN(width)) {
          width = this.doc.widthOfString(token[index]);
          asciiWidths[code] = width;
        }
      } else {
        const cluster = token.slice(index, end);
        width = widths.get(cluster) ?? this.doc.widthOfString(cluster);
        widths.set(cluster, width);
      }
      if (index > lineStart && lineWidthSoFar + width > limit) {
        pieces.push(token.slice(lineStart, index));
        lineStart = index;
        lineWidthSoFar = 0;
      }
      lineWidthSoFar += width;
      index = end;
    }
    pieces.push(token.slice(lineStart));
    return pieces.join('\n');
  }

  /**
   * Inserts line breaks into tokens wider than the line, in the run's font, so pdfkit wraps every
   * piece without its quadratic character-by-character splitting. Linear in the text length.
   */
  private breakLongTokens(text: string, lineWidth: number): string {
    if (text.length < LONG_TOKEN_CHARS || !(lineWidth > 0)) return text;
    const widths = new Map<string, number>();
    const asciiWidths = new Float64Array(ASCII_LIMIT).fill(Number.NaN);
    let out = '';
    let index = 0;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === LINE_FEED) {
        out += '\n';
        index++;
        continue;
      }
      // A run of spaces or a run of other characters; long runs of either are broken by width.
      const isSpace = code === SPACE;
      let end = index + 1;
      while (end < text.length) {
        const next = text.charCodeAt(end);
        if (next === LINE_FEED || (next === SPACE) !== isSpace) break;
        end++;
      }
      const run = text.slice(index, end);
      out += run.length >= LONG_TOKEN_CHARS ? this.splitToken(run, lineWidth, widths, asciiWidths) : run;
      index = end;
    }
    return out;
  }

  /** Runs with long tokens broken to the line width (each run measured in its own font). */
  private layoutRuns(content: string | readonly PdfTextSegment[], lineWidth: number): PdfFontRun[] {
    return this.runs(content).map((run) => {
      this.useFace(run.face);
      return { ...run, text: this.breakLongTokens(run.text, lineWidth) };
    });
  }

  /**
   * Writes text at (x, y) or at the current position, switching fonts between runs. Links are
   * drawn underlined with a link annotation.
   */
  write(content: string | readonly PdfTextSegment[], options: PdfWriterTextOptions = {}, x?: number, y?: number): void {
    const runs = this.layoutRuns(content, this.lineWidth(options, x));
    runs.forEach((run, index) => {
      this.useFace(run.face);
      const runOptions: PDFKit.Mixins.TextOptions = {
        ...(index === 0 ? options : {}),
        link: run.link ?? null,
        underline: Boolean(run.link) || Boolean(options.underline),
        continued: index < runs.length - 1,
      };
      if (index === 0 && x !== undefined && y !== undefined) {
        this.doc.text(run.text, x, y, runOptions);
      } else {
        this.doc.text(run.text, runOptions);
      }
    });
  }

  /**
   * Width of the widest line (text is not wrapped, only broken at newlines) and the tallest line
   * height among the fonts that draw it, at the document's current font size. Each run is measured
   * in the font that will draw it.
   */
  measure(content: string | readonly PdfTextSegment[]): { width: number; lineHeight: number } {
    let widest = 0;
    let lineWidth = 0;
    let lineHeight = 0;
    for (const run of this.runs(content)) {
      this.useFace(run.face);
      lineHeight = Math.max(lineHeight, this.doc.currentLineHeight(true));
      run.text.split('\n').forEach((line, index) => {
        if (index > 0) {
          widest = Math.max(widest, lineWidth);
          lineWidth = 0;
        }
        lineWidth += this.doc.widthOfString(line);
      });
    }
    return { width: Math.max(widest, lineWidth), lineHeight };
  }

  /**
   * Height the text takes at the given width. Exact for single-font text; for mixed fonts each
   * run is measured on its own lines, which never underestimates.
   */
  heightOf(content: string | readonly PdfTextSegment[], options: PdfWriterTextOptions = {}): number {
    let height = 0;
    for (const run of this.layoutRuns(content, this.lineWidth(options))) {
      this.useFace(run.face);
      height += this.doc.heightOfString(run.text, options);
    }
    return height;
  }
}
