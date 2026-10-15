/**
 * CIEDE2000 colour difference (CIE 142-2001; G. Sharma, W. Wu, E. N. Dalal, "The CIEDE2000 colour-difference
 * formula: implementation notes, supplementary test data, and mathematical observations", 2005), for 8-bit sRGB
 * colours under D65. Written for tests; it shares nothing with the project's own colour code.
 */

const BYTE_MAX = 255;
const D65 = { x: 0.95047, y: 1, z: 1.08883 };
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

export type Lab = readonly [number, number, number];

function toLinear(value: number): number {
  const v = value / BYTE_MAX;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** CIE L*a*b* (D65) of an sRGB colour with 8-bit channels. */
export function labOfSrgb(r: number, g: number, b: number): Lab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / D65.x;
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / D65.y;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / D65.z;
  const f = (t: number): number => (t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const rad = (degrees: number): number => (degrees * Math.PI) / 180;
const deg = (radians: number): number => (radians * 180) / Math.PI;

export function deltaE2000(a: Lab, b: Lab): number {
  const [l1, a1, b1] = a;
  const [l2, a2, b2] = b;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(Math.pow(cBar, 7) / (Math.pow(cBar, 7) + Math.pow(25, 7))));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h = (y: number, x: number): number => (x === 0 && y === 0 ? 0 : (deg(Math.atan2(y, x)) + 360) % 360);
  const h1p = h(b1, a1p);
  const h2p = h(b2, a2p);
  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp / 2));
  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hBarP += h1p + h2p < 360 ? 360 : -360;
    hBarP /= 2;
  }
  const t =
    1 - 0.17 * Math.cos(rad(hBarP - 30)) + 0.24 * Math.cos(rad(2 * hBarP)) + 0.32 * Math.cos(rad(3 * hBarP + 6)) - 0.2 * Math.cos(rad(4 * hBarP - 63));
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rC = 2 * Math.sqrt(Math.pow(cBarP, 7) / (Math.pow(cBarP, 7) + Math.pow(25, 7)));
  const sL = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;
  const rT = -Math.sin(rad(2 * dTheta)) * rC;
  return Math.sqrt((dLp / sL) ** 2 + (dCp / sC) ** 2 + (dHp / sH) ** 2 + rT * (dCp / sC) * (dHp / sH));
}

/** Mean CIEDE2000 over two RGBA rasters of the same size (alpha ignored). */
export function meanDeltaE2000(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error('rasters differ in size');
  const pixels = a.length / 4;
  let total = 0;
  for (let i = 0; i < pixels; i += 1) total += deltaE2000(labOfSrgb(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]), labOfSrgb(b[i * 4], b[i * 4 + 1], b[i * 4 + 2]));
  return total / pixels;
}
