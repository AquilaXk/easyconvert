/**
 * Measures a stamp from rendered pages alone: the ink is what the stamped page lost in brightness against the same
 * page unstamped. Nothing here knows how either PDF was written, so the numbers are an oracle for the stamp's darkness,
 * its position and its angle, independent of the code that drew it and of the reference's geometry.
 */

export interface GrayRaster {
  width: number;
  height: number;
  /** One byte per pixel, row 0 at the top of the page. */
  pixels: Uint8Array;
}

export interface InkMeasure {
  /** Darkness-weighted ink area in square points: the sum of the brightness lost, in white-pixel units. */
  mass: number;
  /** Pixels that count as ink. */
  inkPixels: number;
  /** The bounding box of the ink, in points on the page (x right, y up, origin at the page's lower-left corner). */
  box: { minX: number; maxX: number; minY: number; maxY: number } | null;
  /** The centre of the ink's bounding box in the frame turned by `frameAngleDegrees`, measured from the page centre, in points. */
  centreAlong: number;
  centreAcross: number;
  /** Direction of the ink's longest axis in degrees counter-clockwise, folded into (-90, 90]. */
  principalAngleDegrees: number;
}

/** Brightness lost, out of 255, below which a pixel is not ink (anti-aliasing noise of the renderer). */
export const INK_THRESHOLD = 6;
const GRAY_MAX = 255;
const HALF_TURN_DEGREES = 180;
const QUARTER_TURN_DEGREES = 90;

/** Reads a binary PGM (P5) with 8-bit samples, as `pdftoppm -gray` writes it. */
export function parsePgm(bytes: Buffer): GrayRaster {
  const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(bytes.toString('latin1', 0, 64));
  if (!header) throw new RangeError('not an 8-bit binary PGM');
  const width = Number(header[1]);
  const height = Number(header[2]);
  const samples = bytes.subarray(header[0].length);
  if (samples.length !== width * height) throw new RangeError(`PGM holds ${samples.length} samples for ${width}x${height}`);
  return { width, height, pixels: new Uint8Array(samples.buffer, samples.byteOffset, samples.length) };
}

/**
 * @param stamped   the page as rendered with the stamp
 * @param unstamped the same page without it, at the same resolution
 * @param dpi       resolution of both rasters, so that lengths come out in points (1/72 inch)
 * @param frameAngleDegrees the direction the stamp text runs in; the bounding box is taken in that frame
 */
export function measureInk(stamped: GrayRaster, unstamped: GrayRaster, dpi: number, frameAngleDegrees: number): InkMeasure {
  if (stamped.width !== unstamped.width || stamped.height !== unstamped.height) throw new RangeError('the two renders differ in size');
  const { width, height } = stamped;
  const pixelsPerPoint = dpi / 72;
  const angle = (frameAngleDegrees * Math.PI) / HALF_TURN_DEGREES;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let mass = 0;
  let inkPixels = 0;
  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  const points: { x: number; y: number; w: number }[] = [];
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const lost = unstamped.pixels[row * width + column] - stamped.pixels[row * width + column];
      if (lost <= 0) continue;
      mass += lost / GRAY_MAX;
      if (lost < INK_THRESHOLD) continue;
      inkPixels++;
      // Page coordinates in points about the page centre, y up.
      const x = (column + 0.5) / pixelsPerPoint - width / pixelsPerPoint / 2;
      const y = (height - row - 0.5) / pixelsPerPoint - height / pixelsPerPoint / 2;
      const along = x * cos + y * sin;
      const across = -x * sin + y * cos;
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
      minAcross = Math.min(minAcross, across);
      maxAcross = Math.max(maxAcross, across);
      minX = Math.min(minX, x + width / pixelsPerPoint / 2);
      maxX = Math.max(maxX, x + width / pixelsPerPoint / 2);
      minY = Math.min(minY, y + height / pixelsPerPoint / 2);
      maxY = Math.max(maxY, y + height / pixelsPerPoint / 2);
      points.push({ x, y, w: lost });
      weight += lost;
      sumX += x * lost;
      sumY += y * lost;
    }
  }
  const massPoints = mass / (pixelsPerPoint * pixelsPerPoint);
  if (inkPixels === 0) return { mass: massPoints, inkPixels, box: null, centreAlong: NaN, centreAcross: NaN, principalAngleDegrees: NaN };
  const meanX = sumX / weight;
  const meanY = sumY / weight;
  let covXX = 0;
  let covYY = 0;
  let covXY = 0;
  for (const point of points) {
    covXX += point.w * (point.x - meanX) ** 2;
    covYY += point.w * (point.y - meanY) ** 2;
    covXY += point.w * (point.x - meanX) * (point.y - meanY);
  }
  let principal = ((0.5 * Math.atan2(2 * covXY, covXX - covYY)) * HALF_TURN_DEGREES) / Math.PI;
  if (principal <= -QUARTER_TURN_DEGREES) principal += HALF_TURN_DEGREES;
  return {
    mass: massPoints,
    inkPixels,
    box: { minX, maxX, minY, maxY },
    centreAlong: (minAlong + maxAlong) / 2,
    centreAcross: (minAcross + maxAcross) / 2,
    principalAngleDegrees: principal,
  };
}

/** Difference of two directions in degrees as lines, so that 179 and -1 are 2 apart. */
export function lineAngleDifference(a: number, b: number): number {
  const turn = (((a - b) % HALF_TURN_DEGREES) + HALF_TURN_DEGREES) % HALF_TURN_DEGREES;
  return Math.min(turn, HALF_TURN_DEGREES - turn);
}
