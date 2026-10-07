import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  pushGraphicsState,
  popGraphicsState,
  beginText,
  endText,
  setFontAndSize,
  setTextRenderingMode,
  TextRenderingMode,
  setTextMatrix,
  showText,
  PDFOperator,
  PDFOperatorNames,
  PDFNumber,
  PDFHexString,
  PDFName,
  PDFArray,
  PDFDict,
  PDFString,
} from 'pdf-lib';
import { ConversionOptions } from '../types';
import {
  GLYPH_UNITS_PER_EM,
  LazyToUnicodeStream,
  TextLayerCidMap,
  WIDE_GLYPH_ADVANCE,
  buildToUnicodeCMapFromCids,
  glyphAdvanceForCodePoint,
} from './ocr-text-layer-font';
import { combineWordMerge, mergeWordsWithPageText, type OcrWordMerge } from './ocr-word-merge';

/** The first allocated CID; CID 0 is reserved for .notdef. */
const FIRST_TEXT_LAYER_CID = 1;

export interface OcrTableCellInfo {
  rowIndex: number;
  colIndex: number;
  rowSpan?: number;
  colSpan?: number;
}

export interface OcrBBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  angle?: number;
  rotationDegrees?: number;
  rotationRadians?: number;
  skewX?: number;
  skewY?: number;
  tableCell?: OcrTableCellInfo;
}

export interface OcrWord {
  text: string;
  bbox: OcrBBox;
  /**
   * Probability that the word is correct, 0..1. It is calibrated when the result says
   * `confidenceCalibrated`, and the engine's raw score divided by 100 otherwise.
   */
  confidence?: number;
}

/**
 * A block or paragraph of the recognizer's layout. Every line of one group points at the same
 * object, so group membership survives reordering and merging of line blocks.
 */
export interface OcrLayoutGroup {
  /** The engine's own box; when absent the union of the group's line boxes is used. */
  bbox?: OcrBBox;
  /** Language of the group, as the engine code (`eng`) or a BCP 47 tag. */
  language?: string;
}

/** The line a text row rests on, as two absolute points in image pixels with y pointing down. */
export interface OcrBaseline {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLineBlock {
  text: string;
  bbox: OcrBBox;
  words: OcrWord[];
  tableId?: string | number;
  /** Layout block (hOCR `ocr_carea`) holding this line, when the source had one. */
  block?: OcrLayoutGroup;
  /** Paragraph (hOCR `ocr_par`) holding this line, when the source had one. */
  paragraph?: OcrLayoutGroup;
  baseline?: OcrBaseline;
  /** Height of the text row (hOCR `x_size`), in pixels. */
  rowHeight?: number;
  /** Height of the tallest ascender above the x-height (hOCR `x_ascenders`), in pixels. */
  ascenders?: number;
  /** Depth of the deepest descender below the baseline (hOCR `x_descenders`), in pixels. */
  descenders?: number;
}

export interface OcrPageResult {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  confidence: number | null;
  lineBlocks: OcrLineBlock[];
  lines?: string[];
  /** Recognition language, as the engine code (`eng`) or a BCP 47 tag. */
  language?: string;
  /** Whether the word boxes were rebuilt into whole words from the page text; see ocr-word-merge.ts. */
  wordMerge?: OcrWordMerge;
}

export interface OcrResult {
  text: string;
  /** Mean word confidence weighted by word length in characters, 0..1; null when no word has one. */
  confidence: number | null;
  /** Whether the word and page confidences are calibrated probabilities; false for raw engine scores. */
  confidenceCalibrated?: boolean;
  wordCount: number;
  lines: string[];
  lineBlocks?: OcrLineBlock[];
  imageWidth?: number;
  imageHeight?: number;
  pages?: OcrPageResult[];
  /** Recognition language, as the engine code (`eng`) or a BCP 47 tag. */
  language?: string;
  /** Whether the word boxes were rebuilt into whole words from the page text; see ocr-word-merge.ts. */
  wordMerge?: OcrWordMerge;
}

export interface ColumnGutter {
  start: number;
  end: number;
  mid: number;
  width: number;
}

/**
 * Extracts dominant skew/rotation angle in radians from OCR line blocks
 * using explicit rotation/angle properties or estimated line baselines.
 */
export function extractDominantRotationRadians(blocks: OcrLineBlock[]): number {
  if (!blocks || blocks.length === 0) return 0;
  const angles: number[] = [];

  for (const b of blocks) {
    if (!b || !b.bbox) continue;
    if (b.bbox.rotationRadians !== undefined && Number.isFinite(b.bbox.rotationRadians)) {
      angles.push(b.bbox.rotationRadians);
    } else if (b.bbox.rotationDegrees !== undefined && Number.isFinite(b.bbox.rotationDegrees)) {
      angles.push((b.bbox.rotationDegrees * Math.PI) / 180);
    } else if (b.bbox.rotation !== undefined && Number.isFinite(b.bbox.rotation)) {
      angles.push((b.bbox.rotation * Math.PI) / 180);
    } else if (b.bbox.angle !== undefined && Number.isFinite(b.bbox.angle)) {
      angles.push((b.bbox.angle * Math.PI) / 180);
    }
  }

  // If no explicit rotation angles found, estimate from line baselines (if words exist)
  if (angles.length === 0) {
    for (const b of blocks) {
      if (b && b.words && b.words.length >= 2) {
        const first = b.words[0];
        const last = b.words[b.words.length - 1];
        if (first && last && first.bbox && last.bbox) {
          const dx = (last.bbox.x + last.bbox.width / 2) - (first.bbox.x + first.bbox.width / 2);
          const dy = (last.bbox.y + last.bbox.height / 2) - (first.bbox.y + first.bbox.height / 2);
          if (Math.abs(dx) >= 30) {
            const angle = Math.atan2(dy, dx);
            if (Math.abs(angle) <= Math.PI / 4) {
              angles.push(angle);
            }
          }
        }
      }
    }
  }

  if (angles.length === 0) return 0;
  angles.sort((a, b) => a - b);
  return angles[Math.floor(angles.length / 2)];
}

/**
 * Transforms an OCR line block into de-skewed / upright coordinate space
 * by rotating coordinates around a given center point by -angleRad.
 */
export function deskewBlock(b: OcrLineBlock, angleRad: number, cx: number, cy: number): OcrLineBlock {
  if (Math.abs(angleRad) <= 0.003) return b;
  const cos = Math.cos(-angleRad);
  const sin = Math.sin(-angleRad);

  const bx = b.bbox.x + b.bbox.width / 2;
  const by = b.bbox.y + b.bbox.height / 2;
  const dcx = cx + (bx - cx) * cos - (by - cy) * sin;
  const dcy = cy + (bx - cx) * sin + (by - cy) * cos;

  const deskewedWords: OcrWord[] = (b.words || []).map((w) => {
    if (!w || !w.bbox) return w;
    const wx = w.bbox.x + w.bbox.width / 2;
    const wy = w.bbox.y + w.bbox.height / 2;
    const wdcx = cx + (wx - cx) * cos - (wy - cy) * sin;
    const wdcy = cy + (wx - cx) * sin + (wy - cy) * cos;
    return {
      ...w,
      bbox: {
        ...w.bbox,
        x: wdcx - w.bbox.width / 2,
        y: wdcy - w.bbox.height / 2,
        rotation: 0,
        angle: 0,
        rotationDegrees: 0,
        rotationRadians: 0,
      },
    };
  });

  return {
    ...b,
    bbox: {
      ...b.bbox,
      x: dcx - b.bbox.width / 2,
      y: dcy - b.bbox.height / 2,
      width: b.bbox.width,
      height: b.bbox.height,
      rotation: 0,
      angle: 0,
      rotationDegrees: 0,
      rotationRadians: 0,
    },
    words: deskewedWords,
  };
}

/**
 * Computes bounding coordinate envelope for an array of valid OCR line blocks.
 */
function computeBlocksEnvelope(blocks: OcrLineBlock[]): {
  envMinX: number;
  envMaxX: number;
  envMinY: number;
  envMaxY: number;
  cx: number;
  cy: number;
} {
  let envMinX = Infinity;
  let envMaxX = -Infinity;
  let envMinY = Infinity;
  let envMaxY = -Infinity;

  for (const b of blocks) {
    if (b.bbox.x < envMinX) envMinX = b.bbox.x;
    const right = b.bbox.x + b.bbox.width;
    if (right > envMaxX) envMaxX = right;
    if (b.bbox.y < envMinY) envMinY = b.bbox.y;
    const bottom = b.bbox.y + b.bbox.height;
    if (bottom > envMaxY) envMaxY = bottom;
  }

  return {
    envMinX,
    envMaxX,
    envMinY,
    envMaxY,
    cx: (envMinX + envMaxX) / 2,
    cy: (envMinY + envMaxY) / 2,
  };
}

/**
 * Detects column gutters (vertical whitespace channels) across the horizontal axis
 * using 1D spatial projection profiles of bounding boxes with skew tolerance.
 */
export function detectColumnGutters(
  blocks: OcrLineBlock[],
  minColGap: number = 15,
  enclosingBounds?: { minX: number; maxX: number; docWidth: number }
): ColumnGutter[] {
  if (!blocks || blocks.length < 2) return [];

  // Filter out empty text and tiny noise blocks (e.g. dust specks < 3px)
  const validBlocks = blocks.filter(
    (b) =>
      b &&
      b.bbox &&
      Number.isFinite(b.bbox.x) &&
      Number.isFinite(b.bbox.y) &&
      Number.isFinite(b.bbox.width) &&
      b.bbox.width >= 3 &&
      Number.isFinite(b.bbox.height) &&
      b.bbox.height >= 3 &&
      (b.text || '').trim().length > 0
  );

  if (validBlocks.length < 2) return [];

  // De-skew blocks if a dominant tilt/rotation is detected
  const dominantAngle = extractDominantRotationRadians(validBlocks);
  let workingBlocks = validBlocks;
  const { cx, cy } = computeBlocksEnvelope(validBlocks);

  if (Math.abs(dominantAngle) > 0.003 && Math.abs(dominantAngle) <= Math.PI / 4) {
    workingBlocks = validBlocks.map((b) => deskewBlock(b, dominantAngle, cx, cy));
  }

  let minX = Infinity;
  let maxX = -Infinity;

  if (enclosingBounds && Number.isFinite(enclosingBounds.docWidth) && enclosingBounds.docWidth > 0) {
    minX = enclosingBounds.minX;
    maxX = enclosingBounds.maxX;
  } else {
    for (const b of workingBlocks) {
      if (b.bbox.x < minX) minX = b.bbox.x;
      const right = b.bbox.x + b.bbox.width;
      if (right > maxX) maxX = right;
    }
  }

  const docWidth =
    enclosingBounds && Number.isFinite(enclosingBounds.docWidth) && enclosingBounds.docWidth > 0
      ? enclosingBounds.docWidth
      : maxX - minX;
  if (!Number.isFinite(docWidth) || docWidth <= minColGap * 2) return [];

  // Exclude wide spanning blocks (width >= 72% of total width) from gutter calculation
  // to prevent spanning titles or headers from bridging across gutters, while preserving
  // wide columns in asymmetric layouts (e.g. 66% main body alongside 25% sidebar).
  const candidateBlocks = workingBlocks.filter((b) => b.bbox.width < docWidth * 0.72);
  if (candidateBlocks.length < 2) return [];

  const startX = Math.floor(minX);
  const endX = Math.ceil(maxX);
  const rawSpan = Math.max(1, endX - startX + 1);
  const scale = rawSpan > 10000 ? 10000 / rawSpan : 1.0;
  const projWidth = Math.max(1, Math.min(10000, Math.round(rawSpan * scale)));
  const xProj = new Int32Array(projWidth);

  for (const b of candidateBlocks) {
    const left = Math.max(0, Math.min(projWidth - 1, Math.floor((b.bbox.x - startX) * scale)));
    const right = Math.max(0, Math.min(projWidth - 1, Math.ceil((b.bbox.x + b.bbox.width - startX) * scale)));
    for (let x = left; x <= right; x++) {
      xProj[x]++;
    }
  }

  let maxProj = 0;
  for (let x = 0; x < projWidth; x++) {
    if (xProj[x] > maxProj) maxProj = xProj[x];
  }

  // Adaptive valley threshold based on column peak density:
  // A genuine gutter is a vertical whitespace valley significantly lower than the column density peaks.
  // We allow up to 25% of peak density (tolerating bridging equations, horizontal rules, or author affiliations).
  const densityThreshold = Math.max(
    0,
    Math.floor(maxProj * 0.25)
  );

  const rawGutters: ColumnGutter[] = [];
  let inValley = false;
  let valleyStart = 0;

  // Margin boundary check: gutters shouldn't be at the very edge of the document
  const marginOffset = Math.max(5, docWidth * 0.03);

  for (let x = 0; x < projWidth; x++) {
    const isValley = xProj[x] <= densityThreshold;
    if (isValley && !inValley) {
      inValley = true;
      valleyStart = x;
    } else if (!isValley && inValley) {
      inValley = false;
      const valleyWidth = (x - valleyStart) / scale;
      const absStart = startX + valleyStart / scale;
      const absEnd = startX + x / scale;

      // Verify that this valley is a genuine gutter dividing text:
      // Must have candidate text to the left AND to the right, and not be an outer margin
      const hasTextLeft = candidateBlocks.some((b) => b.bbox.x + b.bbox.width <= absStart + 4);
      const hasTextRight = candidateBlocks.some((b) => b.bbox.x >= absEnd - 4);

      if (
        valleyWidth >= minColGap &&
        absStart >= minX + marginOffset &&
        absEnd <= maxX - marginOffset &&
        hasTextLeft &&
        hasTextRight
      ) {
        rawGutters.push({
          start: Math.round(absStart),
          end: Math.round(absEnd),
          mid: Math.round((absStart + absEnd) / 2),
          width: Math.round(valleyWidth),
        });
      }
    }
  }

  // Merge adjacent / fragmented gutters separated by narrow noise (<= 6px)
  if (rawGutters.length <= 1) {
    return rawGutters;
  }

  const mergedGutters: ColumnGutter[] = [rawGutters[0]];
  for (let i = 1; i < rawGutters.length; i++) {
    const prev = mergedGutters[mergedGutters.length - 1];
    const curr = rawGutters[i];
    if (curr.start - prev.end <= 6) {
      // Merge with previous
      prev.end = curr.end;
      prev.mid = Math.round((prev.start + prev.end) / 2);
      prev.width = prev.end - prev.start;
    } else {
      mergedGutters.push(curr);
    }
  }

  return mergedGutters;
}

/**
 * Sorts table blocks into topologically correct reading order:
 * Row-by-row (top-to-bottom), column-by-column (left-to-right),
 * and intra-cell lines (top-to-bottom).
 * Prevents horizontal interleaving of multi-line cells within rows or across columns.
 */
export function sortTableBlocksReadingOrder(blocks: OcrLineBlock[]): OcrLineBlock[] {
  if (!blocks || blocks.length <= 1) return blocks ? [...blocks] : [];

  interface CellAssignedBlock {
    block: OcrLineBlock;
    rowIndex: number;
    colIndex: number;
  }

  const assigned: CellAssignedBlock[] = [];
  const hasExplicitCell = blocks.some((b) => b.bbox.tableCell !== undefined);

  if (hasExplicitCell) {
    for (const b of blocks) {
      const tc = b.bbox.tableCell;
      assigned.push({
        block: b,
        rowIndex: tc ? tc.rowIndex : 0,
        colIndex: tc ? tc.colIndex : 0,
      });
    }
  } else {
    // Spatial grid inference:
    // 1. Identify distinct column bands by X clustering
    const xClusters: { minX: number; maxX: number; midX: number }[] = [];
    const sortedByX = [...blocks].sort((a, b) => a.bbox.x - b.bbox.x);
    for (const b of sortedByX) {
      const px = b.bbox.x;
      const pw = Math.max(1, b.bbox.width);
      let matched = false;
      for (const xc of xClusters) {
        if (Math.abs(px - xc.minX) <= 18 || (px >= xc.minX - 5 && px <= xc.maxX + 5)) {
          xc.minX = Math.min(xc.minX, px);
          xc.maxX = Math.max(xc.maxX, px + pw);
          xc.midX = (xc.minX + xc.maxX) / 2;
          matched = true;
          break;
        }
      }
      if (!matched) {
        xClusters.push({ minX: px, maxX: px + pw, midX: px + pw / 2 });
      }
    }
    xClusters.sort((a, b) => a.midX - b.midX);

    // 2. Identify distinct row baselines by Y clustering
    const yClusters: { minY: number; maxY: number; midY: number }[] = [];
    const sortedByY = [...blocks].sort((a, b) => a.bbox.y - b.bbox.y);
    for (const b of sortedByY) {
      const py = b.bbox.y;
      const ph = Math.max(1, b.bbox.height);
      let matched = false;
      for (const yc of yClusters) {
        const lineTol = Math.max(4, Math.min(ph, yc.maxY - yc.minY) * 0.6);
        if (Math.abs(py - yc.minY) <= lineTol || (py >= yc.minY - lineTol && py <= yc.maxY + lineTol)) {
          yc.minY = Math.min(yc.minY, py);
          yc.maxY = Math.max(yc.maxY, py + ph);
          yc.midY = (yc.minY + yc.maxY) / 2;
          matched = true;
          break;
        }
      }
      if (!matched) {
        yClusters.push({ minY: py, maxY: py + ph, midY: py + ph / 2 });
      }
    }
    yClusters.sort((a, b) => a.midY - b.midY);

    for (const b of blocks) {
      const px = b.bbox.x + b.bbox.width / 2;
      const py = b.bbox.y + b.bbox.height / 2;

      let bestCol = 0;
      let bestColDist = Infinity;
      for (let ci = 0; ci < xClusters.length; ci++) {
        const dist = Math.abs(px - xClusters[ci].midX);
        if (dist < bestColDist) {
          bestColDist = dist;
          bestCol = ci;
        }
      }

      let bestRow = 0;
      let bestRowDist = Infinity;
      for (let ri = 0; ri < yClusters.length; ri++) {
        const dist = Math.abs(py - yClusters[ri].midY);
        if (dist < bestRowDist) {
          bestRowDist = dist;
          bestRow = ri;
        }
      }

      assigned.push({ block: b, rowIndex: bestRow, colIndex: bestCol });
    }
  }

  // Sort assigned pairs:
  // 1. rowIndex ascending (Row 0, Row 1, Row 2...)
  // 2. colIndex ascending (Col 0, Col 1, Col 2...)
  // 3. Y ascending within the same cell (Line 1, Line 2...)
  assigned.sort((a, b) => {
    if (a.rowIndex !== b.rowIndex) {
      return a.rowIndex - b.rowIndex;
    }
    if (a.colIndex !== b.colIndex) {
      return a.colIndex - b.colIndex;
    }
    return a.block.bbox.y - b.block.bbox.y;
  });

  return assigned.map((a) => a.block);
}

/**
 * Sorts OCR line blocks into topologically correct reading order
 * by detecting multi-column layouts, column gutters, and spanning elements.
 * Prevents horizontal interleaving of lines in 2-column or multi-column documents.
 */
export function sortLineBlocksTopological(
  blocks: OcrLineBlock[],
  pageWidth?: number,
  pageHeight?: number
): OcrLineBlock[] {
  if (!blocks || blocks.length <= 1) {
    return blocks ? [...blocks] : [];
  }

  // Separate blocks with non-finite coordinates to prevent coordinate corruption
  const isFiniteBbox = (b: OcrLineBlock): boolean =>
    Boolean(
      b &&
      b.bbox &&
      Number.isFinite(b.bbox.x) &&
      Number.isFinite(b.bbox.y) &&
      Number.isFinite(b.bbox.width) &&
      b.bbox.width >= 0 &&
      Number.isFinite(b.bbox.height) &&
      b.bbox.height >= 0
    );

  const validBlocks = blocks.filter(isFiniteBbox);
  const invalidBlocks = blocks.filter((b) => !isFiniteBbox(b));

  if (validBlocks.length <= 1) {
    return [...validBlocks, ...invalidBlocks];
  }

  // Detect dominant skew angle and prepare de-skewed geometric representations
  const dominantAngle = extractDominantRotationRadians(validBlocks);
  const hasSkew = Math.abs(dominantAngle) > 0.003 && Math.abs(dominantAngle) <= Math.PI / 4;
  const { cx, cy } = computeBlocksEnvelope(validBlocks);

  interface BlockPair {
    original: OcrLineBlock;
    geo: OcrLineBlock;
  }

  const pairs: BlockPair[] = validBlocks.map((b) => ({
    original: b,
    geo: hasSkew ? deskewBlock(b, dominantAngle, cx, cy) : b,
  }));

  // Detect vertical CJK writing mode (majority of lines have height > width * 1.3)
  const verticalCount = validBlocks.filter((b) => b.bbox.height > b.bbox.width * 1.3).length;
  const isVerticalMode = verticalCount > validBlocks.length * 0.5;

  // Helper to sort lines within a single column / cluster deterministically
  const sortIntraColumn = (colPairs: BlockPair[]): OcrLineBlock[] => {
    if (colPairs.length <= 1) return colPairs.map((p) => p.original);

    if (isVerticalMode) {
      // In vertical CJK writing mode:
      // Primary reading order is right-to-left across columns (X descending),
      // and top-to-bottom within columns (Y ascending).
      return [...colPairs]
        .sort((a, b) => {
          const dx = b.geo.bbox.x - a.geo.bbox.x;
          if (Math.abs(dx) > 15) return dx;
          return a.geo.bbox.y - b.geo.bbox.y;
        })
        .map((p) => p.original);
    }

    const sortStandard = (pairsToSort: BlockPair[]): OcrLineBlock[] => {
      if (pairsToSort.length <= 1) return pairsToSort.map((p) => p.original);
      const sorted = [...pairsToSort].sort((a, b) => a.geo.bbox.y - b.geo.bbox.y);
      const clusters: BlockPair[][] = [];
      for (const pair of sorted) {
        let placed = false;
        for (const cluster of clusters) {
          const rep = cluster[0];
          const lineTol = Math.max(3, Math.min(pair.geo.bbox.height, rep.geo.bbox.height) * 0.45);
          if (Math.abs(pair.geo.bbox.y - rep.geo.bbox.y) <= lineTol) {
            cluster.push(pair);
            placed = true;
            break;
          }
        }
        if (!placed) {
          clusters.push([pair]);
        }
      }
      const res: OcrLineBlock[] = [];
      for (const cluster of clusters) {
        cluster.sort((a, b) => a.geo.bbox.x - b.geo.bbox.x);
        res.push(...cluster.map((p) => p.original));
      }
      return res;
    };

    // Check if colPairs contain table cells (explicit tableId or bbox.tableCell)
    const tableGroups = new Map<string, BlockPair[]>();
    const nonTablePairs: BlockPair[] = [];

    for (const pair of colPairs) {
      const tId =
        pair.original.tableId ??
        (pair.original.bbox.tableCell !== undefined ? '__default_table__' : undefined);
      if (tId !== undefined) {
        const key = String(tId);
        if (!tableGroups.has(key)) tableGroups.set(key, []);
        tableGroups.get(key)!.push(pair);
      } else {
        nonTablePairs.push(pair);
      }
    }

    if (tableGroups.size === 0) {
      return sortStandard(colPairs);
    }

    interface ColumnSection {
      minY: number;
      blocks: OcrLineBlock[];
    }
    const sections: ColumnSection[] = [];

    for (const [, tPairs] of tableGroups) {
      const tMinY = tPairs.reduce((m, p) => Math.min(m, p.geo.bbox.y), Infinity);
      const sortedTable = sortTableBlocksReadingOrder(tPairs.map((p) => p.original));
      sections.push({ minY: tMinY, blocks: sortedTable });
    }

    if (nonTablePairs.length > 0) {
      const sortedNonTable = [...nonTablePairs].sort((a, b) => a.geo.bbox.y - b.geo.bbox.y);
      let currentCluster: BlockPair[] = [sortedNonTable[0]];

      for (let i = 1; i < sortedNonTable.length; i++) {
        const prev = sortedNonTable[i - 1];
        const curr = sortedNonTable[i];
        const gap = curr.geo.bbox.y - (prev.geo.bbox.y + prev.geo.bbox.height);

        const hasInterveningTable = Array.from(tableGroups.values()).some((tPairs) => {
          const tMinY = tPairs.reduce((m, p) => Math.min(m, p.geo.bbox.y), Infinity);
          const tMaxY = tPairs.reduce(
            (m, p) => Math.max(m, p.geo.bbox.y + p.geo.bbox.height),
            -Infinity
          );
          return tMinY >= prev.geo.bbox.y && tMaxY <= curr.geo.bbox.y + curr.geo.bbox.height;
        });

        if (hasInterveningTable || gap > 40) {
          sections.push({
            minY: currentCluster[0].geo.bbox.y,
            blocks: sortStandard(currentCluster),
          });
          currentCluster = [curr];
        } else {
          currentCluster.push(curr);
        }
      }

      if (currentCluster.length > 0) {
        sections.push({
          minY: currentCluster[0].geo.bbox.y,
          blocks: sortStandard(currentCluster),
        });
      }
    }

    sections.sort((a, b) => a.minY - b.minY);
    return sections.flatMap((s) => s.blocks);
  };

  // 1. Compute overall bounding envelope from de-skewed coordinates
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of pairs) {
    const x = p.geo.bbox.x;
    const y = p.geo.bbox.y;
    const width = Math.max(0, p.geo.bbox.width);
    const height = Math.max(0, p.geo.bbox.height);

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  }

  let docWidth = Math.max(0, maxX - minX);
  const docHeight = Math.max(0, maxY - minY);

  if (Number.isFinite(pageWidth) && (pageWidth ?? 0) > 0) {
    docWidth = Math.max(docWidth, (pageWidth ?? 0) - minX);
    maxX = Math.max(maxX, minX + docWidth);
  }

  if (docWidth <= 0 || docHeight <= 0) {
    return [...sortIntraColumn(pairs), ...invalidBlocks];
  }

  // 2. Detect column gutters
  const minColGap = Math.max(12, Math.min(36, docWidth * 0.025));
  const geoBlocks = pairs.map((p) => p.geo);
  const gutters = detectColumnGutters(geoBlocks, minColGap, { minX, maxX, docWidth });

  // If no column gutters were found, this is a single-column layout
  if (gutters.length === 0) {
    return [...sortIntraColumn(pairs), ...invalidBlocks];
  }

  // 3. Multi-column document handling
  gutters.sort((a, b) => a.start - b.start);
  const columnCount = gutters.length + 1;

  // Identify spanning blocks (headers, titles, footers, full-width section dividers)
  const isSpanning = (p: BlockPair): boolean => {
    const left = p.geo.bbox.x;
    const right = p.geo.bbox.x + p.geo.bbox.width;
    // Spans across any gutter
    for (const g of gutters) {
      if (left < g.start + 4 && right > g.end - 4) {
        return true;
      }
    }
    // Or covers more than 80% of entire text envelope
    if (p.geo.bbox.width >= docWidth * 0.80) {
      return true;
    }
    return false;
  };

  const spanningPairs: BlockPair[] = [];
  const columnPairs: BlockPair[][] = Array.from({ length: columnCount }, () => []);

  for (const p of pairs) {
    if (isSpanning(p)) {
      spanningPairs.push(p);
    } else {
      const midX = p.geo.bbox.x + p.geo.bbox.width / 2;
      let colIdx = 0;
      for (let i = 0; i < gutters.length; i++) {
        if (midX >= gutters[i].mid) {
          colIdx = i + 1;
        } else {
          break;
        }
      }
      columnPairs[colIdx].push(p);
    }
  }

  // Collect all column lines
  const allColPairs = columnPairs.flat();
  if (allColPairs.length === 0) {
    // Only spanning blocks
    return [...sortIntraColumn(pairs), ...invalidBlocks];
  }

  // Sort spanning blocks top-to-bottom
  spanningPairs.sort((a, b) => a.geo.bbox.y - b.geo.bbox.y);

  const headerPairs: BlockPair[] = [];
  const footerPairs: BlockPair[] = [];
  const middleSpanningPairs: BlockPair[] = [];

  for (const sp of spanningPairs) {
    const linesAbove = allColPairs.filter(
      (c) => c.geo.bbox.y + c.geo.bbox.height < sp.geo.bbox.y + 4
    ).length;
    const linesBelow = allColPairs.filter(
      (c) => c.geo.bbox.y > sp.geo.bbox.y + sp.geo.bbox.height - 4
    ).length;

    if (linesAbove === 0) {
      headerPairs.push(sp);
    } else if (linesBelow === 0) {
      footerPairs.push(sp);
    } else {
      middleSpanningPairs.push(sp);
    }
  }

  const result: OcrLineBlock[] = [];

  // Column iteration order: left-to-right (0..K) for horizontal, right-to-left (K..0) for vertical CJK
  const colIndices: number[] = [];
  if (isVerticalMode) {
    for (let c = columnCount - 1; c >= 0; c--) colIndices.push(c);
  } else {
    for (let c = 0; c < columnCount; c++) colIndices.push(c);
  }

  // 1. Spanning Headers first
  result.push(...sortIntraColumn(headerPairs));

  // 2. Body columns partitioned by any middle spanning blocks
  if (middleSpanningPairs.length === 0) {
    for (const c of colIndices) {
      result.push(...sortIntraColumn(columnPairs[c]));
    }
  } else {
    // Cluster consecutive or overlapping middle spanning blocks into SpanningBands
    interface SpanningBandPair {
      top: number;
      bottom: number;
      pairs: BlockPair[];
    }
    const bands: SpanningBandPair[] = [];
    for (const sp of middleSpanningPairs) {
      const top = sp.geo.bbox.y;
      const bottom = sp.geo.bbox.y + sp.geo.bbox.height;
      if (bands.length === 0) {
        bands.push({ top, bottom, pairs: [sp] });
      } else {
        const lastBand = bands[bands.length - 1];
        const lineTol = Math.max(4, sp.geo.bbox.height * 0.5);
        if (top <= lastBand.bottom + lineTol) {
          lastBand.bottom = Math.max(lastBand.bottom, bottom);
          lastBand.pairs.push(sp);
        } else {
          bands.push({ top, bottom, pairs: [sp] });
        }
      }
    }

    // Assign each block in columnPairs to exactly one slice:
    // A block is placed in slice i before the first band whose bottom is below its center,
    // or in the trailing slice (index bands.length) if none qualifies.
    const sliceCount = bands.length + 1;
    const slices: BlockPair[][][] = Array.from({ length: sliceCount }, () =>
      Array.from({ length: columnCount }, () => [])
    );

    const getSliceIndex = (p: BlockPair): number => {
      const midY = p.geo.bbox.y + p.geo.bbox.height / 2;
      for (let i = 0; i < bands.length; i++) {
        if (midY < bands[i].bottom) {
          return i;
        }
      }
      return bands.length;
    };

    for (let c = 0; c < columnCount; c++) {
      for (const p of columnPairs[c]) {
        const sIdx = getSliceIndex(p);
        slices[sIdx][c].push(p);
      }
    }

    // Assemble result:
    // Slice 0 (above/before band 0)
    for (const c of colIndices) {
      result.push(...sortIntraColumn(slices[0][c]));
    }

    // For each band: band blocks, then the slice below it
    for (let i = 0; i < bands.length; i++) {
      result.push(...sortIntraColumn(bands[i].pairs));
      for (const c of colIndices) {
        result.push(...sortIntraColumn(slices[i + 1][c]));
      }
    }
  }

  // 3. Spanning Footers last
  result.push(...sortIntraColumn(footerPairs));

  // 4. Append separated invalid-coordinate blocks at the end
  if (invalidBlocks.length > 0) {
    result.push(...invalidBlocks);
  }

  return result;
}

const ENGINE_CONFIDENCE_PERCENT_SCALE = 100;

/** The engine reports a word score in percent; it is kept as a fraction, or undefined when it has none. */
function engineConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(1, value / ENGINE_CONFIDENCE_PERCENT_SCALE);
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A block or paragraph box from the engine (`x0 y0 x1 y1`), or undefined when it is missing or empty. */
function engineBox(box: any): OcrBBox | undefined {
  const x0 = finiteOrUndefined(box?.x0);
  const y0 = finiteOrUndefined(box?.y0);
  const x1 = finiteOrUndefined(box?.x1);
  const y1 = finiteOrUndefined(box?.y1);
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return undefined;
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The engine reports no baseline for a line as a zero-length segment; only a real one is kept. */
function engineBaseline(baseline: any): OcrBaseline | undefined {
  const x0 = finiteOrUndefined(baseline?.x0);
  const y0 = finiteOrUndefined(baseline?.y0);
  const x1 = finiteOrUndefined(baseline?.x1);
  const y1 = finiteOrUndefined(baseline?.y1);
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return undefined;
  return x1 > x0 ? { x0, y0, x1, y1 } : undefined;
}

/**
 * Parses raw Tesseract recognition block hierarchy into clean lines and blocks
 * ordered with topological reading order (preserving multi-column structure).
 * Shared between server and client edge pipelines. Each line keeps the block and paragraph it
 * came from (`block`, `paragraph`) and, when the engine reports them, its baseline and row metrics.
 */
export function parseTesseractBlocks(
  blocks: any[] | null | undefined,
  pageWidth?: number,
  pageHeight?: number,
  language?: string
): { lines: string[]; lineBlocks: OcrLineBlock[]; wordMerge?: OcrWordMerge } {
  const lineBlocks: OcrLineBlock[] = [];
  const mergeOutcomes: OcrWordMerge[] = [];
  if (!blocks || blocks.length === 0) return { lines: [], lineBlocks: [] };

  for (const block of blocks) {
    if (!block.paragraphs) continue;
    const blockGroup: OcrLayoutGroup = { bbox: engineBox(block.bbox) };
    for (const para of block.paragraphs) {
      if (!para.lines) continue;
      const paragraphGroup: OcrLayoutGroup = { bbox: engineBox(para.bbox), language };
      for (const line of para.lines) {
        const text = (line.text || '').trim();
        if (!text) continue;

        const words: OcrWord[] = [];
        if (line.words) {
          for (const w of line.words) {
            const wText = (w.text || '').trim();
            if (!wText) continue;
            words.push({
              text: wText,
              confidence: engineConfidence(w.confidence),
              bbox: {
                x: w.bbox.x0,
                y: w.bbox.y0,
                width: Math.max(1, w.bbox.x1 - w.bbox.x0),
                height: Math.max(1, w.bbox.y1 - w.bbox.y0),
                rotation: w.rotation ?? w.angle ?? line.rotation ?? line.angle ?? block.rotation ?? block.angle,
                skewX: w.skewX ?? line.skewX,
                skewY: w.skewY ?? line.skewY,
              },
            });
          }
        }

        // The engine's own line text keeps the original spacing, which the per-character boxes of
        // CJK text do not carry; whole words are rebuilt from it.
        if (words.length > 0) {
          const merged = mergeWordsWithPageText(text, words);
          words.splice(0, words.length, ...merged.words);
          mergeOutcomes.push(merged.wordMerge);
        }

        lineBlocks.push({
          text,
          bbox: {
            x: line.bbox.x0,
            y: line.bbox.y0,
            width: Math.max(1, line.bbox.x1 - line.bbox.x0),
            height: Math.max(1, line.bbox.y1 - line.bbox.y0),
            rotation: line.rotation ?? line.angle ?? block.rotation ?? block.angle,
            skewX: line.skewX ?? block.skewX,
            skewY: line.skewY ?? block.skewY,
          },
          words,
          block: blockGroup,
          paragraph: paragraphGroup,
          baseline: engineBaseline(line.baseline),
          rowHeight: finiteOrUndefined(line.rowAttributes?.rowHeight),
          ascenders: finiteOrUndefined(line.rowAttributes?.ascenders),
          descenders: finiteOrUndefined(line.rowAttributes?.descenders),
        });
      }
    }
  }

  const sortedLineBlocks = sortLineBlocksTopological(lineBlocks, pageWidth, pageHeight);
  const lines = sortedLineBlocks.map((b) => b.text);

  return { lines, lineBlocks: sortedLineBlocks, wordMerge: combineWordMerge(mergeOutcomes) };
}

/**
 * Creates an ISO 32000-1 compliant ToUnicode CMap stream for the 16-bit (Identity-H) text-layer
 * font. Each `[cid, codePoint]` pair becomes one `bfchar` entry with a UTF-16BE destination
 * (a surrogate pair for astral code points). No `bfrange` is emitted: §9.10.3 only lets the last
 * byte of a code vary inside a range, which a 2-byte CID to code point table cannot satisfy.
 */
export function createToUnicodeCMap(
  mappings: Array<[number, number]> | Map<number, number> = []
): string {
  return buildToUnicodeCMapFromCids([...mappings]);
}

/**
 * Creates an ISO 32000-1 compliant 1-byte WinAnsi ToUnicode CMap stream for StandardFonts.
 */
export function createWinAnsiToUnicodeCMap(): string {
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo <<
  /Registry (Adobe)
  /Ordering (UCS)
  /Supplement 0
>> def
/CMapName /WinAnsi-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
1 beginbfrange
<00> <FF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

export interface UnicodeFontInfo {
  fontName: string;
  fontRef: any;
  /**
   * Encodes text (normalized to NFC) as Identity-H hex, allocating one dense CID per distinct
   * code point. The font's ToUnicode CMap and /W array are kept in step with the allocations.
   */
  encodeText: (text: string) => string;
}

/**
 * Generates an ISO 32000-1 / OpenType compliant minimal TrueType (SFNT) binary font.
 * Includes all 10 mandatory standard tables (OS/2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, post)
 * with strict 4-byte alignment and checksum calculations, allowing strict PDF viewers
 * to parse embedded /FontFile2 CIDFontType2 glyph streams without missing font errors.
 */
export function buildMinimalTrueTypeFont(): Buffer {
  const calcTableChecksum = (buf: Buffer): number => {
    let sum = 0;
    const n = Math.floor(buf.length / 4);
    for (let i = 0; i < n; i++) {
      sum = (sum + buf.readUInt32BE(i * 4)) >>> 0;
    }
    return sum;
  };

  // 1. Table 'head' (54 bytes)
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0); // version 1.0
  head.writeUInt32BE(0x00010000, 4); // fontRevision 1.0
  head.writeUInt32BE(0x00000000, 8); // checkSumAdjustment (calculated later)
  head.writeUInt32BE(0x5f0f3cf5, 12); // magicNumber
  head.writeUInt16BE(0x0003, 16); // flags
  head.writeUInt16BE(1000, 18); // unitsPerEm
  head.writeInt16BE(-1000, 36); // xMin
  head.writeInt16BE(-200, 38); // yMin
  head.writeInt16BE(1000, 40); // xMax
  head.writeInt16BE(1000, 42); // yMax
  head.writeUInt16BE(0, 44); // macStyle
  head.writeUInt16BE(6, 46); // lowestRecPPEM
  head.writeInt16BE(2, 48); // fontDirectionHint
  head.writeInt16BE(0, 50); // indexToLocFormat: 0 (16-bit offset / 2)
  head.writeInt16BE(0, 52); // glyphDataFormat: 0

  // 2. Table 'hhea' (36 bytes)
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0); // version 1.0
  hhea.writeInt16BE(1000, 4); // ascender
  hhea.writeInt16BE(-200, 6); // descender
  hhea.writeInt16BE(0, 8); // lineGap
  hhea.writeUInt16BE(1000, 10); // advanceWidthMax
  hhea.writeInt16BE(0, 12); // minLeftSideBearing
  hhea.writeInt16BE(0, 14); // minRightSideBearing
  hhea.writeInt16BE(1000, 16); // xMaxExtent
  hhea.writeInt16BE(1, 18); // caretSlopeRise
  hhea.writeInt16BE(0, 20); // caretSlopeRun
  hhea.writeInt16BE(0, 22); // caretOffset
  hhea.writeInt16BE(0, 32); // metricDataFormat
  hhea.writeUInt16BE(1, 34); // numberOfHMetrics

  // 3. Table 'maxp' (32 bytes)
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0); // version 1.0
  maxp.writeUInt16BE(1, 4); // numGlyphs = 1 (.notdef)

  // 4. Table 'OS/2' (86 bytes)
  const os2 = Buffer.alloc(86);
  os2.writeUInt16BE(1, 0); // version 1
  os2.writeInt16BE(1000, 2); // xAvgCharWidth
  os2.writeUInt16BE(400, 4); // usWeightClass (Regular)
  os2.writeUInt16BE(5, 6); // usWidthClass (Medium)
  os2.writeUInt16BE(0, 8); // fsType (0 = installable)
  os2.writeInt16BE(650, 10); // ySubscriptXSize
  os2.writeInt16BE(600, 12); // ySubscriptYSize
  os2.writeInt16BE(0, 14); // ySubscriptXOffset
  os2.writeInt16BE(75, 16); // ySubscriptYOffset
  os2.writeInt16BE(650, 18); // ySuperscriptXSize
  os2.writeInt16BE(600, 20); // ySuperscriptYSize
  os2.writeInt16BE(0, 22); // ySuperscriptXOffset
  os2.writeInt16BE(350, 24); // ySuperscriptYOffset
  os2.writeInt16BE(50, 26); // yStrikeoutSize
  os2.writeInt16BE(300, 28); // yStrikeoutPosition
  os2.writeInt16BE(0, 30); // sFamilyClass
  os2.write('ECVT', 58, 4, 'ascii'); // achVendID
  os2.writeUInt16BE(0x0040, 62); // fsSelection (REGULAR)
  os2.writeUInt16BE(0x0020, 64); // usFirstCharIndex
  os2.writeUInt16BE(0xffff, 66); // usLastCharIndex
  os2.writeInt16BE(1000, 68); // sTypoAscender
  os2.writeInt16BE(-200, 70); // sTypoDescender
  os2.writeInt16BE(0, 72); // sTypoLineGap
  os2.writeUInt16BE(1000, 74); // usWinAscent
  os2.writeUInt16BE(200, 76); // usWinDescent

  // 5. Table 'hmtx' (4 bytes)
  const hmtx = Buffer.alloc(4);
  hmtx.writeUInt16BE(1000, 0); // advanceWidth = 1000
  hmtx.writeInt16BE(0, 2); // leftSideBearing = 0

  // 6. Table 'loca' (4 bytes)
  const loca = Buffer.alloc(4);
  loca.writeUInt16BE(0, 0); // glyph 0 offset: 0 / 2 = 0
  loca.writeUInt16BE(5, 2); // glyph 1 offset: 10 / 2 = 5

  // 7. Table 'glyf' (10 bytes -> padded to 12)
  const glyf = Buffer.alloc(10);
  glyf.writeInt16BE(0, 0); // numberOfContours: 0 (empty .notdef glyph)
  glyf.writeInt16BE(0, 2); // xMin
  glyf.writeInt16BE(0, 4); // yMin
  glyf.writeInt16BE(0, 6); // xMax
  glyf.writeInt16BE(0, 8); // yMax

  // 8. Table 'name'
  const nameStrings = [
    'EasyConvert-ToUnicode', // 1: Family
    'Regular', // 2: Subfamily
    'EasyConvert-ToUnicode', // 3: Unique ID
    'EasyConvert-ToUnicode', // 4: Full Name
    'EasyConvert-ToUnicode', // 6: PostScript Name
  ];
  const nameIds = [1, 2, 3, 4, 6];
  const stringBuffers = nameStrings.map((s) => {
    const b = Buffer.alloc(s.length * 2);
    for (let j = 0; j < s.length; j++) {
      b.writeUInt16BE(s.codePointAt(j) ?? 0, j * 2);
    }
    return b;
  });
  const stringHeaderSize = 6 + nameIds.length * 12;
  const stringDataTotal = stringBuffers.reduce((acc, b) => acc + b.length, 0);

  const name = Buffer.alloc(stringHeaderSize + stringDataTotal);
  name.writeUInt16BE(0, 0); // format 0
  name.writeUInt16BE(nameIds.length, 2); // count
  name.writeUInt16BE(stringHeaderSize, 4); // stringOffset

  let curStrOffset = 0;
  for (let i = 0; i < nameIds.length; i++) {
    const recOff = 6 + i * 12;
    name.writeUInt16BE(3, recOff); // platformID: Windows
    name.writeUInt16BE(1, recOff + 2); // encodingID: Unicode BMP
    name.writeUInt16BE(0x0409, recOff + 4); // languageID: English US
    name.writeUInt16BE(nameIds[i], recOff + 6); // nameID
    name.writeUInt16BE(stringBuffers[i].length, recOff + 8); // length
    name.writeUInt16BE(curStrOffset, recOff + 10); // offset
    stringBuffers[i].copy(name, stringHeaderSize + curStrOffset);
    curStrOffset += stringBuffers[i].length;
  }

  // 9. Table 'post' (32 bytes)
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0); // format 3.0
  post.writeUInt32BE(0, 4); // italicAngle
  post.writeInt16BE(-100, 8); // underlinePosition
  post.writeInt16BE(50, 10); // underlineThickness
  post.writeUInt32BE(1, 12); // isFixedPitch = 1

  // 10. Table 'cmap' (44 bytes)
  const cmap = Buffer.alloc(44);
  cmap.writeUInt16BE(0, 0); // version 0
  cmap.writeUInt16BE(1, 2); // numTables = 1
  cmap.writeUInt16BE(3, 4); // platformID: Windows
  cmap.writeUInt16BE(1, 6); // encodingID: Unicode BMP
  cmap.writeUInt32BE(12, 8); // subtable offset = 12

  // cmap subtable format 4 (32 bytes at offset 12)
  const sub = cmap.subarray(12);
  sub.writeUInt16BE(4, 0); // format 4
  sub.writeUInt16BE(32, 2); // length 32
  sub.writeUInt16BE(0, 4); // language 0
  sub.writeUInt16BE(4, 6); // segCountX2 = 4 (2 segments)
  sub.writeUInt16BE(4, 8); // searchRange
  sub.writeUInt16BE(1, 10); // entrySelector
  sub.writeUInt16BE(0, 12); // rangeShift
  sub.writeUInt16BE(0x0020, 14); // endCode seg 0
  sub.writeUInt16BE(0xffff, 16); // endCode seg 1
  sub.writeUInt16BE(0, 18); // reservedPad
  sub.writeUInt16BE(0x0020, 20); // startCode seg 0
  sub.writeUInt16BE(0xffff, 22); // startCode seg 1
  sub.writeInt16BE(-0x0020, 24); // idDelta seg 0
  sub.writeInt16BE(1, 26); // idDelta seg 1
  sub.writeUInt16BE(0, 28); // idRangeOffset seg 0
  sub.writeUInt16BE(0, 30); // idRangeOffset seg 1

  // Alphabetically sorted table entries
  const rawTables: Array<{ tag: string; buf: Buffer }> = [
    { tag: 'OS/2', buf: os2 },
    { tag: 'cmap', buf: cmap },
    { tag: 'glyf', buf: glyf },
    { tag: 'head', buf: head },
    { tag: 'hhea', buf: hhea },
    { tag: 'hmtx', buf: hmtx },
    { tag: 'loca', buf: loca },
    { tag: 'maxp', buf: maxp },
    { tag: 'name', buf: name },
    { tag: 'post', buf: post },
  ];

  const tables = rawTables.map((t) => {
    const pad = (4 - (t.buf.length % 4)) % 4;
    const paddedBuf = pad === 0 ? t.buf : Buffer.concat([t.buf, Buffer.alloc(pad)]);
    return {
      tag: t.tag,
      origLength: t.buf.length,
      paddedBuf,
      checksum: calcTableChecksum(paddedBuf),
    };
  });

  const numTables = tables.length;
  const headerSize = 12 + numTables * 16;
  let totalSize = headerSize;
  for (const t of tables) {
    totalSize += t.paddedBuf.length;
  }

  const fontFile = Buffer.alloc(totalSize);
  fontFile.writeUInt32BE(0x00010000, 0); // sfntVersion (TrueType)
  fontFile.writeUInt16BE(numTables, 4);
  const maxPow2 = 1 << Math.floor(Math.log2(numTables));
  fontFile.writeUInt16BE(maxPow2 * 16, 6); // searchRange
  fontFile.writeUInt16BE(Math.floor(Math.log2(numTables)), 8); // entrySelector
  fontFile.writeUInt16BE(numTables * 16 - maxPow2 * 16, 10); // rangeShift

  let curOffset = headerSize;
  let headTableOffset = 0;

  for (let i = 0; i < numTables; i++) {
    const t = tables[i];
    const dirOffset = 12 + i * 16;
    fontFile.write(t.tag, dirOffset, 4, 'ascii');
    fontFile.writeUInt32BE(t.checksum, dirOffset + 4);
    fontFile.writeUInt32BE(curOffset, dirOffset + 8);
    fontFile.writeUInt32BE(t.origLength, dirOffset + 12);

    t.paddedBuf.copy(fontFile, curOffset);
    if (t.tag === 'head') {
      headTableOffset = curOffset;
    }
    curOffset += t.paddedBuf.length;
  }

  const fullFontChecksum = calcTableChecksum(fontFile);
  const checkSumAdjustment = (0xb1b0afba - fullFontChecksum) >>> 0;
  fontFile.writeUInt32BE(checkSumAdjustment, headTableOffset + 8);

  return fontFile;
}

const TEXT_LAYER_FONT_RESOURCE_BASE = 'ECToUnicodeFont';

/** Font resource names used by any page of the document. */
function fontResourceNamesInUse(doc: PDFDocument): Set<string> {
  const names = new Set<string>();
  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    const resolved = resources ? doc.context.lookup(resources) : undefined;
    if (!(resolved instanceof PDFDict)) continue;
    const fonts = doc.context.lookup(resolved.get(PDFName.of('Font')));
    if (!(fonts instanceof PDFDict)) continue;
    for (const key of fonts.keys()) names.add(key.decodeText());
  }
  return names;
}

/** `base`, or `base` with the smallest numeric suffix that no page uses yet. */
function unusedFontResourceName(doc: PDFDocument, base: string): string {
  const inUse = fontResourceNamesInUse(doc);
  if (!inUse.has(base)) return base;
  let suffix = 1;
  while (inUse.has(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
}

/**
 * Ensures a Type 0 CIDFont with an embedded TrueType stream (/FontFile2)
 * and a 16-bit /ToUnicode CMap stream into the PDFDocument per ISO 32000-1.
 */
export function ensureUnicodeFont(doc: PDFDocument): UnicodeFontInfo {
  if ((doc as any)._unicodeFontInfo) {
    return (doc as any)._unicodeFontInfo;
  }

  // CIDs are allocated while text is laid out; the ToUnicode content is generated at save time and
  // the /W array grows with each new CID, so both always describe exactly the CIDs in use.
  const widths = PDFArray.withContext(doc.context);
  const firstCidWidths = PDFArray.withContext(doc.context);
  const cids = new TextLayerCidMap((cid, codePoint) => {
    if (cid === FIRST_TEXT_LAYER_CID) {
      widths.push(PDFNumber.of(FIRST_TEXT_LAYER_CID));
      widths.push(firstCidWidths);
    }
    firstCidWidths.push(PDFNumber.of(glyphAdvanceForCodePoint(codePoint)));
  });
  const cmapStream = new LazyToUnicodeStream(doc.context.obj({}), cids);
  const cmapRef = doc.context.register(cmapStream);

  const ttfBuffer = buildMinimalTrueTypeFont();
  const fontStream = doc.context.flateStream(ttfBuffer);
  fontStream.dict.set(PDFName.of('Length1'), PDFNumber.of(ttfBuffer.length));
  const fontStreamRef = doc.context.register(fontStream);

  const fontDescDict = doc.context.obj({
    Type: 'FontDescriptor',
    FontName: 'EasyConvert-ToUnicode',
    Flags: 4,
    FontBBox: [-1000, -1000, 1000, 1000],
    ItalicAngle: 0,
    Ascent: 1000,
    Descent: -200,
    CapHeight: 800,
    StemV: 80,
    FontFile2: fontStreamRef,
  });
  const fontDescRef = doc.context.register(fontDescDict);

  const cidFontDict = doc.context.obj({
    Type: 'Font',
    Subtype: 'CIDFontType2',
    BaseFont: 'EasyConvert-ToUnicode',
    // ISO 32000-1 §9.7.3: Registry and Ordering are text strings, not names.
    CIDSystemInfo: {
      Registry: PDFString.of('Adobe'),
      Ordering: PDFString.of('Identity'),
      Supplement: 0,
    },
    FontDescriptor: fontDescRef,
    DW: WIDE_GLYPH_ADVANCE,
    // ISO 32000-1 §9.7.4.3: `c [w1 w2 ...]` lists consecutive CIDs starting at c.
    W: widths,
  });
  const cidFontRef = doc.context.register(cidFontDict);

  const type0FontDict = doc.context.obj({
    Type: 'Font',
    Subtype: 'Type0',
    BaseFont: 'EasyConvert-ToUnicode',
    Encoding: 'Identity-H',
    DescendantFonts: [cidFontRef],
    ToUnicode: cmapRef,
  });
  const type0FontRef = doc.context.register(type0FontDict);
  // A page of a loaded PDF may already use this resource name for an earlier text layer whose CIDs
  // mean something else; overwriting it would make that layer decode through this font's map.
  const fontName = unusedFontResourceName(doc, TEXT_LAYER_FONT_RESOURCE_BASE);

  const fontInfo: UnicodeFontInfo = {
    fontName,
    fontRef: type0FontRef,
    encodeText: (text: string) => cids.encodeText(text),
  };
  (doc as any)._unicodeFontInfo = fontInfo;
  return fontInfo;
}

/**
 * Ensures the Type 0 Unicode font is declared in the page's /Resources /Font dictionary,
 * dereferencing indirect object references (PDFRef) common in pre-existing PDF documents.
 */
export function registerFontOnPage(page: PDFPage, fontInfo: UnicodeFontInfo): void {
  let resources: any = page.node.Resources();
  if (!resources) {
    resources = page.doc.context.obj({});
    page.node.set(PDFName.of('Resources'), resources);
  } else {
    const resolved = page.doc.context.lookup(resources);
    if (resolved) {
      resources = resolved;
    }
  }

  const rawFontDict = resources.get(PDFName.of('Font'));
  let fontDict: any;
  if (!rawFontDict) {
    fontDict = page.doc.context.obj({});
    resources.set(PDFName.of('Font'), fontDict);
  } else {
    fontDict = page.doc.context.lookup(rawFontDict);
    if (!fontDict) {
      fontDict = page.doc.context.obj({});
      resources.set(PDFName.of('Font'), fontDict);
    }
  }
  fontDict.set(PDFName.of(fontInfo.fontName), fontInfo.fontRef);
}

/**
 * Injects ISO 32000-1 /ToUnicode CMap stream into standard Type 1 fonts.
 */
export function ensureStandardFontToUnicode(doc: PDFDocument, font: PDFFont): void {
  if ((font as any)._hasToUnicodeCMap) return;
  (font as any)._hasToUnicodeCMap = true;

  const embedder = (font as any).embedder;
  if (embedder && typeof embedder.embedIntoContext === 'function') {
    const origEmbed = embedder.embedIntoContext.bind(embedder);
    embedder.embedIntoContext = (context: any, ref: any) => {
      const resultRef = origEmbed(context, ref);
      const targetRef = resultRef || ref;
      if (targetRef) {
        const fontDict = context.lookup(targetRef) as any;
        if (fontDict && !fontDict.get(PDFName.of('ToUnicode'))) {
          const cmap = createWinAnsiToUnicodeCMap();
          const cmapStream = context.flateStream(cmap);
          const cmapRef = context.register(cmapStream);
          fontDict.set(PDFName.of('ToUnicode'), cmapRef);
        }
      }
      return resultRef;
    };
  }
}

/**
 * Serializes text code points to exact 4-character hex strings (<XXXX>) without UTF-16BE BOM.
 * Encodes BMP characters as <XXXX> and astral plane characters (> 0xFFFF) as high/low surrogate pairs <XXXXYYYY>.
 */
export function encodeUnicodeTo4CharHex(text: string): string {
  let hex = '';
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp <= 0xffff) {
      hex += cp.toString(16).padStart(4, '0').toUpperCase();
    } else {
      const high = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
      const low = ((cp - 0x10000) % 0x400) + 0xdc00;
      hex +=
        high.toString(16).padStart(4, '0').toUpperCase() +
        low.toString(16).padStart(4, '0').toUpperCase();
    }
  }
  return hex;
}

/**
 * Encodes text safely for PDF invisible text layer embedding.
 * Preserves CJK (Korean, Chinese, Japanese) and extended Unicode code points
 * by serializing into exact 4-character hex strings without BOM (<XXXX>) conforming to ISO 32000-1.
 */
export function safeEncodeText(font: PDFFont, text: string): PDFHexString | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) {
    if (text.length > 0) {
      try {
        return font.encodeText(text);
      } catch {
        return PDFHexString.of(encodeUnicodeTo4CharHex(text));
      }
    }
    return null;
  }

  // Check if text contains non-WinAnsi code points (CJK, symbols, Cyrillic, etc.)
  let hasNonWinAnsi = false;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255))) {
      hasNonWinAnsi = true;
      break;
    }
  }

  if (hasNonWinAnsi) {
    return PDFHexString.of(encodeUnicodeTo4CharHex(trimmed));
  }

  try {
    return font.encodeText(trimmed);
  } catch {
    return PDFHexString.of(encodeUnicodeTo4CharHex(trimmed));
  }
}

/**
 * Computes an ISO 32000-1 2D affine skew/rotation transformation matrix
 * [cos(θ), sin(θ), -sin(θ), cos(θ), x, y] cm for rotated or skewed OCR bounding boxes.
 */
export function computeAffineTransformationMatrix(
  bbox: OcrBBox,
  pageHeight: number,
  scaleX: number = 1.0,
  scaleY: number = 1.0
): [number, number, number, number, number, number] {
  const scaledX = bbox.x * scaleX;
  const scaledY = pageHeight - (bbox.y + bbox.height) * scaleY;

  // Resolve rotation angle in radians (all OCR angle/rotation properties default to degrees)
  let theta = 0;
  if (bbox.rotationRadians !== undefined) {
    theta = bbox.rotationRadians;
  } else if (bbox.rotationDegrees !== undefined) {
    theta = (bbox.rotationDegrees * Math.PI) / 180;
  } else if (bbox.rotation !== undefined) {
    theta = (bbox.rotation * Math.PI) / 180;
  } else if (bbox.angle !== undefined) {
    theta = (bbox.angle * Math.PI) / 180;
  }

  // Resolve skew angles in radians (skewX = horizontal shear, skewY = vertical shear)
  const skewX = bbox.skewX ?? 0;
  const skewY = bbox.skewY ?? 0;

  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const tanSkewX = Math.tan(skewX);
  const tanSkewY = Math.tan(skewY);

  // 2D Affine concatenation: R(θ) * S(skewX, skewY)
  // R = [cosθ, sinθ; -sinθ, cosθ], S = [1, tan(skewY); tan(skewX), 1]
  const a = cosT + tanSkewX * sinT;
  const b = sinT + tanSkewY * cosT;
  const c = -sinT + tanSkewX * cosT;
  const d = cosT - tanSkewY * sinT;
  const e = scaledX;
  const f = scaledY;

  return [a, b, c, d, e, f];
}

/**
 * Builds an ISO 32000-1 TJ array operator and word spacing (Tw) parameter
 * with character kerning offsets between words or characters.
 */
export function buildTJArrayWithKerning(
  doc: PDFDocument,
  font: PDFFont,
  words: Array<{ text: string; bbox?: OcrBBox }>,
  fontSize: number,
  tz: number = 100,
  scaleX: number = 1.0,
  originX: number = 0
): { tjArray: any; wordSpacing: number; activeFontName: string } {
  const tjArray = PDFArray.withContext(doc.context);
  let activeFontName = font.name;

  // Determine if any word contains non-WinAnsi / CJK characters
  let hasNonWinAnsi = false;
  for (const w of words) {
    for (let i = 0; i < w.text.length; i++) {
      const code = w.text.charCodeAt(i);
      if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255))) {
        hasNonWinAnsi = true;
        break;
      }
    }
    if (hasNonWinAnsi) break;
  }

  let unicodeFont: UnicodeFontInfo | null = null;
  if (hasNonWinAnsi) {
    unicodeFont = ensureUnicodeFont(doc);
    activeFontName = unicodeFont.fontName;
  } else {
    ensureStandardFontToUnicode(doc, font);
    activeFontName = font.name;
  }

  const spaceWidthPt = hasNonWinAnsi
    ? fontSize * 0.5 * (tz / 100)
    : font.widthOfTextAtSize(' ', fontSize) * (tz / 100);

  // Compute gaps between words
  const gaps: number[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const w0 = words[i];
    const w1 = words[i + 1];
    if (w0.bbox && w1.bbox && w1.bbox.x > w0.bbox.x) {
      const gap = Math.max(0, (w1.bbox.x - (w0.bbox.x + w0.bbox.width)) * scaleX);
      gaps.push(gap > 0 ? gap : spaceWidthPt);
    } else {
      gaps.push(spaceWidthPt);
    }
  }

  // Calculate word spacing (Tw).
  // Note: ISO 32000-1 §9.3.3 specifies that Tw is ignored for composite fonts (Type 0 / CIDFonts).
  // For Type 0 fonts, all spacing adjustments are expressed directly in the TJ kerning array.
  let wordSpacing = 0;
  if (!hasNonWinAnsi && gaps.length > 0) {
    const avgGap = gaps.reduce((acc, g) => acc + g, 0) / gaps.length;
    // Tw is in unscaled text-space units (scaled by tz / 100 when rendered in user space)
    wordSpacing = Math.max(0, (avgGap - spaceWidthPt) / (tz / 100));
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const trimmed = w.text.trim();
    if (!trimmed) continue;

    // Relative X offset for the first word if originX is specified
    if (i === 0 && w.bbox && originX > 0 && w.bbox.x * scaleX > originX) {
      const leadingGap = Math.max(0, w.bbox.x * scaleX - originX);
      if (leadingGap > 1) {
        const leadingKerning = -Math.round((leadingGap * 1000) / (fontSize * (tz / 100)));
        if (leadingKerning !== 0) {
          tjArray.push(PDFNumber.of(leadingKerning));
        }
      }
    }

    // Word text encoded
    if (unicodeFont) {
      tjArray.push(PDFHexString.of(unicodeFont.encodeText(trimmed)));
    } else {
      const enc = safeEncodeText(font, trimmed);
      if (enc) tjArray.push(enc);
    }

    // Gap to next word
    if (i < words.length - 1) {
      // Push explicit space glyph to ensure PDF viewers copy text with spaces
      if (unicodeFont) {
        tjArray.push(PDFHexString.of(unicodeFont.encodeText(' ')));
      } else {
        const spaceEnc = safeEncodeText(font, ' ');
        if (spaceEnc) tjArray.push(spaceEnc);
      }

      // Compute kerning offset for this specific gap
      const gap = gaps[i];
      const residual = gap - spaceWidthPt - wordSpacing * (tz / 100);
      if (Math.abs(residual) >= 0.1) {
        const kerning = -Math.round((residual * 1000) / (fontSize * (tz / 100)));
        if (kerning !== 0) {
          tjArray.push(PDFNumber.of(kerning));
        }
      }
    }
  }

  return { tjArray, wordSpacing, activeFontName };
}

/**
 * Returns the page's /Resources /Font key for an embedded font, registering the font on the page
 * once. Tf must name this key, not the font's BaseFont name, or readers cannot select the font.
 */
function resolveFontResourceKey(page: PDFPage, font: PDFFont): string {
  const { Font } = page.node.normalizedEntries();
  for (const [key, value] of Font.entries()) {
    if (value === font.ref) {
      return key.decodeText();
    }
  }
  return page.node.newFontDictionary(font.name, font.ref).decodeText();
}

function emitInvisibleTextOperators(
  page: PDFPage,
  font: PDFFont,
  matrix: [number, number, number, number, number, number],
  activeFontName: string,
  fontSize: number,
  wordSpacing: number,
  tz: number,
  showTextOp: any
): void {
  // The standard font is selected by its page resource key; the Unicode font registers itself
  // under its own name through registerFontOnPage.
  const fontResourceName = activeFontName === font.name ? resolveFontResourceKey(page, font) : activeFontName;
  const [a, b, c, d, e, f] = matrix;
  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.ConcatTransformationMatrix, [
      PDFNumber.of(Number(a.toFixed(6))),
      PDFNumber.of(Number(b.toFixed(6))),
      PDFNumber.of(Number(c.toFixed(6))),
      PDFNumber.of(Number(d.toFixed(6))),
      PDFNumber.of(Number(e.toFixed(4))),
      PDFNumber.of(Number(f.toFixed(4))),
    ]),
    setTextRenderingMode(TextRenderingMode.Invisible), // 3 Tr
    beginText(),
    setFontAndSize(fontResourceName, fontSize),
    PDFOperator.of(PDFOperatorNames.SetWordSpacing, [PDFNumber.of(Number(wordSpacing.toFixed(3)))]), // Tw
    PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(Math.round(tz))]), // Tz
    setTextMatrix(1, 0, 0, 1, 0, 0), // 1 0 0 1 0 0 Tm
    showTextOp,
    endText(),
    popGraphicsState()
  );
}

/**
 * Renders an OCR line block with ISO 32000-1 compliant word spacing (Tw)
 * and TJ array operator with character kerning offsets, positioned using
 * a 2D affine skew/rotation transformation matrix ([cos(θ), sin(θ), -sin(θ), cos(θ), x, y] cm).
 */
export function renderLineBlockWithSpacing(
  page: PDFPage,
  font: PDFFont,
  block: OcrLineBlock,
  pageHeight: number,
  scaleX: number = 1.0,
  scaleY: number = 1.0
): void {
  const safeScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1.0;
  const safeScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1.0;
  const scaledWidth = Math.max(1, block.bbox.width * safeScaleX);
  const scaledHeight = Math.max(1, block.bbox.height * safeScaleY);
  const maxAvailableWidth = Math.max(10, page.getSize().width - block.bbox.x * safeScaleX - 5);
  const targetWidth = Math.min(scaledWidth, maxAvailableWidth);

  const words =
    block.words && block.words.length > 0
      ? block.words.filter((w) => w.text.trim().length > 0)
      : block.text
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => ({ text: t, bbox: block.bbox }));

  if (words.length === 0) return;

  // Estimate typography units (1000 per em): CJK = 1000, Latin = 500, space = 300
  let estUnits = 0;
  for (const w of words) {
    // per code point, as the text layer font advances (an astral character is one glyph)
    for (const ch of w.text) estUnits += glyphAdvanceForCodePoint(ch.codePointAt(0) as number);
  }
  estUnits += Math.max(0, words.length - 1) * 300;

  const maxFontForWidth = estUnits > 0 ? (targetWidth / estUnits) * 1000 : 72;
  const maxFontForHeight = scaledHeight * 0.85;
  const validFontH = Number.isFinite(maxFontForHeight) && maxFontForHeight > 0 ? maxFontForHeight : 12;
  const validFontW = Number.isFinite(maxFontForWidth) && maxFontForWidth > 0 ? maxFontForWidth : 72;
  const fontSize = Math.max(6, Math.min(72, validFontH, validFontW));

  const estimatedWidth = (estUnits / 1000) * fontSize;
  let tz = 100;
  if (estimatedWidth > 0 && targetWidth > 0) {
    tz = Math.max(70, Math.min(130, (targetWidth / estimatedWidth) * 100));
  }

  const originX = block.bbox.x * safeScaleX;
  const { tjArray, wordSpacing, activeFontName } = buildTJArrayWithKerning(
    page.doc,
    font,
    words,
    fontSize,
    tz,
    safeScaleX,
    originX
  );

  if (activeFontName === ensureUnicodeFont(page.doc).fontName) {
    const unicodeFont = ensureUnicodeFont(page.doc);
    registerFontOnPage(page, unicodeFont);
  }

  const matrix = computeAffineTransformationMatrix(
    block.bbox,
    pageHeight,
    safeScaleX,
    safeScaleY
  );

  emitInvisibleTextOperators(
    page,
    font,
    matrix,
    activeFontName,
    fontSize,
    wordSpacing,
    tz,
    PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [tjArray])
  );
}

/**
 * Embeds an invisible text element on a PDF page with accurate positioning and metrics.
 */
export function embedInvisibleText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  bbox: OcrBBox,
  pageHeight: number,
  scaleX: number = 1.0,
  scaleY: number = 1.0
): void {
  renderTextItem(page, font, text, bbox, pageHeight, scaleX, scaleY);
}

export function renderTextItem(
  page: PDFPage,
  font: PDFFont,
  text: string,
  bbox: OcrBBox,
  pageHeight: number,
  scaleX: number,
  scaleY: number
): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    renderLineBlockWithSpacing(
      page,
      font,
      { text: trimmed, bbox, words: words.map((w) => ({ text: w, bbox })) },
      pageHeight,
      scaleX,
      scaleY
    );
    return;
  }

  const scaledWidth = bbox.width * scaleX;
  const scaledHeight = bbox.height * scaleY;
  const fontSize = Math.max(6, Math.min(72, scaledHeight * 0.85));

  let hasNonWinAnsi = false;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255))) {
      hasNonWinAnsi = true;
      break;
    }
  }

  ensureStandardFontToUnicode(page.doc, font);
  let activeFontName = font.name;
  let encodedText: PDFHexString | null = null;
  let tz = 100;

  if (hasNonWinAnsi) {
    const unicodeFont = ensureUnicodeFont(page.doc);
    registerFontOnPage(page, unicodeFont);
    activeFontName = unicodeFont.fontName;
    encodedText = PDFHexString.of(unicodeFont.encodeText(trimmed));

    let estimatedWidth = 0;
    for (const ch of trimmed) {
      estimatedWidth += (glyphAdvanceForCodePoint(ch.codePointAt(0) as number) / GLYPH_UNITS_PER_EM) * fontSize;
    }
    const maxAvailableWidth = Math.max(10, page.getSize().width - bbox.x * scaleX - 5);
    const targetWidth = Math.min(scaledWidth, maxAvailableWidth);
    if (estimatedWidth > 0 && targetWidth > 0) {
      tz = Math.max(70, Math.min(130, (targetWidth / estimatedWidth) * 100));
    }
  } else {
    encodedText = safeEncodeText(font, trimmed);
    try {
      const rawWidth = font.widthOfTextAtSize(trimmed, fontSize);
      if (rawWidth > 0 && scaledWidth > 0) {
        const maxAvailableWidth = Math.max(10, page.getSize().width - bbox.x * scaleX - 5);
        const targetWidth = Math.min(scaledWidth, maxAvailableWidth);
        tz = Math.max(70, Math.min(130, (targetWidth / rawWidth) * 100));
      }
    } catch {
      tz = 100;
    }
  }

  if (!encodedText) return;

  const matrix = computeAffineTransformationMatrix(bbox, pageHeight, scaleX, scaleY);

  emitInvisibleTextOperators(
    page,
    font,
    matrix,
    activeFontName,
    fontSize,
    0,
    tz,
    showText(encodedText)
  );
}

/**
 * Injects an invisible searchable text layer into a PDF page's /Contents stream.
 * Uses PDF rendering mode 3 (3 Tr = Neither fill nor stroke), horizontal scaling (Tz),
 * word spacing (Tw / TJ array operator with character kerning offsets),
 * and 2D affine transformation matrices ([cos(θ), sin(θ), -sin(θ), cos(θ), x, y] cm).
 */
export function injectInvisibleTextLayer(
  page: PDFPage,
  font: PDFFont,
  ocrResult: OcrResult,
  scaleX: number = 1.0,
  scaleY: number = 1.0
): void {
  const safeScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1.0;
  const safeScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1.0;
  const { height: pageHeight, width: pageWidth } = page.getSize();
  const rawBlocks = ocrResult.lineBlocks || [];
  const blocks = sortLineBlocksTopological(rawBlocks, pageWidth, pageHeight);

  if (blocks.length > 0) {
    for (const block of blocks) {
      if (!block.text) continue;
      renderLineBlockWithSpacing(page, font, block, pageHeight, safeScaleX, safeScaleY);
    }
  } else if (ocrResult.lines && ocrResult.lines.length > 0) {
    // Fallback: estimate equidistant text lines
    const lineCount = ocrResult.lines.length;
    const lineHeight = Math.min(24, pageHeight / (lineCount + 2));

    for (let i = 0; i < lineCount; i++) {
      const lineText = ocrResult.lines[i];
      if (!lineText.trim()) continue;

      const y = 40 + i * lineHeight;
      renderLineBlockWithSpacing(
        page,
        font,
        {
          text: lineText,
          bbox: { x: 40, y, width: Math.max(10, pageWidth - 80), height: lineHeight },
          words: [],
        },
        pageHeight,
        safeScaleX,
        safeScaleY
      );
    }
  }
}

/**
 * Generates an authentic Lossless Sandwich PDF directly from an existing PDF document.
 * Preserves 100% of the original PDF's metadata, objects, vector artwork, annotations,
 * and compression streams while non-destructively injecting transparent text layers.
 */
export async function createLosslessSandwichPdfFromPdf(
  originalPdfBuffer: Buffer,
  pageOcrResults: Map<number, OcrResult>
): Promise<Buffer> {
  const doc = await PDFDocument.load(originalPdfBuffer);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const numPages = doc.getPageCount();
  for (let i = 0; i < numPages; i++) {
    const pageNum = i + 1;
    const ocrResult = pageOcrResults.get(pageNum);
    if (!ocrResult) continue;

    const page = doc.getPage(i);
    const { width: pageWidth, height: pageHeight } = page.getSize();

    const imgWidth = ocrResult.imageWidth || pageWidth;
    const imgHeight = ocrResult.imageHeight || pageHeight;

    const scaleX = pageWidth / imgWidth;
    const scaleY = pageHeight / imgHeight;

    injectInvisibleTextLayer(page, font, ocrResult, scaleX, scaleY);
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Generates a Lossless Sandwich PDF from a single scanned bitmap image.
 * Uses pdf-lib (zero PDFKit reliance) to embed the visual bitmap at full fidelity
 * and layer invisible searchable text on top with millimetric accuracy.
 */
export async function createLosslessSandwichPdfFromImage(
  scannedImageBuffer: Buffer | Uint8Array,
  ocrResult: OcrResult,
  options: ConversionOptions = {},
  title: string = 'Searchable Document'
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('EasyConvert Lossless Sandwich PDF Engine');

  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Embed image: try PNG or JPG based on magic bytes
  const isJpg =
    scannedImageBuffer.length > 3 &&
    scannedImageBuffer[0] === 0xff &&
    scannedImageBuffer[1] === 0xd8 &&
    scannedImageBuffer[2] === 0xff;

  let embeddedImage;
  if (isJpg) {
    embeddedImage = await doc.embedJpg(scannedImageBuffer);
  } else {
    embeddedImage = await doc.embedPng(scannedImageBuffer);
  }

  const imgWidth = embeddedImage.width || ocrResult.imageWidth || 595.28;
  const imgHeight = embeddedImage.height || ocrResult.imageHeight || 841.89;

  const page = doc.addPage([imgWidth, imgHeight]);
  page.drawImage(embeddedImage, {
    x: 0,
    y: 0,
    width: imgWidth,
    height: imgHeight,
  });

  injectInvisibleTextLayer(page, font, ocrResult, 1.0, 1.0);

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}
