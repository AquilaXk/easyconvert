import type { Buffer as HbBuffer, Font as HbFont } from 'harfbuzzjs';
import { ConversionFailedError, EngineUnavailableError, FontCoverageError } from '../../types';
import type { PdfFontFace } from '../pdf-fonts';
import { COMMON_SCRIPT, type ScriptTag } from './itemize';
import { SHAPE_MAX_CODEPOINTS, SHAPE_MAX_LOADED_FACES, type ShapingBudget } from './limits';

/**
 * OpenType shaping with HarfBuzz compiled to WebAssembly (the harfbuzzjs package). A run of text in one font, one
 * script and one direction becomes glyphs with advances and offsets in font units. Fonts are copied into the engine
 * once and kept in a bounded cache.
 */

type HarfBuzzModule = typeof import('harfbuzzjs');

export interface ShapedGlyph {
  /** Glyph index in the font. */
  readonly id: number;
  /** UTF-16 offset in the shaped text of the first character this glyph stands for. */
  readonly cluster: number;
  readonly advance: number;
  readonly xOffset: number;
  readonly yOffset: number;
}

export interface ShapedRun {
  /** In visual order: left to right on the page, so a right-to-left run lists its last character first. */
  readonly glyphs: ShapedGlyph[];
  readonly unitsPerEm: number;
}

interface LoadedFace {
  readonly font: HbFont;
  readonly unitsPerEm: number;
}

const UNKNOWN_SCRIPT: ScriptTag = 'Zzzz';
const NOTDEF_GLYPH = 0;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

let engine: Promise<HarfBuzzModule | null> | null = null;
let engineModule: HarfBuzzModule | null = null;
let sharedBuffer: HbBuffer | null = null;
/** Loaded faces by PdfFontFace id, least recently used first. */
const loadedFaces = new Map<string, LoadedFace>();

/**
 * Loads the shaping engine once per process. Resolves to false when the WebAssembly module cannot be loaded, so a
 * conversion that never shapes text is not affected; shaping then fails with a typed error at the point of use.
 */
export function loadTextShaper(): Promise<boolean> {
  if (!engine) {
    engine = import('harfbuzzjs').then(
      (module) => {
        engineModule = module;
        return module;
      },
      () => null
    );
  }
  return engine.then((module) => module !== null);
}

/** Whether loadTextShaper() has finished loading the engine. */
export function textShaperReady(): boolean {
  return engineModule !== null;
}

function requireEngine(): HarfBuzzModule {
  if (!engineModule) {
    throw new EngineUnavailableError('harfbuzz', 'the text shaping engine (WebAssembly) could not be loaded, so text that needs shaping cannot be drawn');
  }
  return engineModule;
}

function faceFor(hb: HarfBuzzModule, face: PdfFontFace): LoadedFace {
  const cached = loadedFaces.get(face.id);
  if (cached) {
    loadedFaces.delete(face.id);
    loadedFaces.set(face.id, cached);
    return cached;
  }
  const hbFace = new hb.Face(new hb.Blob(face.data), face.faceIndex);
  const loaded: LoadedFace = { font: new hb.Font(hbFace), unitsPerEm: hbFace.upem };
  loadedFaces.set(face.id, loaded);
  while (loadedFaces.size > SHAPE_MAX_LOADED_FACES) {
    const oldest = loadedFaces.keys().next().value as string;
    loadedFaces.delete(oldest);
  }
  return loaded;
}

function bufferFor(hb: HarfBuzzModule): HbBuffer {
  if (!sharedBuffer) sharedBuffer = new hb.Buffer();
  else sharedBuffer.reset();
  return sharedBuffer;
}

/** The first code point of `text` at UTF-16 offset `offset`. */
function codePointAt(text: string, offset: number): number {
  return text.codePointAt(offset) ?? 0;
}

/**
 * Shapes `text` (at most SHAPE_MAX_CODEPOINTS UTF-16 units) in one font. `level` is the bidi embedding level: an odd
 * level shapes right to left. Counts the glyphs against `budget` (ShapingLimitError, 413, past the document cap) and
 * throws FontCoverageError (400) for a character the font draws as a missing-glyph box.
 */
export function shapeRun(face: PdfFontFace, text: string, level: number, script: ScriptTag, budget: ShapingBudget): ShapedRun {
  if (text.length > SHAPE_MAX_CODEPOINTS) {
    throw new ConversionFailedError(`A run of ${text.length} characters is longer than the ${SHAPE_MAX_CODEPOINTS} one shaping call accepts`);
  }
  const hb = requireEngine();
  const loaded = faceFor(hb, face);
  const buffer = bufferFor(hb);
  buffer.addText(text);
  buffer.setClusterLevel(hb.ClusterLevel.MONOTONE_CHARACTERS);
  if (script === COMMON_SCRIPT || script === UNKNOWN_SCRIPT) buffer.guessSegmentProperties();
  else buffer.setScript(script);
  buffer.setDirection(level % 2 === 1 ? hb.Direction.RTL : hb.Direction.LTR);
  hb.shape(loaded.font, buffer);
  const shaped = buffer.getGlyphInfosAndPositions();
  budget.spend(shaped.length);
  const glyphs: ShapedGlyph[] = [];
  for (const glyph of shaped) {
    if (glyph.codepoint === NOTDEF_GLYPH) {
      const codePoint = codePointAt(text, glyph.cluster);
      if (!IGNORABLE.test(String.fromCodePoint(codePoint))) {
        throw new FontCoverageError(
          `Font '${face.font.familyName ?? face.path}' has no glyph for U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} '${String.fromCodePoint(codePoint)}'`,
          codePoint
        );
      }
    }
    glyphs.push({
      id: glyph.codepoint,
      cluster: glyph.cluster,
      advance: glyph.xAdvance ?? 0,
      xOffset: glyph.xOffset ?? 0,
      yOffset: glyph.yOffset ?? 0,
    });
  }
  return { glyphs, unitsPerEm: loaded.unitsPerEm };
}

/** Releases the faces held by the engine (tests, and processes that are done shaping). */
export function releaseShapingFaces(): void {
  loadedFaces.clear();
}
