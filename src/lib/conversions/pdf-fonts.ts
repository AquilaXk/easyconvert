import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { ConversionFailedError, EngineUnavailableError, FontCoverageError } from '../types';
import { hasComplexTextScript } from './ctl';
import { resolveBinaryPath } from './pdf-postprocess/utils';
import { ShapingBudget } from './text-shaping/limits';
import { layoutShapedText, type LayoutAlign, type TextLayout } from './text-shaping/paragraph-layout';
import { loadTextShaper } from './text-shaping/shape';
import { ShapedTextDrawer } from './text-shaping/shaped-text-drawer';

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
/** One line per installed face: file, face index, format, colour flag, every family name (comma separated), character set. */
const FONTCONFIG_FORMAT =
  ['%{file}', '%{index}', '%{fontformat}', '%{color}', '%{family}', '%{weight}', '%{slant}', '%{width}', '%{spacing}', '%{charset}'].join(
    FONTCONFIG_FIELD_SEPARATOR
  ) + '\n';
/** fontconfig separates the several names of one family with commas. */
const FONTCONFIG_FAMILY_SEPARATOR = ',';
/** Style names of the upright regular face of a family. */
const REGULAR_STYLE = /^(?:regular|normal|book|roman)$/i;
const FONTCONFIG_FIELD_COUNT = 10;
/** fontconfig's weight, width and spacing values of an upright, regular-weight, normal-width, proportional face. */
const FONTCONFIG_REGULAR_WEIGHT = 80;
const FONTCONFIG_NORMAL_WIDTH = 100;
/** Family names of faces that are poor defaults: serif and looped designs, user-interface cuts. */
const LESS_NEUTRAL_FAMILY = /serif|looped|\bui\b|display|mono/i;
const SANS_FAMILY = /sans/i;
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
  subfamilyName?: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
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
  /** Every family name of the face, lower-cased. */
  readonly families: readonly string[];
  /** How far this face is from a regular-weight, upright, normal-width, proportional sans design (0 is closest). */
  readonly rank: number;
  /** Number of code points the face covers; script-specific fonts are small. */
  readonly coverage: number;
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

function normalizeFamily(name: string): string {
  return name.trim().toLowerCase();
}

/** Keeps embeddable outline faces that are neither colour nor placeholder-box fonts. */
function parseFontconfigListing(listing: string): IndexedFontFace[] {
  const faces: IndexedFontFace[] = [];
  for (const line of listing.split('\n')) {
    const fields = line.split(FONTCONFIG_FIELD_SEPARATOR);
    if (fields.length !== FONTCONFIG_FIELD_COUNT) continue;
    const [file, index, format, color, family, weight, slant, width, spacing, charset] = fields;
    if (!EMBEDDABLE_FONT_FILE.test(file) || !EMBEDDABLE_FONTCONFIG_FORMATS.has(format)) continue;
    if (color === FONTCONFIG_TRUE || PLACEHOLDER_FONT_FAMILY.test(family)) continue;
    const faceIndex = Number.parseInt(index, DECIMAL_RADIX);
    const ranges = parseCharset(charset);
    faces.push({
      path: file,
      index: Number.isFinite(faceIndex) ? faceIndex : 0,
      ranges,
      families: family.split(FONTCONFIG_FAMILY_SEPARATOR).map(normalizeFamily),
      rank: faceRank(family, weight, slant, width, spacing),
      coverage: countCovered(ranges),
    });
  }
  return faces;
}

function countCovered(ranges: Uint32Array): number {
  let covered = 0;
  for (let i = 0; i < ranges.length; i += 2) covered += ranges[i + 1] - ranges[i] + 1;
  return covered;
}

/** Lower is a more neutral default text face: regular weight, upright, normal width, proportional, sans. */
function faceRank(family: string, weight: string, slant: string, width: string, spacing: string): number {
  const weightGap = Math.abs((Number.parseInt(weight, DECIMAL_RADIX) || FONTCONFIG_REGULAR_WEIGHT) - FONTCONFIG_REGULAR_WEIGHT);
  const widthGap = Math.abs((Number.parseInt(width, DECIMAL_RADIX) || FONTCONFIG_NORMAL_WIDTH) - FONTCONFIG_NORMAL_WIDTH);
  const slanted = (Number.parseInt(slant, DECIMAL_RADIX) || 0) > 0 ? 1 : 0;
  const fixedPitch = spacing.trim() === '' ? 0 : 1;
  const unusual = LESS_NEUTRAL_FAMILY.test(family) && !SANS_FAMILY.test(family) ? 1 : 0;
  return weightGap + widthGap + slanted * 1000 + fixedPitch * 1000 + unusual * 500;
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
      // Most neutral faces first (stable), so the first face covering a character is a regular-weight sans one.
      fontconfigIndex = (faces ?? []).sort((a, b) => a.rank - b.rank);
      fontconfigFailedAt = faces ? null : Date.now();
      // Misses recorded against an earlier listing may now be covered.
      coverageCache.clear();
      scriptFaceCache.clear();
    });
  }
  // The shaping engine loads with the font index, so the synchronous drawing code can shape text that needs it.
  return Promise.all([fontconfigIndexLoad, loadTextShaper()]).then(() => undefined);
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

/** A preferred font: the path of a font file (its first face) or a face already found. */
export type PdfPreferredFont = string | PdfFontFace;

function orderedFaces(customFont?: PdfPreferredFont): PdfFontFace[] {
  ensureWellKnownFaces();
  let custom: PdfFontFace | null = null;
  if (typeof customFont === 'string') custom = customFont ? loadFace(customFont) : null;
  else if (customFont) custom = customFont;
  return custom ? [custom, ...systemFaces.filter((face) => face !== custom)] : [...systemFaces];
}

function faceFor(codePoint: number, customFontPath?: PdfPreferredFont): PdfFontFace | null {
  const preferred = orderedFaces(customFontPath).find((face) => face.font.hasGlyphForCodePoint(codePoint));
  return preferred ?? systemFaceFor(codePoint);
}

/**
 * The installed face of a font family (case-insensitive), preferring its regular style; null when no
 * installed embeddable face has the family name. Awaits the fontconfig listing first.
 */
export async function findFaceByFamily(family: string): Promise<PdfFontFace | null> {
  await loadFontCoverageIndex();
  const wanted = normalizeFamily(family);
  if (wanted === '') return null;
  ensureWellKnownFaces();
  const candidates: PdfFontFace[] = systemFaces.filter((face) => normalizeFamily(face.font.familyName ?? '') === wanted);
  for (const entry of fontconfigIndex ?? []) {
    if (!entry.families.includes(wanted)) continue;
    const face = loadFace(entry.path, entry.index);
    if (face && !candidates.includes(face)) candidates.push(face);
  }
  return candidates.find((face) => REGULAR_STYLE.test(face.font.subfamilyName ?? '')) ?? candidates[0] ?? null;
}

/** Whether the face has a glyph for every code point that needs one in the text. */
export function faceCoversText(face: PdfFontFace, text: string): boolean {
  return glyphCodePoints(toDrawableText(text)).every((cp) => face.font.hasGlyphForCodePoint(cp));
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

/**
 * Invisible characters shaping and bidi reordering act on: zero-width joiners (they control Indic conjuncts and Arabic
 * joining) and the bidi marks and embedding controls. They have no glyph of their own, but removing them would change
 * how their neighbours are shaped or ordered.
 */
const SHAPING_CONTROL_CHARACTER = /[\u200C\u200D\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/** Like toDrawableText, but keeps the invisible characters that shaping and bidi reordering use. */
export function toShapableText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, TAB_STOP_SPACES)
    .replace(NON_RENDERING_CHARACTERS, (ch) => (ch.codePointAt(0) === LINE_FEED || SHAPING_CONTROL_CHARACTER.test(ch) ? ch : ''));
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

function uncoveredError(codePoint: number): EngineUnavailableError | FontCoverageError {
  // Text that needs shaping has no other engine to try, so a missing glyph is a request the fonts cannot serve (400).
  if (hasComplexTextScript(String.fromCodePoint(codePoint))) {
    return new FontCoverageError(
      `No installed font has a glyph for ${formatCodePoint(codePoint)} '${String.fromCodePoint(codePoint)}'; install a font covering this script`,
      codePoint
    );
  }
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
function singleCoveringFace(codePoints: readonly number[], customFontPath?: PdfPreferredFont): PdfFontFace | null {
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
export function splitIntoFontRuns(segments: readonly PdfTextSegment[], customFontPath?: PdfPreferredFont): PdfFontRun[] {
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

/** Faces chosen for a set of code points, by the code points joined; null when no installed font covers them all. */
const scriptFaceCache = new Map<string, PdfFontFace | null>();

/** Families made for one script in the plain sans design ("Noto Sans Devanagari"), not its decorative or UI cuts. */
const SCRIPT_SANS_FAMILY = /^noto sans (?!mono|display|symbols|cjk|math|ui)[a-z]+(?: [a-z]+)?$/;
/** General-purpose sans families that include several scripts. */
const GENERAL_SANS_FAMILY = /^(?:noto sans|dejavu sans|liberation sans|freesans|arimo)$/;
const SCRIPT_FACE_TIER_SCRIPT = 0;
const SCRIPT_FACE_TIER_GENERAL = 1;
const SCRIPT_FACE_TIER_OTHER = 2;

function scriptFaceTier(entry: IndexedFontFace): number {
  if (entry.families.some((family) => SCRIPT_SANS_FAMILY.test(family) && !/\bui\b/.test(family))) return SCRIPT_FACE_TIER_SCRIPT;
  if (entry.families.some((family) => GENERAL_SANS_FAMILY.test(family))) return SCRIPT_FACE_TIER_GENERAL;
  return SCRIPT_FACE_TIER_OTHER;
}

/** Whether `candidate` is a better face for complex-script text than `current`: tier, then neutrality, then size. */
function betterScriptFace(candidate: IndexedFontFace, current: IndexedFontFace): boolean {
  const byTier = scriptFaceTier(candidate) - scriptFaceTier(current);
  if (byTier !== 0) return byTier < 0;
  if (candidate.rank !== current.rank) return candidate.rank < current.rank;
  return candidate.coverage < current.coverage;
}

/**
 * The installed face best suited to text of a complex script: of the faces that cover every code point, the one made
 * for the script in a plain sans design, else a general sans font, else the most neutral remaining design.
 */
function scriptSpecificFace(codePoints: readonly number[]): PdfFontFace | null {
  if (!fontconfigIndex || codePoints.length === 0) return null;
  const key = codePoints.join(',');
  const cached = scriptFaceCache.get(key);
  if (cached !== undefined) return cached;
  let best: IndexedFontFace | null = null;
  for (const entry of fontconfigIndex) {
    if (best && !betterScriptFace(entry, best)) continue;
    if (!codePoints.every((cp) => rangesContain(entry.ranges, cp))) continue;
    best = entry;
  }
  const face = best ? loadFace(best.path, best.index) : null;
  const usable = face && codePoints.every((cp) => face.font.hasGlyphForCodePoint(cp)) ? face : null;
  scriptFaceCache.set(key, usable);
  return usable;
}

/** A stretch of shapable text and the face that draws it. */
export interface PdfFontRange {
  readonly start: number;
  readonly end: number;
  readonly face: PdfFontFace;
}

function needsGlyphToShape(codePoint: number): boolean {
  return needsGlyph(codePoint) && !DEFAULT_IGNORABLE.test(String.fromCodePoint(codePoint));
}

/**
 * Partitions shapable text (see toShapableText) into stretches that one face covers, so that every offset belongs to
 * exactly one range. Invisible characters never need a glyph and join their neighbour's range. Throws
 * ConversionFailedError for code points no font can render and FontCoverageError (400) at the first character no
 * installed font covers.
 */
export function fontRangesForShaping(text: string, customFontPath?: PdfPreferredFont): PdfFontRange[] {
  const needed = glyphCodePoints(text.replace(NON_RENDERING_CHARACTERS, ''));
  const specific = customFontPath === undefined && hasComplexTextScript(text) ? scriptSpecificFace(needed) : null;
  const single = specific ?? singleCoveringFace(needed, customFontPath);
  if (single) return text.length > 0 ? [{ start: 0, end: text.length, face: single }] : [];

  const ranges: PdfFontRange[] = [];
  let current: PdfFontFace | null = null;
  let rangeStart = 0;
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (needsGlyphToShape(cp) && !(current && current.font.hasGlyphForCodePoint(cp))) {
      const face = faceFor(cp, customFontPath);
      if (!face) throw uncoveredError(cp);
      if (current && index > rangeStart) {
        ranges.push({ start: rangeStart, end: index, face: current });
        rangeStart = index;
      }
      current = face;
    }
    index += ch.length;
  }
  if (current) ranges.push({ start: rangeStart, end: text.length, face: current });
  return ranges;
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
  /** Glyphs shaped for this document, against SHAPE_MAX_GLYPHS_PER_DOCUMENT. */
  private readonly shapingBudget = new ShapingBudget();
  private shapedDrawer: ShapedTextDrawer | null = null;

  constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly customFontPath?: PdfPreferredFont
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

  /** Whether some of the text needs shaping and bidi reordering (Arabic, Hebrew, Indic, Thai and other complex scripts). */
  private needsShaping(content: string | readonly PdfTextSegment[]): boolean {
    if (typeof content === 'string') return hasComplexTextScript(content);
    return content.some((segment) => hasComplexTextScript(segment.text));
  }

  private currentFontSize(): number {
    return (this.doc as unknown as { _fontSize: number })._fontSize;
  }

  /** Shapes and breaks the content into lines of at most `width` points (0: one line per paragraph). */
  private shapedLayout(content: string | readonly PdfTextSegment[], width: number, align?: LayoutAlign): TextLayout {
    const primary = orderedFaces(this.customFontPath)[0];
    if (!primary) throw uncoveredError(SPACE);
    const segments = (typeof content === 'string' ? [{ text: content }] : content).map((segment) => ({
      text: toShapableText(segment.text),
      link: segment.link,
    }));
    return layoutShapedText({
      segments,
      fontSize: this.currentFontSize(),
      width,
      align,
      fonts: (text) => fontRangesForShaping(text, this.customFontPath),
      blankLineFace: primary,
      budget: this.shapingBudget,
    });
  }

  private writeShaped(content: string | readonly PdfTextSegment[], options: PdfWriterTextOptions, x?: number, y?: number): void {
    const left = x ?? this.doc.x;
    let top = y ?? this.doc.y;
    const layout = this.shapedLayout(content, this.lineWidth(options, x), options.align as LayoutAlign | undefined);
    const drawer = this.shapedDrawer ?? new ShapedTextDrawer(this.doc, (face) => this.useFace(face));
    this.shapedDrawer = drawer;
    const lineGap = options.lineGap ?? 0;
    for (const line of layout.lines) {
      const height = line.ascent + line.descent + line.gap;
      if (options.lineBreak !== false && top + height > this.doc.page.maxY()) {
        this.doc.addPage();
        top = this.doc.page.margins.top;
      }
      drawer.drawLine(line, left, top, { underline: Boolean(options.underline) });
      top += height + lineGap;
    }
    this.doc.x = left;
    this.doc.y = top;
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
    if (this.needsShaping(content)) {
      this.writeShaped(content, options, x, y);
      return;
    }
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
    if (this.needsShaping(content)) {
      const { lines } = this.shapedLayout(content, 0);
      return {
        width: lines.reduce((widest, line) => Math.max(widest, line.width), 0),
        lineHeight: lines.reduce((tallest, line) => Math.max(tallest, line.ascent + line.descent + line.gap), 0),
      };
    }
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
    if (this.needsShaping(content)) {
      const lineGap = options.lineGap ?? 0;
      const { lines } = this.shapedLayout(content, this.lineWidth(options), options.align as LayoutAlign | undefined);
      return lines.reduce((sum, line) => sum + line.ascent + line.descent + line.gap + lineGap, 0);
    }
    let height = 0;
    for (const run of this.layoutRuns(content, this.lineWidth(options))) {
      this.useFace(run.face);
      height += this.doc.heightOfString(run.text, options);
    }
    return height;
  }
}
