import type { OcrLineBlock } from './ocr-pdf-combiner';

/**
 * Detects bordered/ruled tables in which Tesseract skipped cells while scoring its partial reading
 * with high word confidence (policy decisions 302 and 317).
 *
 * Reference algorithms:
 *  - Leptonica (`DanBloomberg/leptonica`, BSD-2-Clause, `src/linefind.c` and `src/pageseg.c`):
 *    separates long horizontal/vertical ruling lines from short-run foreground character strokes;
 *    re-implemented from the mathematical run-length specification over uncompressed Netpbm (`P4`,
 *    `P5`, `P6`) buffers without copying C code.
 *  - RapidOCR / PaddleOCR PP-OCRv5 (`PaddlePaddle/PaddleOCR`, Apache-2.0): invoked as the rescue
 *    recognizer (`ocr.ts` `readSecondTimeWithOnnx`) only when a ruled grid is present and either at
 *    least 25% of the non-rule character ink inside the grid lies outside Tesseract's word boxes, or
 *    one cell of the grid has most of its own ink outside them (a table whose last column or one
 *    cell is dropped keeps a high confidence on the words that remain and loses little ink overall,
 *    policy decision 394).
 */

const MAX_HEADER_SCAN_BYTES = 128;
const MAX_PAGE_PIXELS = 50_000_000;
const DARK_GRAY_MAX = 160;
const MIN_H_RULE_PX = 120;
const MIN_H_RULE_WIDTH_SHARE = 0.25;
const MIN_V_RULE_PX = 48;
const MIN_V_RULE_HEIGHT_SHARE = 0.35;
const MIN_H_RULES = 3;
const MIN_V_RULES = 2;
const RULE_CLUSTER_GAP_PX = 6;
const RULE_MASK_MARGIN_PX = 3;
const GRID_INNER_MARGIN_PX = 4;
const WORD_COVER_PAD_PX = 6;
const TILE_SHIFT = 2; // 4x4 pixel coverage tiles
const MIN_GLYPH_RUN_PX = 2;
const MAX_GLYPH_RUN_FLOOR_PX = 48;
const MAX_GLYPH_RUN_WIDTH_SHARE = 0.08;
const MIN_GRID_GLYPH_INK_PX = 150;
const MIN_UNCOVERED_INK_SHARE = 0.25;
/** A cell counts when it holds at least this much glyph ink, and is dropped when this share of it lies outside the word boxes. */
const MIN_CELL_GLYPH_INK_PX = 40;
const MIN_UNCOVERED_CELL_SHARE = 0.4;

type PnmKind = 'p4' | 'p5' | 'p6';

interface PnmView {
  kind: PnmKind;
  width: number;
  height: number;
  rowBytes: number;
  dataOffset: number;
  bytes: Uint8Array;
}

interface RuleBand {
  pos: number;
  spanStart: number;
  spanEnd: number;
}

interface GridBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function isAsciiSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function readHeaderTokens(bytes: Uint8Array, needed: number): { tokens: number[]; offset: number } | null {
  const limit = Math.min(bytes.length, MAX_HEADER_SCAN_BYTES);
  const tokens: number[] = [];
  let i = 2;
  while (i < limit && tokens.length < needed) {
    while (i < limit && isAsciiSpace(bytes[i])) i++;
    if (i < limit && bytes[i] === 0x23) {
      while (i < limit && bytes[i] !== 0x0a) i++;
      continue;
    }
    let val = 0;
    let digits = 0;
    while (i < limit && bytes[i] >= 0x30 && bytes[i] <= 0x39) {
      val = val * 10 + (bytes[i] - 0x30);
      digits++;
      i++;
    }
    if (digits === 0) return null;
    tokens.push(val);
  }
  if (tokens.length !== needed || i >= bytes.length || !isAsciiSpace(bytes[i])) return null;
  return { tokens, offset: i + 1 };
}

function pnmKindFromCode(code: number): PnmKind | null {
  if (code === 0x34) return 'p4';
  if (code === 0x35) return 'p5';
  if (code === 0x36) return 'p6';
  return null;
}

function rowBytesForKind(kind: PnmKind, width: number): number {
  if (kind === 'p4') return (width + 7) >>> 3;
  if (kind === 'p5') return width;
  return width * 3;
}

export function parsePnmView(bytes: Uint8Array): PnmView | null {
  if (bytes.length < 8 || bytes[0] !== 0x50) return null;
  const kind = pnmKindFromCode(bytes[1]);
  if (kind === null) return null;
  const parsed = readHeaderTokens(bytes, kind === 'p4' ? 2 : 3);
  if (!parsed) return null;
  const [width, height] = parsed.tokens;
  if (width <= 0 || height <= 0 || width * height > MAX_PAGE_PIXELS) return null;
  const rowBytes = rowBytesForKind(kind, width);
  if (parsed.offset + rowBytes * height > bytes.length) return null;
  return { kind, width, height, rowBytes, dataOffset: parsed.offset, bytes };
}

function isDarkPixel(v: PnmView, x: number, y: number): boolean {
  const rowStart = v.dataOffset + y * v.rowBytes;
  if (v.kind === 'p5') return v.bytes[rowStart + x] < DARK_GRAY_MAX;
  if (v.kind === 'p4') return (v.bytes[rowStart + (x >>> 3)] & (0x80 >>> (x & 7))) !== 0;
  const p = rowStart + x * 3;
  return (v.bytes[p] + (v.bytes[p + 1] << 1) + v.bytes[p + 2]) >>> 2 < DARK_GRAY_MAX;
}

function clusterRuleBands(raw: RuleBand[]): RuleBand[] {
  if (raw.length === 0) return [];
  const merged: RuleBand[] = [{ ...raw[0] }];
  let count = 1;
  for (let i = 1; i < raw.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = raw[i];
    if (cur.pos - prev.pos <= RULE_CLUSTER_GAP_PX) {
      prev.pos = ((prev.pos * count + cur.pos) / (count + 1)) | 0;
      prev.spanStart = Math.min(prev.spanStart, cur.spanStart);
      prev.spanEnd = Math.max(prev.spanEnd, cur.spanEnd);
      count++;
    } else {
      merged.push({ ...cur });
      count = 1;
    }
  }
  return merged;
}

function findHorizontalRules(v: PnmView): RuleBand[] {
  const minRun = Math.max(MIN_H_RULE_PX, (v.width * MIN_H_RULE_WIDTH_SHARE) | 0);
  if (v.width < minRun) return [];
  const raw: RuleBand[] = [];
  for (let y = 0; y < v.height; y++) {
    let runStart = -1;
    let bestStart = 0;
    let bestEnd = 0;
    for (let x = 0; x <= v.width; x++) {
      const dark = x < v.width && isDarkPixel(v, x, y);
      if (dark && runStart < 0) runStart = x;
      else if (!dark && runStart >= 0) {
        if (x - runStart > bestEnd - bestStart) {
          bestStart = runStart;
          bestEnd = x;
        }
        runStart = -1;
      }
    }
    if (bestEnd - bestStart >= minRun) raw.push({ pos: y, spanStart: bestStart, spanEnd: bestEnd });
  }
  return clusterRuleBands(raw);
}

function findVerticalRules(v: PnmView, grid: GridBounds): RuleBand[] {
  const spanHeight = grid.bottom - grid.top;
  const minRun = Math.max(MIN_V_RULE_PX, (spanHeight * MIN_V_RULE_HEIGHT_SHARE) | 0);
  if (spanHeight < minRun) return [];
  const raw: RuleBand[] = [];
  for (let x = grid.left; x <= grid.right; x++) {
    let runStart = -1;
    let bestStart = 0;
    let bestEnd = 0;
    for (let y = grid.top; y <= grid.bottom + 1; y++) {
      const dark = y <= grid.bottom && isDarkPixel(v, x, y);
      if (dark && runStart < 0) runStart = y;
      else if (!dark && runStart >= 0) {
        if (y - runStart > bestEnd - bestStart) {
          bestStart = runStart;
          bestEnd = y;
        }
        runStart = -1;
      }
    }
    if (bestEnd - bestStart >= minRun) raw.push({ pos: x, spanStart: bestStart, spanEnd: bestEnd });
  }
  return clusterRuleBands(raw);
}

function buildRuleAxisMask(length: number, rules: readonly RuleBand[]): Uint8Array {
  const mask = new Uint8Array(length);
  for (const r of rules) {
    const lo = Math.max(0, r.pos - RULE_MASK_MARGIN_PX);
    const hi = Math.min(length - 1, r.pos + RULE_MASK_MARGIN_PX);
    mask.fill(1, lo, hi + 1);
  }
  return mask;
}

function buildWordCoverageTiles(width: number, height: number, blocks: readonly OcrLineBlock[]): { tiles: Uint8Array; cols: number } {
  const cols = (width + 3) >>> TILE_SHIFT;
  const rows = (height + 3) >>> TILE_SHIFT;
  const tiles = new Uint8Array(cols * rows);
  for (const block of blocks) {
    const boxes = block.words.length > 0 ? block.words.map((w) => w.bbox) : [block.bbox];
    for (const b of boxes) {
      const tx0 = Math.max(0, (Math.floor(b.x) - WORD_COVER_PAD_PX) >>> TILE_SHIFT);
      const ty0 = Math.max(0, (Math.floor(b.y) - WORD_COVER_PAD_PX) >>> TILE_SHIFT);
      const tx1 = Math.min(cols - 1, (Math.ceil(b.x + b.width) + WORD_COVER_PAD_PX) >>> TILE_SHIFT);
      const ty1 = Math.min(rows - 1, (Math.ceil(b.y + b.height) + WORD_COVER_PAD_PX) >>> TILE_SHIFT);
      for (let ty = ty0; ty <= ty1; ty++) {
        tiles.fill(1, ty * cols + tx0, ty * cols + tx1 + 1);
      }
    }
  }
  return { tiles, cols };
}

interface GridCells {
  /** Index of the cell row of each pixel row (-1 outside the rules), and of the cell column of each pixel column. */
  rowOf: Int32Array;
  colOf: Int32Array;
  columns: number;
  ink: Float64Array;
  covered: Float64Array;
}

/** Cell rows lie between consecutive horizontal rules and cell columns between consecutive vertical rules. */
function buildGridCells(width: number, height: number, hRules: readonly RuleBand[], vRules: readonly RuleBand[]): GridCells {
  const rowOf = new Int32Array(height).fill(-1);
  for (let i = 0; i + 1 < hRules.length; i++) rowOf.fill(i, hRules[i].pos, hRules[i + 1].pos);
  const colOf = new Int32Array(width).fill(-1);
  for (let j = 0; j + 1 < vRules.length; j++) colOf.fill(j, vRules[j].pos, vRules[j + 1].pos);
  const columns = Math.max(1, vRules.length - 1);
  const count = Math.max(1, hRules.length - 1) * columns;
  return { rowOf, colOf, columns, ink: new Float64Array(count), covered: new Float64Array(count) };
}

function countGridGlyphInk(
  v: PnmView,
  grid: GridBounds,
  masks: { rowRules: Uint8Array; colRules: Uint8Array; tiles: Uint8Array; tileCols: number },
  cells: GridCells
): { totalInk: number; coveredInk: number } {
  const maxGlyphRun = Math.max(MAX_GLYPH_RUN_FLOOR_PX, (v.width * MAX_GLYPH_RUN_WIDTH_SHARE) | 0);
  const yStart = Math.max(0, grid.top + GRID_INNER_MARGIN_PX);
  const yEnd = Math.min(v.height - 1, grid.bottom - GRID_INNER_MARGIN_PX);
  const xStart = Math.max(0, grid.left + GRID_INNER_MARGIN_PX);
  const xEnd = Math.min(v.width - 1, grid.right - GRID_INNER_MARGIN_PX);
  let totalInk = 0;
  let coveredInk = 0;
  for (let y = yStart; y <= yEnd; y++) {
    if (masks.rowRules[y] !== 0) continue;
    const tileRowBase = (y >>> TILE_SHIFT) * masks.tileCols;
    const cellRowBase = cells.rowOf[y] * cells.columns;
    let runStart = -1;
    for (let x = xStart; x <= xEnd + 1; x++) {
      const dark = x <= xEnd && masks.colRules[x] === 0 && isDarkPixel(v, x, y);
      if (dark && runStart < 0) runStart = x;
      else if (!dark && runStart >= 0) {
        const len = x - runStart;
        if (len >= MIN_GLYPH_RUN_PX && len <= maxGlyphRun) {
          let covered = 0;
          for (let rx = runStart; rx < x; rx++) covered += masks.tiles[tileRowBase + (rx >>> TILE_SHIFT)];
          totalInk += len;
          coveredInk += covered;
          const column = cells.colOf[runStart];
          if (cells.rowOf[y] >= 0 && column >= 0) {
            cells.ink[cellRowBase + column] += len;
            cells.covered[cellRowBase + column] += covered;
          }
        }
        runStart = -1;
      }
    }
  }
  return { totalInk, coveredInk };
}

/** Whether a cell of the grid holds glyph ink that is mostly outside the word boxes. */
function hasDroppedCell(cells: GridCells): boolean {
  for (let k = 0; k < cells.ink.length; k++) {
    if (cells.ink[k] >= MIN_CELL_GLYPH_INK_PX && (cells.ink[k] - cells.covered[k]) / cells.ink[k] >= MIN_UNCOVERED_CELL_SHARE) return true;
  }
  return false;
}

/**
 * Whether `pnmImage` contains a ruled table grid (`>= 3` horizontal rules and `>= 2` vertical rules)
 * in which at least 25% of non-rule character ink lies outside `lineBlocks` (in `pnmImage` pixels), or
 * in which one cell has 40% or more of its own ink (at least 40 pixels of it) outside them.
 */
export function hasUncoveredRuledTableInk(pnmImage: Uint8Array, lineBlocks: readonly OcrLineBlock[]): boolean {
  const view = parsePnmView(pnmImage);
  if (!view) return false;
  const hRules = findHorizontalRules(view);
  if (hRules.length < MIN_H_RULES) return false;
  const grid: GridBounds = {
    top: hRules[0].pos,
    bottom: hRules[hRules.length - 1].pos,
    left: hRules.reduce((m, r) => Math.min(m, r.spanStart), view.width),
    right: hRules.reduce((m, r) => Math.max(m, r.spanEnd), 0),
  };
  if (grid.right <= grid.left) return false;
  const vRules = findVerticalRules(view, grid);
  if (vRules.length < MIN_V_RULES) return false;
  const rowRules = buildRuleAxisMask(view.height, hRules);
  const colRules = buildRuleAxisMask(view.width, vRules);
  const { tiles, cols } = buildWordCoverageTiles(view.width, view.height, lineBlocks);
  const cells = buildGridCells(view.width, view.height, hRules, vRules);
  const { totalInk, coveredInk } = countGridGlyphInk(view, grid, { rowRules, colRules, tiles, tileCols: cols }, cells);
  if (totalInk < MIN_GRID_GLYPH_INK_PX) return false;
  return (totalInk - coveredInk) / totalInk >= MIN_UNCOVERED_INK_SHARE || hasDroppedCell(cells);
}
