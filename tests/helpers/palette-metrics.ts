/**
 * Picture-difference metrics for palette tests, written from the published definitions and sharing nothing with
 * the quantizer: PSNR over the three colour channels of 8-bit RGBA rasters, and the mean Delta E_OK (Euclidean
 * distance in Oklab, B. Ottosson 2020, using his published matrices).
 */

const BYTE_MAX = 255;

function toLinear(value: number): number {
  const v = value / BYTE_MAX;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Oklab (L, a, b) of an sRGB colour with 8-bit channels. */
export function oklabOf(r: number, g: number, b: number): [number, number, number] {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export interface PaletteDifference {
  /** Peak signal-to-noise ratio in dB over R, G and B; Infinity for identical pictures. */
  psnr: number;
  /** Mean Delta E_OK per pixel. */
  deltaEOk: number;
}

export function comparePictures(reference: Uint8Array | Uint8ClampedArray, candidate: Uint8Array | Uint8ClampedArray): PaletteDifference {
  if (reference.length !== candidate.length) throw new Error('pictures differ in size');
  const pixels = reference.length / 4;
  let squared = 0;
  let deltaE = 0;
  for (let i = 0; i < pixels; i += 1) {
    for (let c = 0; c < 3; c += 1) squared += (reference[i * 4 + c] - candidate[i * 4 + c]) ** 2;
    const a = oklabOf(reference[i * 4], reference[i * 4 + 1], reference[i * 4 + 2]);
    const b = oklabOf(candidate[i * 4], candidate[i * 4 + 1], candidate[i * 4 + 2]);
    deltaE += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  const mse = squared / (pixels * 3);
  return { psnr: mse === 0 ? Infinity : 10 * Math.log10((BYTE_MAX * BYTE_MAX) / mse), deltaEOk: deltaE / pixels };
}
