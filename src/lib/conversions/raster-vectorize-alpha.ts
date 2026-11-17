/**
 * Alpha-edge decontamination and near-zero alpha snapping for raster-to-SVG staging.
 *
 * Reference implementations & licences (3-step evaluation: no maintained zero-dep npm package;
 * sharp/libvips `flatten` destroys transparency; ported and bit/word-optimised):
 * 1. `godotengine/godot` (MIT, Copyright (c) 2014-present Godot Engine contributors,
 *    Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur; commit `203bf0a23fd7d90a860917e66de08e20d2596244`,
 *    `core/io/image.cpp:4490-4554`, `Image::fix_alpha_edges()`): `alpha_threshold = 20`, `max_radius = 4`.
 * 2. `visioncortex/vtracer` (MIT OR Apache-2.0, commit `2500df76b5aea0ac22d15296b22722442f825c5b`,
 *    `crates/vtracer/src/frontend/keying.rs:17-42, 97-105`): keys `a == 0` only and clusters `a > 0`
 *    RGB without `fill-opacity`.
 *
 * Low-level optimisations over Godot's `O(W * H * 81)` nested neighbourhood scan + full buffer clone:
 * - 32-bit word (`Uint32Array`) fast-path scan checks 4 bytes per iteration and exits in one pass with
 *   zero allocations for opaque images (`minAlpha === 255`) and uniform-alpha overlays (`minAlpha >= 20`).
 * - Two-pass `O(W * H)` Borgefors 3-4 Chamfer distance transform packs `[dist6 << 24 | r8 << 16 | g8 << 8 | b8]`
 *   into a single 30-bit V8 Smi-safe `Uint32Array(W * H)` so distance comparisons and RGB propagation execute
 *   as scalar integer compares without unpacking or per-pixel allocations.
 */

/** Pixels below this alpha (< 7.8 % opacity) snap to `a = 0`, matching Godot `fix_alpha_edges` (`image.cpp:4505`). */
export const ALPHA_SNAP_THRESHOLD = 20;
const OPAQUE_SEED_ALPHA = 245;
const SEMI_ALPHA_UPPER = 224;

/** 3-4 Chamfer weights (`max_radius = 4` orthogonal steps => `4 * 3 = 12`). */
const ORTHO_STEP = 0x03000000;
const DIAG_STEP = 0x04000000;
const MAX_CHAMFER_DIST = 12;
const LIMIT_BEFORE_ORTHO = ((MAX_CHAMFER_DIST - 3) << 24) | 0x00ffffff;
const LIMIT_BEFORE_DIAG = ((MAX_CHAMFER_DIST - 4) << 24) | 0x00ffffff;
const MAX_CHAMFER_STATE = (MAX_CHAMFER_DIST << 24) | 0x00ffffff;
const UNREACHABLE_STATE = 0x3f000000;

/** Premultiplied-black halo matching bounds (`|c * 255 - opaque_c * a| <= 24 * 255`). */
const MIN_OPAQUE_LUMA = 32;
const MIN_DARKENING_DELTA = 24;
const PREMULT_TOLERANCE_SCALED = 24 * 255;

const IS_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(0x01020304).buffer)[3] === 0x01;
const ALPHA_WORD_MASK = IS_LITTLE_ENDIAN ? 0xff000000 : 0x000000ff;
const ALPHA_WORD_SHIFT = IS_LITTLE_ENDIAN ? 24 : 0;

interface AlphaScanSummary {
  hasTransparent: boolean;
  hasOpaque: boolean;
}

function scanAlignedWords(words: Uint32Array, count: number): AlphaScanSummary {
  let hasTransparent = false;
  let hasOpaque = false;
  let allOpaque = true;
  for (let i = 0; i < count; i++) {
    const word = words[i];
    if ((word & ALPHA_WORD_MASK) === ALPHA_WORD_MASK) {
      hasOpaque = true;
      continue;
    }
    allOpaque = false;
    const a = (word >>> ALPHA_WORD_SHIFT) & 0xff;
    if (a < ALPHA_SNAP_THRESHOLD) hasTransparent = true;
    else if (a >= OPAQUE_SEED_ALPHA) hasOpaque = true;
  }
  return allOpaque ? { hasTransparent: false, hasOpaque: true } : { hasTransparent, hasOpaque };
}

/** Scans RGBA alpha in 32-bit words when 4-byte aligned, exiting fast on opaque inputs. */
function scanAlpha(pixels: Uint8Array, count: number): AlphaScanSummary {
  if ((pixels.byteOffset & 3) === 0) {
    return scanAlignedWords(new Uint32Array(pixels.buffer, pixels.byteOffset, count), count);
  }
  let hasTransparent = false;
  let hasOpaque = false;
  for (let off = 3, end = count * 4; off < end; off += 4) {
    const a = pixels[off];
    if (a < ALPHA_SNAP_THRESHOLD) hasTransparent = true;
    else if (a >= OPAQUE_SEED_ALPHA) hasOpaque = true;
  }
  return { hasTransparent, hasOpaque };
}

function snapAllTransparentDust(pixels: Uint8Array, count: number): void {
  for (let off = 0, end = count * 4; off < end; off += 4) {
    if (pixels[off + 3] < ALPHA_SNAP_THRESHOLD) {
      pixels.fill(0, off, off + 4);
    }
  }
}

function stepCandidate(best: number, neighbourState: number, limit: number, step: number): number {
  if (neighbourState <= limit) {
    const cand = neighbourState + step;
    if (cand < best) return cand;
  }
  return best;
}

function forwardChamferCell(state: Uint32Array, x: number, y: number, width: number, idx: number): number {
  let best = UNREACHABLE_STATE;
  if (x > 0) best = stepCandidate(best, state[idx - 1], LIMIT_BEFORE_ORTHO, ORTHO_STEP);
  if (y > 0) {
    const upIdx = idx - width;
    best = stepCandidate(best, state[upIdx], LIMIT_BEFORE_ORTHO, ORTHO_STEP);
    if (x > 0) best = stepCandidate(best, state[upIdx - 1], LIMIT_BEFORE_DIAG, DIAG_STEP);
    if (x + 1 < width) best = stepCandidate(best, state[upIdx + 1], LIMIT_BEFORE_DIAG, DIAG_STEP);
  }
  return best;
}

function forwardChamferPass(pixels: Uint8Array, state: Uint32Array, width: number, height: number): void {
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x;
      const off = idx * 4;
      if (pixels[off + 3] >= OPAQUE_SEED_ALPHA) {
        state[idx] = (pixels[off] << 16) | (pixels[off + 1] << 8) | pixels[off + 2];
      } else {
        state[idx] = forwardChamferCell(state, x, y, width, idx);
      }
    }
  }
}

function backwardChamferCell(state: Uint32Array, x: number, y: number, width: number, height: number, idx: number): number {
  let best = state[idx];
  if (x + 1 < width) best = stepCandidate(best, state[idx + 1], LIMIT_BEFORE_ORTHO, ORTHO_STEP);
  if (y + 1 < height) {
    const downIdx = idx + width;
    best = stepCandidate(best, state[downIdx], LIMIT_BEFORE_ORTHO, ORTHO_STEP);
    if (x + 1 < width) best = stepCandidate(best, state[downIdx + 1], LIMIT_BEFORE_DIAG, DIAG_STEP);
    if (x > 0) best = stepCandidate(best, state[downIdx - 1], LIMIT_BEFORE_DIAG, DIAG_STEP);
  }
  return best;
}

function hasTransparentNeighbour(pixels: Uint8Array, x: number, y: number, width: number, height: number, idx: number): boolean {
  if (x > 0 && pixels[(idx - 1) * 4 + 3] < ALPHA_SNAP_THRESHOLD) return true;
  if (x + 1 < width && pixels[(idx + 1) * 4 + 3] < ALPHA_SNAP_THRESHOLD) return true;
  if (y > 0 && pixels[(idx - width) * 4 + 3] < ALPHA_SNAP_THRESHOLD) return true;
  return y + 1 < height && pixels[(idx + width) * 4 + 3] < ALPHA_SNAP_THRESHOLD;
}

function isPremultipliedBlackFringe(pixels: Uint8Array, off: number, a: number, packedRgb: number): boolean {
  const nr = (packedRgb >>> 16) & 0xff;
  const ng = (packedRgb >>> 8) & 0xff;
  const nb = packedRgb & 0xff;
  if (Math.max(nr, ng, nb) < MIN_OPAQUE_LUMA) return false;
  const r = pixels[off];
  const g = pixels[off + 1];
  const b = pixels[off + 2];
  if (r > nr + 4 || g > ng + 4 || b > nb + 4) return false;
  if (Math.max(nr - r, ng - g, nb - b) < MIN_DARKENING_DELTA) return false;
  return (
    Math.abs(r * 255 - nr * a) <= PREMULT_TOLERANCE_SCALED &&
    Math.abs(g * 255 - ng * a) <= PREMULT_TOLERANCE_SCALED &&
    Math.abs(b * 255 - nb * a) <= PREMULT_TOLERANCE_SCALED
  );
}

function applyEdgeWriteback(
  pixels: Uint8Array,
  off: number,
  a: number,
  bestState: number,
  bordersTransparency: boolean
): void {
  if (a < ALPHA_SNAP_THRESHOLD) {
    pixels.fill(0, off, off + 4);
    return;
  }
  if (a < SEMI_ALPHA_UPPER && bestState <= MAX_CHAMFER_STATE && bordersTransparency) {
    if (isPremultipliedBlackFringe(pixels, off, a, bestState)) {
      pixels[off] = (bestState >>> 16) & 0xff;
      pixels[off + 1] = (bestState >>> 8) & 0xff;
      pixels[off + 2] = bestState & 0xff;
    }
  }
}

function backwardChamferAndWritebackPass(pixels: Uint8Array, state: Uint32Array, width: number, height: number): void {
  for (let y = height - 1; y >= 0; y--) {
    const rowOffset = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const idx = rowOffset + x;
      const off = idx * 4;
      const a = pixels[off + 3];
      if (a >= OPAQUE_SEED_ALPHA) continue;
      const best = backwardChamferCell(state, x, y, width, height, idx);
      state[idx] = best;
      const bordersTransparency = a >= ALPHA_SNAP_THRESHOLD && hasTransparentNeighbour(pixels, x, y, width, height, idx);
      applyEdgeWriteback(pixels, off, a, best, bordersTransparency);
    }
  }
}

/**
 * Cleans near-zero alpha dust (`a < 20 -> 0`) and uncontaminates premultiplied-black anti-aliased edge
 * fringes (`20 <= a < 224`) in place. Opaque pictures and uniform-alpha overlays return untouched in one
 * 32-bit word pass.
 */
export function cleanAlphaEdgesInPlace(pixels: Uint8Array, width: number, height: number): void {
  const count = width * height;
  if (width <= 0 || height <= 0 || pixels.length < count * 4) return;

  const { hasTransparent, hasOpaque } = scanAlpha(pixels, count);
  if (!hasTransparent) return;
  if (!hasOpaque) {
    snapAllTransparentDust(pixels, count);
    return;
  }

  const state = new Uint32Array(count);
  forwardChamferPass(pixels, state, width, height);
  backwardChamferAndWritebackPass(pixels, state, width, height);
}
