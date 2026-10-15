import type { Raster } from './vector-raster';

/**
 * Geometric agreement of a rendered CAD drawing with the stroke geometry it was written from. The truth is a list of
 * polylines in drawing units (bench/corpus/cad/*.truth.json, written by bench/corpus/generate-vector-cad.ts from the
 * entity list of the DXF, or returned by `cad.truth` of bench/reference-server.py for the public drawings), so the score
 * depends on neither the conversion engine nor the reference renderer.
 *
 * The score knows nothing about how a renderer draws: not its colours, line weight, page, margin or scale. Ink is every
 * pixel that differs from the page background by more than a fixed distance, whatever its colour, so a drawing in any
 * palette, light on dark included, is read the same. The same function scores the product and the reference tool.
 *
 * The drawing is compared in its own frame. A renderer may put text, a title block or a margin around the strokes, so
 * the box of all ink is not the box of the strokes. The frame (position and scale per axis) is fitted instead: it is the
 * one that puts the truth strokes on ink, a registration of the truth onto the picture that uses no colour. The search
 * starts from the box of all ink and, when something spans that box (a page border drawn around the drawing), also from
 * the box of the biggest component that does not; the better fit wins. Then
 * - recall is the share of truth stroke pixels with drawn pixels within a tolerance (an entity left out costs recall),
 * - precision is the share of drawn pixels with a truth stroke within the tolerance (a stray or shifted mark costs
 *   precision); ink inside a text box that is on no stroke is text and is left out of the share, up to the coverage a
 *   line of glyphs can have (GLYPH_COVERAGE_MAX of the box); ink beyond that is not text and is charged,
 * - extent error is how far the drawn aspect ratio (scale of x against scale of y) is from the truth's (a stretched page
 *   shows). The frame never flips, so a mirrored or rotated page shows in recall and precision instead.
 * Recall counts a truth stroke outside the text boxes only where there is ink that is not inside a text box, so text
 * cannot stand in for a missing stroke.
 * The tolerance is a small dilation (1% of the drawing, at least two pixels), applied in both directions.
 * A truth that has nothing to register (no strokes, no length, or all strokes on one horizontal or vertical line) scores
 * as nothing drawn, for the product and the reference tool alike.
 */

export interface CadTruth {
  /** Every drawn outline as a polyline of [x, y] in drawing units, y pointing up. */
  strokes: Array<Array<[number, number]>>;
  /** Boxes of text [minX, minY, maxX, maxY] in drawing units; ink inside them that is not on a stroke is taken for glyphs, up to GLYPH_COVERAGE_MAX of the box. */
  textBoxes: Array<[number, number, number, number]>;
  words: string[];
}

export interface InkScore {
  precision: number;
  recall: number;
  extentError: number;
}

/** A pixel differs from the page background by more than this in its most different channel to count as drawn. */
const INK_THRESHOLD = 48;
const TOLERANCE_SHARE = 0.01;
const MIN_TOLERANCE_PX = 2;
const TEXT_BOX_GROWTH = 0.3;
/**
 * The most ink of a grown text box (share of its area) that is taken for glyphs when it is on no truth stroke. Measured on
 * the renders of the corpus (14 drawings, three output formats, the product and the reference tool; 37 renders with text
 * and 1260 text boxes carrying such ink): median 5%, 90th percentile 10%, 99th percentile 20%, largest 22%. A solid box
 * is 100%.
 */
const GLYPH_COVERAGE_MAX = 0.25;
const SAMPLE_STEP_PX = 0.5;
const MAX_PRECISION_SAMPLES = 20_000;
const NOTHING_DRAWN: InkScore = { precision: 0, recall: 0, extentError: 1 };

/** Registration: points of the truth, and how far a frame edge may lie from the box of all ink (share of that box's size). */
const REGISTRATION_POINTS = 3000;
const EDGE_INWARD_LIMIT = 0.4;
const EDGE_OUTWARD_LIMIT = 0.05;
/** Preference for the edges of the start box when two frames fit equally well (cost per share of the ink box's size). */
const EDGE_PRIOR = 1e-4;
/** A component that reaches this share of the ink box on both axes spans it (a page border, or the outline of the drawing). */
const SPANNING_SHARE = 0.98;
const COARSE_STEPS = 48;
const FINE_STEPS = 16;
const SWEEPS_PER_STAGE = 2;
/** Registration stages: the distance beyond which a truth point counts as off ink (share of the box) and the reach of an edge move. */
const STAGES: ReadonlyArray<{ capShare: number; reach: number }> = [
  { capShare: 0.05, reach: Number.POSITIVE_INFINITY },
  { capShare: 0.02, reach: 0.05 },
  { capShare: 0.008, reach: 0.015 },
  { capShare: 0.003, reach: 0.004 },
];

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Where the box of the truth strokes lies in the picture, in pixels. */
interface Frame {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Edge = keyof Frame;
const EDGES: readonly Edge[] = ['left', 'right', 'top', 'bottom'];

/** The most common colour of the picture, which is the page. */
function pageColour(raster: Raster): [number, number, number] {
  const counts = new Map<number, number>();
  const pixels = raster.width * raster.height;
  for (let i = 0; i < pixels; i++) {
    const key = (raster.rgb[i * 3] << 16) | (raster.rgb[i * 3 + 1] << 8) | raster.rgb[i * 3 + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let page = 0;
  let most = -1;
  for (const [key, count] of counts) {
    if (count > most) {
      page = key;
      most = count;
    }
  }
  return [(page >> 16) & 0xff, (page >> 8) & 0xff, page & 0xff];
}

function inkMask(raster: Raster): Uint8Array {
  const [pageR, pageG, pageB] = pageColour(raster);
  const mask = new Uint8Array(raster.width * raster.height);
  for (let i = 0; i < mask.length; i++) {
    const difference = Math.max(Math.abs(raster.rgb[i * 3] - pageR), Math.abs(raster.rgb[i * 3 + 1] - pageG), Math.abs(raster.rgb[i * 3 + 2] - pageB));
    mask[i] = difference > INK_THRESHOLD ? 1 : 0;
  }
  return mask;
}

function inkBox(mask: Uint8Array, width: number, height: number): Box | null {
  let box: Box | null = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      box = box === null ? { minX: x, minY: y, maxX: x, maxY: y } : { minX: Math.min(box.minX, x), minY: Math.min(box.minY, y), maxX: Math.max(box.maxX, x), maxY: Math.max(box.maxY, y) };
    }
  }
  return box;
}

/** The box of the truth strokes, or null when it has no width or no height: there is then no frame to register. */
function strokeBox(truth: CadTruth): Box | null {
  const points = truth.strokes.flat();
  const box = {
    minX: Math.min(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])),
    maxX: Math.max(...points.map((p) => p[0])),
    maxY: Math.max(...points.map((p) => p[1])),
  };
  return box.maxX > box.minX && box.maxY > box.minY ? box : null;
}

/** True when some pixel of `mask` within `radius` of (x, y) is set. */
function nearSet(mask: Uint8Array, width: number, height: number, x: number, y: number, radius: number): boolean {
  const r = Math.ceil(radius);
  const limit = radius * radius;
  for (let dy = -r; dy <= r; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width || dx * dx + dy * dy > limit) continue;
      if (mask[yy * width + xx] !== 0) return true;
    }
  }
  return false;
}

/** Distance in pixels from every pixel to the nearest ink pixel (two-pass chamfer over the 8 neighbours). */
function distanceToInk(mask: Uint8Array, width: number, height: number): Float32Array {
  const distance = new Float32Array(width * height);
  for (let i = 0; i < distance.length; i++) distance[i] = mask[i] !== 0 ? 0 : width + height;
  const relax = (x: number, y: number, dx: number, dy: number, step: number): void => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
    const candidate = distance[ny * width + nx] + step;
    if (candidate < distance[y * width + x]) distance[y * width + x] = candidate;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      relax(x, y, -1, 0, 1);
      relax(x, y, 0, -1, 1);
      relax(x, y, -1, -1, Math.SQRT2);
      relax(x, y, 1, -1, Math.SQRT2);
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      relax(x, y, 1, 0, 1);
      relax(x, y, 0, 1, 1);
      relax(x, y, 1, 1, Math.SQRT2);
      relax(x, y, -1, 1, Math.SQRT2);
    }
  }
  return distance;
}

/** About `count` points spread evenly along all truth strokes, as [x0, y0, x1, y1, ...] in drawing units. */
function truthPoints(truth: CadTruth, count: number): Float64Array {
  let total = 0;
  for (const stroke of truth.strokes) {
    for (let i = 1; i < stroke.length; i++) total += Math.hypot(stroke[i][0] - stroke[i - 1][0], stroke[i][1] - stroke[i - 1][1]);
  }
  const step = total / count;
  const points: number[] = [];
  let travelled = 0;
  let next = 0;
  for (const stroke of truth.strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const [x0, y0] = stroke[i - 1];
      const [x1, y1] = stroke[i];
      const length = Math.hypot(x1 - x0, y1 - y0);
      for (; next <= travelled + length; next += step) {
        const share = length === 0 ? 0 : (next - travelled) / length;
        points.push(x0 + (x1 - x0) * share, y0 + (y1 - y0) * share);
      }
      travelled += length;
    }
  }
  return Float64Array.from(points);
}

/** Mean distance of the truth points from ink on a frame, each capped at `cap` pixels (a point off the picture counts as `cap`), as a share of `cap`. */
function misfit(distance: Float32Array, width: number, height: number, points: Float64Array, real: Box, frame: Frame, cap: number): number {
  const scaleX = (frame.right - frame.left) / (real.maxX - real.minX);
  const scaleY = (frame.bottom - frame.top) / (real.maxY - real.minY);
  let sum = 0;
  for (let i = 0; i < points.length; i += 2) {
    const x = Math.round(frame.left + (points[i] - real.minX) * scaleX);
    const y = Math.round(frame.top + (real.maxY - points[i + 1]) * scaleY);
    const inside = x >= 0 && y >= 0 && x < width && y < height;
    sum += inside ? Math.min(distance[y * width + x], cap) : cap;
  }
  return sum / ((points.length / 2) * cap);
}

/**
 * The frame that puts the truth strokes on ink: a coordinate search over the four edges of the stroke box, from a coarse
 * tolerance and a wide reach to a fine tolerance and a narrow one. The edges stay within the limits set by the box of all
 * ink, and the search starts from `start` (also within them). Where two frames fit equally well, the one nearer to
 * `start` wins.
 */
function fitFrame(distance: Float32Array, width: number, height: number, ink: Box, start: Box, points: Float64Array, real: Box): Frame {
  const inkWidth = Math.max(1, ink.maxX - ink.minX);
  const inkHeight = Math.max(1, ink.maxY - ink.minY);
  const size = Math.max(inkWidth, inkHeight);
  const limits: Record<Edge, [number, number]> = {
    left: [ink.minX - EDGE_OUTWARD_LIMIT * inkWidth, ink.minX + EDGE_INWARD_LIMIT * inkWidth],
    right: [ink.maxX - EDGE_INWARD_LIMIT * inkWidth, ink.maxX + EDGE_OUTWARD_LIMIT * inkWidth],
    top: [ink.minY - EDGE_OUTWARD_LIMIT * inkHeight, ink.minY + EDGE_INWARD_LIMIT * inkHeight],
    bottom: [ink.maxY - EDGE_INWARD_LIMIT * inkHeight, ink.maxY + EDGE_OUTWARD_LIMIT * inkHeight],
  };
  const preferred: Frame = { left: start.minX, top: start.minY, right: start.maxX, bottom: start.maxY };
  let frame: Frame = { ...preferred };
  STAGES.forEach((stage, index) => {
    const cap = Math.max(1, stage.capShare * size);
    const steps = index === 0 ? COARSE_STEPS : FINE_STEPS;
    for (let sweep = 0; sweep < SWEEPS_PER_STAGE; sweep++) {
      for (const edge of EDGES) {
        const [low, high] = limits[edge];
        const horizontal = edge === 'left' || edge === 'right';
        const reach = stage.reach * (horizontal ? inkWidth : inkHeight);
        const from = Math.max(low, frame[edge] - reach);
        const to = Math.min(high, frame[edge] + reach);
        let best = frame[edge];
        let bestCost = Number.POSITIVE_INFINITY;
        for (let step = 0; step <= steps; step++) {
          const value = from + ((to - from) * step) / steps;
          const cost = misfit(distance, width, height, points, real, { ...frame, [edge]: value }, cap) + (EDGE_PRIOR * Math.abs(value - preferred[edge])) / size;
          if (cost < bestCost) {
            best = value;
            bestCost = cost;
          }
        }
        frame = { ...frame, [edge]: best };
      }
    }
  });
  return frame;
}

/** The ink components (8-connected), each with its box and pixel count. */
function inkComponents(mask: Uint8Array, width: number, height: number): Array<{ box: Box; count: number }> {
  const seen = new Uint8Array(mask.length);
  const components: Array<{ box: Box; count: number }> = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] !== 0) continue;
    const box: Box = { minX: width, minY: height, maxX: 0, maxY: 0 };
    let count = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const at = stack.pop() as number;
      const x = at % width;
      const y = (at - x) / width;
      count++;
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] === 0 || seen[next] !== 0) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    components.push({ box, count });
  }
  return components;
}

/**
 * The boxes the registration starts from: the box of all ink and, when something spans that box (a page border drawn
 * around the drawing, on which a fit started from the box of all ink can settle), the box of the biggest component that
 * does not.
 */
function startBoxes(mask: Uint8Array, width: number, height: number, ink: Box): Box[] {
  const inkWidth = Math.max(1, ink.maxX - ink.minX);
  const inkHeight = Math.max(1, ink.maxY - ink.minY);
  const components = inkComponents(mask, width, height);
  const spans = (box: Box): boolean => box.maxX - box.minX >= SPANNING_SHARE * inkWidth && box.maxY - box.minY >= SPANNING_SHARE * inkHeight;
  if (!components.some((component) => spans(component.box))) return [ink];
  const inner = components.filter((component) => !spans(component.box)).sort((a, b) => b.count - a.count)[0];
  return inner === undefined ? [ink] : [ink, inner.box];
}

/** The better fitting of the frames that the start boxes lead to; the box of all ink wins a tie. */
function registerFrame(mask: Uint8Array, width: number, height: number, ink: Box, points: Float64Array, real: Box): Frame {
  const distance = distanceToInk(mask, width, height);
  const size = Math.max(ink.maxX - ink.minX, ink.maxY - ink.minY, 1);
  const cap = Math.max(1, STAGES[STAGES.length - 2].capShare * size);
  const [first, ...others] = startBoxes(mask, width, height, ink);
  let best = fitFrame(distance, width, height, ink, first, points, real);
  let bestMisfit = misfit(distance, width, height, points, real, best, cap);
  for (const start of others) {
    const frame = fitFrame(distance, width, height, ink, start, points, real);
    const fit = misfit(distance, width, height, points, real, frame, cap);
    if (fit < bestMisfit) {
      best = frame;
      bestMisfit = fit;
    }
  }
  return best;
}

export function scoreInk(raster: Raster, truth: CadTruth): InkScore {
  const { width, height } = raster;
  const mask = inkMask(raster);
  const ink = inkBox(mask, width, height);
  const real = strokeBox(truth);
  if (ink === null || real === null) return NOTHING_DRAWN;
  const frame = registerFrame(mask, width, height, ink, truthPoints(truth, REGISTRATION_POINTS), real);
  const drawnWidth = Math.max(1, frame.right - frame.left);
  const drawnHeight = Math.max(1, frame.bottom - frame.top);
  const scaleX = drawnWidth / (real.maxX - real.minX);
  const scaleY = drawnHeight / (real.maxY - real.minY);
  const toPixel = (x: number, y: number): [number, number] => [frame.left + (x - real.minX) * scaleX, frame.top + (real.maxY - y) * scaleY];
  const radius = Math.max(MIN_TOLERANCE_PX, TOLERANCE_SHARE * Math.max(drawnWidth, drawnHeight));

  // The text boxes in pixels, and for each pixel the first text box it lies in (-1 when none).
  const textBoxes = truth.textBoxes.map(([minX, minY, maxX, maxY]) => {
    const growX = (maxX - minX) * TEXT_BOX_GROWTH;
    const growY = (maxY - minY) * TEXT_BOX_GROWTH;
    const [left, top] = toPixel(minX - growX, maxY + growY);
    const [right, bottom] = toPixel(maxX + growX, minY - growY);
    return { left: Math.max(0, Math.ceil(left)), top: Math.max(0, Math.ceil(top)), right: Math.min(width - 1, Math.floor(right)), bottom: Math.min(height - 1, Math.floor(bottom)) };
  });
  const textIndex = new Int32Array(width * height).fill(-1);
  for (let index = textBoxes.length - 1; index >= 0; index--) {
    const box = textBoxes[index];
    if (box.right < box.left) continue;
    for (let y = box.top; y <= box.bottom; y++) textIndex.fill(index, y * width + box.left, y * width + box.right + 1);
  }

  // The truth strokes as pixels: points every half pixel along each segment.
  const truthMask = new Uint8Array(width * height);
  const truthPixels: Array<[number, number]> = [];
  for (const stroke of truth.strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const [x0, y0] = toPixel(stroke[i - 1][0], stroke[i - 1][1]);
      const [x1, y1] = toPixel(stroke[i][0], stroke[i][1]);
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / SAMPLE_STEP_PX));
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps);
        const y = Math.round(y0 + ((y1 - y0) * s) / steps);
        if (x < 0 || y < 0 || x >= width || y >= height || truthMask[y * width + x] !== 0) continue;
        truthMask[y * width + x] = 1;
        truthPixels.push([x, y]);
      }
    }
  }

  // Recall: a truth stroke in a text box may be met by any ink; one outside the text boxes only by ink outside them.
  const outsideText = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) outsideText[i] = mask[i] !== 0 && textIndex[i] < 0 ? 1 : 0;
  let recalled = 0;
  for (const [x, y] of truthPixels) if (nearSet(textIndex[y * width + x] < 0 ? outsideText : mask, width, height, x, y, radius)) recalled++;

  // Precision: ink off the truth strokes is charged, except text. A text box takes the ink of glyphs, up to their coverage.
  const drawnPixels: Array<[number, number]> = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (mask[y * width + x] !== 0) drawnPixels.push([x, y]);
  }
  const stride = Math.max(1, Math.ceil(drawnPixels.length / MAX_PRECISION_SAMPLES));
  let sampled = 0;
  let precise = 0;
  const textInk = new Float64Array(textBoxes.length);
  for (let i = 0; i < drawnPixels.length; i += stride) {
    const [x, y] = drawnPixels[i];
    if (nearSet(truthMask, width, height, x, y, radius)) {
      sampled++;
      precise++;
    } else if (textIndex[y * width + x] >= 0) {
      textInk[textIndex[y * width + x]]++;
    } else {
      sampled++;
    }
  }
  textBoxes.forEach((box, index) => {
    const area = Math.max(0, box.right - box.left + 1) * Math.max(0, box.bottom - box.top + 1);
    sampled += Math.max(0, textInk[index] - (GLYPH_COVERAGE_MAX * area) / stride);
  });

  return {
    precision: sampled === 0 ? 0 : precise / sampled,
    recall: truthPixels.length === 0 ? 0 : recalled / truthPixels.length,
    extentError: Math.abs(scaleX / scaleY - 1),
  };
}
