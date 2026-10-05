import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EngineUnavailableError } from '../types';

/**
 * Unicode font coverage for the in-process PDF writers (pdfkit).
 *
 * Every text run is drawn with an embedded font that has a real glyph for each of its characters:
 * a run whose characters no installed font covers fails with EngineUnavailableError instead of
 * being drawn as empty boxes or with glyphs from the wrong script.
 */

/** Engine name reported when no installed font covers some characters of the text. */
export const UNICODE_FONT_ENGINE = 'unicode-font';

/**
 * Well-known font files, in preference order: Latin/Greek/Cyrillic fonts first so Latin text keeps
 * Latin typography, then fonts covering Hangul, Kana and Han. Fonts found through fontconfig are
 * appended after these when a character is still uncovered.
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

const FONTCONFIG_LIST_BINARY = 'fc-list';
const FONTCONFIG_TIMEOUT_MS = 5000;
const FONTCONFIG_FIELD_SEPARATOR = '|';
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;
const UNCOVERED_PREVIEW_LIMIT = 8;
const CODE_POINT_HEX_WIDTH = 4;

const LINE_FEED = 0x0a;
const TAB_STOP_SPACES = '    ';
/** Invisible characters with no glyph of their own: controls other than line feed, and default ignorables. */
const NON_RENDERING_CHARACTERS = /[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu;

/** Minimal surface of the fontkit font objects that pdfkit itself uses. */
interface FontkitFace {
  postscriptName: string | null;
  familyName?: string;
  directory: { tables: Record<string, unknown> };
  hasGlyphForCodePoint(codePoint: number): boolean;
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

let faceCounter = 0;
/** Faces by `path#index`; null marks a file or face that cannot be embedded. */
const faceCache = new Map<string, PdfFontFace | null>();
/** Faces that cover text, in preference order: well-known files first, then fontconfig discoveries. */
const systemFaces: PdfFontFace[] = [];
let wellKnownFacesLoaded = false;
/** Code points already looked up through fontconfig. */
const fontconfigProbed = new Set<number>();

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
          face = { id: `UnicodeFont${faceCounter}`, path: filePath, collectionFace, data, font };
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

/** Asks fontconfig for installed fonts covering a code point; returns [] when fc-list is unavailable. */
function fontconfigCandidates(codePoint: number): Array<{ path: string; index: number }> {
  let listing: string;
  try {
    listing = execFileSync(
      FONTCONFIG_LIST_BINARY,
      ['--format', `%{file}${FONTCONFIG_FIELD_SEPARATOR}%{index}\\n`, `:charset=${codePoint.toString(HEX_RADIX)}`],
      { encoding: 'utf-8', timeout: FONTCONFIG_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch {
    return [];
  }
  const candidates: Array<{ path: string; index: number }> = [];
  for (const line of listing.split('\n')) {
    const separator = line.lastIndexOf(FONTCONFIG_FIELD_SEPARATOR);
    if (separator <= 0) continue;
    const index = Number.parseInt(line.slice(separator + 1), DECIMAL_RADIX);
    candidates.push({ path: line.slice(0, separator), index: Number.isFinite(index) ? index : 0 });
  }
  return candidates;
}

/** Finds a system face covering the code point, consulting fontconfig once per code point. */
function systemFaceFor(codePoint: number): PdfFontFace | null {
  ensureWellKnownFaces();
  const known = systemFaces.find((face) => face.font.hasGlyphForCodePoint(codePoint));
  if (known) return known;
  if (fontconfigProbed.has(codePoint)) return null;
  fontconfigProbed.add(codePoint);
  for (const candidate of fontconfigCandidates(codePoint)) {
    const face = loadFace(candidate.path, candidate.index);
    if (face && face.font.hasGlyphForCodePoint(codePoint)) {
      if (!systemFaces.includes(face)) systemFaces.push(face);
      return face;
    }
  }
  return null;
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
 * removes invisible characters that have no glyph of their own (controls, BOM, joiners, selectors).
 */
export function toDrawableText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, TAB_STOP_SPACES)
    .replace(NON_RENDERING_CHARACTERS, (ch) => (ch.codePointAt(0) === LINE_FEED ? ch : ''));
}

function needsGlyph(codePoint: number): boolean {
  return codePoint !== LINE_FEED;
}

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(HEX_RADIX).toUpperCase().padStart(CODE_POINT_HEX_WIDTH, '0')}`;
}

function uncoveredError(uncovered: number[]): EngineUnavailableError {
  const preview = uncovered.slice(0, UNCOVERED_PREVIEW_LIMIT).map((cp) => `${formatCodePoint(cp)} '${String.fromCodePoint(cp)}'`);
  const more = uncovered.length > UNCOVERED_PREVIEW_LIMIT ? ` and ${uncovered.length - UNCOVERED_PREVIEW_LIMIT} more` : '';
  return new EngineUnavailableError(
    UNICODE_FONT_ENGINE,
    `No installed font has glyphs for ${preview.join(', ')}${more}; install a font covering these characters (for Chinese, Japanese and Korean text, Noto Sans CJK)`
  );
}

/** Code points of drawable text that need a glyph. */
function glyphCodePoints(text: string): Set<number> {
  const codePoints = new Set<number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (needsGlyph(cp)) codePoints.add(cp);
  }
  return codePoints;
}

/**
 * Throws EngineUnavailableError when some character of the text has no glyph in any installed font.
 */
export function assertFontCoverage(text: string, customFontPath?: string): void {
  const uncovered: number[] = [];
  for (const cp of glyphCodePoints(toDrawableText(text))) {
    if (!faceFor(cp, customFontPath)) uncovered.push(cp);
  }
  if (uncovered.length > 0) throw uncoveredError(uncovered);
}

/** First face, in preference order, that covers every code point; null when no single face does. */
function singleCoveringFace(codePoints: Set<number>, customFontPath?: string): PdfFontFace | null {
  const needed = Array.from(codePoints);
  return orderedFaces(customFontPath).find((face) => needed.every((cp) => face.font.hasGlyphForCodePoint(cp))) ?? null;
}

/**
 * Splits drawable segments into runs, one font per run. A segment whose characters one face
 * covers is a single run; otherwise each character takes the current run's face when it covers
 * the character, else the first face that does. Throws EngineUnavailableError for uncovered
 * characters.
 */
export function splitIntoFontRuns(segments: readonly PdfTextSegment[], customFontPath?: string): PdfFontRun[] {
  const runs: PdfFontRun[] = [];
  const uncovered = new Set<number>();
  for (const segment of segments) {
    const text = toDrawableText(segment.text);
    if (text.length === 0) continue;
    const codePoints = glyphCodePoints(text);
    const single = singleCoveringFace(codePoints, customFontPath);
    if (single) {
      runs.push({ text, face: single, link: segment.link });
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
      if (!face) {
        uncovered.add(cp);
        continue;
      }
      if (current && buffer) runs.push({ text: buffer, face: current, link: segment.link });
      buffer = current ? ch : buffer + ch;
      current = face;
    }
    if (current && buffer) runs.push({ text: buffer, face: current, link: segment.link });
  }
  if (uncovered.size > 0) throw uncoveredError(Array.from(uncovered));
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

  /**
   * Writes text at (x, y) or at the current position, switching fonts between runs. Links are
   * drawn underlined with a link annotation.
   */
  write(content: string | readonly PdfTextSegment[], options: PdfWriterTextOptions = {}, x?: number, y?: number): void {
    const runs = this.runs(content);
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
   * Height the text takes at the given width. Exact for single-font text; for mixed fonts each
   * run is measured on its own lines, which never underestimates.
   */
  heightOf(content: string | readonly PdfTextSegment[], options: PdfWriterTextOptions = {}): number {
    let height = 0;
    for (const run of this.runs(content)) {
      this.useFace(run.face);
      height += this.doc.heightOfString(run.text, options);
    }
    return height;
  }
}
