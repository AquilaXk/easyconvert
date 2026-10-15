/**
 * Recursive XY-Cut+ Document Layout Analysis (DLA) Engine
 *
 * Implements:
 * 1. Recursive spatial projection profile analysis across horizontal (X) and vertical (Y) axes (Ha, Haralick 1995).
 * 2. Multi-column document layout decomposition and column boundary discovery.
 * 3. Topological reading order determination (Header -> Col 1 Top-Down -> Col 2 Top-Down -> Footer).
 * 4. Semantic block classification (heading, paragraph, table, figure, caption, header, footer).
 */

export interface DlaBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  confidence?: number;
  fontSize?: number;
  isBold?: boolean;
}

export type DlaBlockType =
  | 'header'
  | 'footer'
  | 'heading'
  | 'paragraph'
  | 'list_item'
  | 'table'
  | 'figure'
  | 'caption';

export interface DlaBlock {
  id: string;
  type: DlaBlockType;
  bbox: DlaBoundingBox;
  text: string;
  /** Mean confidence of the boxes the block was built from; absent when none of them carries one. */
  confidence?: number;
  readingOrder: number;
  columnIndex: number;
  lineCount: number;
  items?: DlaBoundingBox[];
}

export interface DlaPageLayout {
  pageNumber: number;
  width: number;
  height: number;
  columnCount: number;
  blocks: DlaBlock[];
  fullText: string;
}

/** Mean of the confidences the boxes carry, or undefined when none does; nothing is made up. */
function meanBoxConfidence(boxes: readonly DlaBoundingBox[]): number | undefined {
  const confidences = boxes.map((b) => b.confidence).filter((c): c is number => typeof c === 'number');
  if (confidences.length === 0) return undefined;
  return confidences.reduce((a, b) => a + b, 0) / confidences.length;
}

export interface DlaOptions {
  minColumnGap?: number;
  minParagraphGap?: number;
  headerRatio?: number;
  footerRatio?: number;
}

/**
 * Computes bounding box enclosing all input boxes.
 */
function computeEnclosingBox(boxes: DlaBoundingBox[]): DlaBoundingBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

/**
 * Finds projection valleys (zero-occupancy gaps) along an axis.
 */
function findValleys(
  projection: number[],
  minGap: number
): { start: number; end: number; mid: number }[] {
  const valleys: { start: number; end: number; mid: number }[] = [];
  let inGap = false;
  let gapStart = 0;

  for (let i = 0; i < projection.length; i++) {
    const isOccupied = projection[i] > 0;
    if (!isOccupied && !inGap) {
      inGap = true;
      gapStart = i;
    } else if (isOccupied && inGap) {
      inGap = false;
      const gapWidth = i - gapStart;
      if (gapWidth >= minGap) {
        valleys.push({
          start: gapStart,
          end: i,
          mid: Math.floor((gapStart + i) / 2),
        });
      }
    }
  }

  return valleys;
}

/**
 * Recursive XY-Cut tree node
 */
interface XyNode {
  bbox: DlaBoundingBox;
  boxes: DlaBoundingBox[];
  children?: XyNode[];
  cutDirection?: 'X' | 'Y' | 'LEAF';
}

/**
 * Executes recursive XY-Cut on a collection of bounding boxes within a rectangular region.
 */
function recursiveXyCut(
  boxes: DlaBoundingBox[],
  region: DlaBoundingBox,
  minColGap: number,
  minRowGap: number,
  depth: number = 0
): XyNode {
  if (boxes.length <= 1 || depth > 10) {
    return {
      bbox: computeEnclosingBox(boxes),
      boxes,
      cutDirection: 'LEAF',
    };
  }

  const w = Math.ceil(region.width);
  const h = Math.ceil(region.height);
  if (w <= 0 || h <= 0) {
    return { bbox: region, boxes, cutDirection: 'LEAF' };
  }

  // 1. Try X-Cut (Vertical projection to find columns)
  const xProj = new Array(w).fill(0);
  for (const b of boxes) {
    const startX = Math.max(0, Math.floor(b.x - region.x));
    const endX = Math.min(w, Math.ceil(b.x + b.width - region.x));
    for (let x = startX; x < endX; x++) {
      xProj[x]++;
    }
  }

  const xValleys = findValleys(xProj, minColGap);
  if (xValleys.length > 0) {
    // Partition boxes by X cuts
    const cuts = [0, ...xValleys.map((v) => v.mid), w];
    const children: XyNode[] = [];

    for (let c = 0; c < cuts.length - 1; c++) {
      const segStart = region.x + cuts[c];
      const segEnd = region.x + cuts[c + 1];
      const segBoxes = boxes.filter(
        (b) => b.x + b.width / 2 >= segStart && b.x + b.width / 2 < segEnd
      );

      if (segBoxes.length > 0) {
        const segRegion: DlaBoundingBox = {
          x: segStart,
          y: region.y,
          width: segEnd - segStart,
          height: region.height,
        };
        children.push(
          recursiveXyCut(segBoxes, segRegion, minColGap, minRowGap, depth + 1)
        );
      }
    }

    if (children.length > 1) {
      return {
        bbox: computeEnclosingBox(boxes),
        boxes,
        children,
        cutDirection: 'X',
      };
    }
  }

  // 2. Try Y-Cut (Horizontal projection to find rows / paragraphs)
  const yProj = new Array(h).fill(0);
  for (const b of boxes) {
    const startY = Math.max(0, Math.floor(b.y - region.y));
    const endY = Math.min(h, Math.ceil(b.y + b.height - region.y));
    for (let y = startY; y < endY; y++) {
      yProj[y]++;
    }
  }

  const yValleys = findValleys(yProj, minRowGap);
  if (yValleys.length > 0) {
    const cuts = [0, ...yValleys.map((v) => v.mid), h];
    const children: XyNode[] = [];

    for (let c = 0; c < cuts.length - 1; c++) {
      const segStart = region.y + cuts[c];
      const segEnd = region.y + cuts[c + 1];
      const segBoxes = boxes.filter(
        (b) => b.y + b.height / 2 >= segStart && b.y + b.height / 2 < segEnd
      );

      if (segBoxes.length > 0) {
        const segRegion: DlaBoundingBox = {
          x: region.x,
          y: segStart,
          width: region.width,
          height: segEnd - segStart,
        };
        children.push(
          recursiveXyCut(segBoxes, segRegion, minColGap, minRowGap, depth + 1)
        );
      }
    }

    if (children.length > 1) {
      return {
        bbox: computeEnclosingBox(boxes),
        boxes,
        children,
        cutDirection: 'Y',
      };
    }
  }

  // Atomic leaf block
  return {
    bbox: computeEnclosingBox(boxes),
    boxes,
    cutDirection: 'LEAF',
  };
}

/**
 * Collects leaf blocks from the XY-Cut tree.
 */
function collectLeafNodes(node: XyNode): DlaBoundingBox[][] {
  if (node.cutDirection === 'LEAF' || !node.children || node.children.length === 0) {
    return [node.boxes];
  }

  const leaves: DlaBoundingBox[][] = [];
  for (const child of node.children) {
    leaves.push(...collectLeafNodes(child));
  }
  return leaves;
}

/**
 * Analyzes and extracts Document Layout Analysis (DLA) structure from a page.
 */
export function analyzeDocumentLayout(
  boxes: DlaBoundingBox[],
  pageWidth: number,
  pageHeight: number,
  options: DlaOptions = {}
): DlaPageLayout {
  if (boxes.length === 0) {
    return {
      pageNumber: 1,
      width: pageWidth,
      height: pageHeight,
      columnCount: 1,
      blocks: [],
      fullText: '',
    };
  }

  const {
    minColumnGap = 20,
    minParagraphGap = 10,
    headerRatio = 0.08,
    footerRatio = 0.08,
  } = options;

  const headerCutoff = pageHeight * headerRatio;
  const footerCutoff = pageHeight * (1.0 - footerRatio);

  // 1. Separate headers and footers from main body content
  const headerBoxes: DlaBoundingBox[] = [];
  const footerBoxes: DlaBoundingBox[] = [];
  const bodyBoxes: DlaBoundingBox[] = [];

  for (const b of boxes) {
    const centerY = b.y + b.height / 2;
    if (centerY <= headerCutoff) {
      headerBoxes.push(b);
    } else if (centerY >= footerCutoff) {
      footerBoxes.push(b);
    } else {
      bodyBoxes.push(b);
    }
  }

  // 2. Perform Recursive XY-Cut on body content
  const pageBox: DlaBoundingBox = {
    x: 0,
    y: headerCutoff,
    width: pageWidth,
    height: footerCutoff - headerCutoff,
  };

  const xyTree = recursiveXyCut(bodyBoxes, pageBox, minColumnGap, minParagraphGap);
  const leafClusters = collectLeafNodes(xyTree);

  function findMaxColumns(node: XyNode): number {
    let max = node.cutDirection === 'X' && node.children ? node.children.length : 1;
    if (node.children) {
      for (const child of node.children) {
        max = Math.max(max, findMaxColumns(child));
      }
    }
    return max;
  }

  const detectedColumns = findMaxColumns(xyTree);

  // 4. Assemble semantic DLA blocks
  const allBlocks: DlaBlock[] = [];
  let blockCounter = 1;

  // 4a. Header block
  if (headerBoxes.length > 0) {
    const sorted = [...headerBoxes].sort((a, b) => a.x - b.x);
    const text = sorted.map((b) => b.text || '').filter(Boolean).join(' ');
    allBlocks.push({
      id: `block_header_${blockCounter++}`,
      type: 'header',
      bbox: computeEnclosingBox(headerBoxes),
      text,
      confidence: meanBoxConfidence(headerBoxes),
      readingOrder: 1,
      columnIndex: 0,
      lineCount: 1,
      items: sorted,
    });
  }

  // 4b. Body blocks sorted by reading order: Column left-to-right, then Y top-to-bottom
  const clusterBoxesWithMeta = leafClusters
    .filter((cluster) => cluster.length > 0)
    .map((cluster) => {
      const bbox = computeEnclosingBox(cluster);
      const colIdx = Math.min(
        detectedColumns - 1,
        Math.floor((bbox.x / pageWidth) * detectedColumns)
      );
      return { cluster, bbox, colIdx };
    });

  // Sort by Column first, then Y position
  clusterBoxesWithMeta.sort((a, b) => {
    if (a.colIdx !== b.colIdx) return a.colIdx - b.colIdx;
    return a.bbox.y - b.bbox.y;
  });

  // Calculate median font size for heading classification
  const fontSizes = boxes
    .map((b) => b.fontSize)
    .filter((s): s is number => typeof s === 'number' && s > 0);
  const medianFontSize =
    fontSizes.length > 0
      ? fontSizes.sort((a, b) => a - b)[Math.floor(fontSizes.length / 2)]
      : 12;

  for (const { cluster, bbox, colIdx } of clusterBoxesWithMeta) {
    // Sort cluster items into reading lines
    const sortedItems = [...cluster].sort((a, b) => {
      const dy = a.y - b.y;
      if (Math.abs(dy) > 4) return dy;
      return a.x - b.x;
    });

    const text = sortedItems
      .map((b) => b.text || '')
      .filter(Boolean)
      .join(' ')
      .trim();

    if (!text) continue;

    // Semantic block classification
    let type: DlaBlockType = 'paragraph';
    const firstItem = sortedItems[0];

    if (
      (firstItem.fontSize && firstItem.fontSize >= medianFontSize * 1.25) ||
      (firstItem.isBold && sortedItems.length <= 2 && text.length < 80)
    ) {
      type = 'heading';
    } else if (text.startsWith('•') || text.startsWith('-') || /^\d+\.\s/.test(text)) {
      type = 'list_item';
    } else if (
      sortedItems.length >= 4 &&
      Math.abs(bbox.width - pageWidth * 0.8) < 100 &&
      sortedItems.some((s) => s.text?.includes('|') || s.text?.includes('\t'))
    ) {
      type = 'table';
    }

    const avgConfidence = meanBoxConfidence(sortedItems);

    allBlocks.push({
      id: `block_${blockCounter++}`,
      type,
      bbox,
      text,
      confidence: avgConfidence,
      readingOrder: allBlocks.length + 1,
      columnIndex: colIdx,
      lineCount: Math.max(1, Math.round(bbox.height / Math.max(8, medianFontSize * 1.2))),
      items: sortedItems,
    });
  }

  // 4c. Footer block
  if (footerBoxes.length > 0) {
    const sorted = [...footerBoxes].sort((a, b) => a.x - b.x);
    const text = sorted.map((b) => b.text || '').filter(Boolean).join(' ');
    allBlocks.push({
      id: `block_footer_${blockCounter++}`,
      type: 'footer',
      bbox: computeEnclosingBox(footerBoxes),
      text,
      confidence: meanBoxConfidence(footerBoxes),
      readingOrder: allBlocks.length + 1,
      columnIndex: 0,
      lineCount: 1,
      items: sorted,
    });
  }

  // Re-assign 1-based sequential reading order
  allBlocks.forEach((block, idx) => {
    block.readingOrder = idx + 1;
  });

  const fullText = allBlocks.map((b) => b.text).join('\n\n');

  return {
    pageNumber: 1,
    width: pageWidth,
    height: pageHeight,
    columnCount: detectedColumns,
    blocks: allBlocks,
    fullText,
  };
}
