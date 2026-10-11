import type { Raster } from './vector-raster';

/**
 * Geometric agreement of a rendered CAD drawing with the stroke geometry it was written from. The truth is a list of
 * polylines in drawing units (bench/corpus/cad/*.truth.json, written by bench/corpus/generate-vector-cad.ts from the
 * entity list of the DXF), so the score depends on neither the conversion engine nor the reference renderer.
 *
 * Renderers differ in page, margin, scale, line weight and colour, so the drawing is compared in its own frame: the box
 * of everything drawn becomes the box of the truth strokes. Then
 * - recall is the share of truth stroke pixels with drawn pixels within a tolerance (an entity left out costs recall),
 * - precision is the share of drawn pixels, text excluded, with a truth stroke within the tolerance (a stray or shifted
 *   mark costs precision),
 * - extent error is how far the aspect ratio of the drawn box is from the truth's (a stretched or mirrored page shows).
 */

export interface CadTruth {
  /** Every drawn outline as a polyline of [x, y] in drawing units, y pointing up. */
  strokes: Array<Array<[number, number]>>;
  /** Boxes of text [minX, minY, maxX, maxY] in drawing units; drawn pixels inside them are not scored for precision. */
  textBoxes: Array<[number, number, number, number]>;
  words: string[];
}

export interface InkScore {
  precision: number;
  recall: number;
  extentError: number;
}

/** A pixel differs from the white page by more than this in its darkest channel to count as drawn. */
const INK_THRESHOLD = 48;
const BYTE_MAX = 255;
const TOLERANCE_SHARE = 0.01;
const MIN_TOLERANCE_PX = 2;
const TEXT_BOX_GROWTH = 0.3;
const SAMPLE_STEP_PX = 0.5;
const MAX_PRECISION_SAMPLES = 20_000;
const NOTHING_DRAWN: InkScore = { precision: 0, recall: 0, extentError: 1 };

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function inkMask(raster: Raster): Uint8Array {
  const mask = new Uint8Array(raster.width * raster.height);
  for (let i = 0; i < mask.length; i++) {
    const darkest = Math.min(raster.rgb[i * 3], raster.rgb[i * 3 + 1], raster.rgb[i * 3 + 2]);
    mask[i] = BYTE_MAX - darkest > INK_THRESHOLD ? 1 : 0;
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

function strokeBox(truth: CadTruth): Box {
  const points = truth.strokes.flat();
  return {
    minX: Math.min(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])),
    maxX: Math.max(...points.map((p) => p[0])),
    maxY: Math.max(...points.map((p) => p[1])),
  };
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

export function scoreInk(raster: Raster, truth: CadTruth): InkScore {
  const { width, height } = raster;
  const mask = inkMask(raster);
  const drawn = inkBox(mask, width, height);
  if (drawn === null) return NOTHING_DRAWN;
  const real = strokeBox(truth);
  const drawnWidth = Math.max(1, drawn.maxX - drawn.minX);
  const drawnHeight = Math.max(1, drawn.maxY - drawn.minY);
  const scaleX = drawnWidth / (real.maxX - real.minX);
  const scaleY = drawnHeight / (real.maxY - real.minY);
  const toPixel = (x: number, y: number): [number, number] => [drawn.minX + (x - real.minX) * scaleX, drawn.minY + (real.maxY - y) * scaleY];
  const radius = Math.max(MIN_TOLERANCE_PX, TOLERANCE_SHARE * Math.max(drawnWidth, drawnHeight));

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

  let recalled = 0;
  for (const [x, y] of truthPixels) if (nearSet(mask, width, height, x, y, radius)) recalled++;

  const textBoxes = truth.textBoxes.map(([minX, minY, maxX, maxY]) => {
    const growX = (maxX - minX) * TEXT_BOX_GROWTH;
    const growY = (maxY - minY) * TEXT_BOX_GROWTH;
    const [left, top] = toPixel(minX - growX, maxY + growY);
    const [right, bottom] = toPixel(maxX + growX, minY - growY);
    return { left, top, right, bottom };
  });
  const inText = (x: number, y: number): boolean => textBoxes.some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
  const drawnPixels: Array<[number, number]> = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (mask[y * width + x] !== 0 && !inText(x, y)) drawnPixels.push([x, y]);
  }
  const stride = Math.max(1, Math.ceil(drawnPixels.length / MAX_PRECISION_SAMPLES));
  let sampled = 0;
  let precise = 0;
  for (let i = 0; i < drawnPixels.length; i += stride) {
    sampled++;
    if (nearSet(truthMask, width, height, drawnPixels[i][0], drawnPixels[i][1], radius)) precise++;
  }

  const truthAspect = (real.maxX - real.minX) / (real.maxY - real.minY);
  return {
    precision: sampled === 0 ? 0 : precise / sampled,
    recall: truthPixels.length === 0 ? 0 : recalled / truthPixels.length,
    extentError: Math.abs(drawnWidth / drawnHeight / truthAspect - 1),
  };
}
