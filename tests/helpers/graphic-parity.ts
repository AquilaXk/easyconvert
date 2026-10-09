import sharp from 'sharp';

/**
 * Fixtures and curve interpolation for the graphic-content parity tests. The fixtures are drawn here, with known
 * flat areas and hard edges, so that no expectation depends on the converter under test.
 */

export const SIDE = 256;
const GRID = 16;

export function svgPng(body: string, width = SIDE, height = SIDE): Promise<Buffer> {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`)).png().toBuffer();
}

/** One-pixel black lines on white: a grid, two diagonals and two circles. 16-bit grey, as the benchmark's line art is. */
export async function lineArt16(): Promise<Buffer> {
  const lines: string[] = [];
  for (let at = GRID; at < SIDE; at += GRID) lines.push(`M${at} 0V${SIDE}M0 ${at}H${SIDE}`);
  const body =
    '<rect width="100%" height="100%" fill="#fff"/>' +
    `<g fill="none" stroke="#000" stroke-width="1"><path d="${lines.join('')}M0 0L${SIDE} ${SIDE}M${SIDE} 0L0 ${SIDE}"/>` +
    '<circle cx="128" cy="128" r="90"/><circle cx="128" cy="128" r="45"/></g>';
  return sharp(await svgPng(body)).toColourspace('grey16').png().toBuffer();
}

/** An interface: flat panels with hard coloured edges and a strip of one-pixel rules. 16-bit RGB. */
export async function interface16(): Promise<Buffer> {
  const body =
    '<rect width="100%" height="100%" fill="#eceff1"/><rect width="256" height="28" fill="#2c3e50"/>' +
    '<rect x="12" y="44" width="96" height="26" rx="5" fill="#3498db"/><rect x="124" y="44" width="96" height="26" rx="5" fill="#e74c3c"/>' +
    '<rect x="12" y="88" width="208" height="64" fill="#fff" stroke="#95a5a6"/><path d="M20 100H210M20 112H190M20 124H200M20 136H170" stroke="#34495e" stroke-width="2"/>' +
    '<circle cx="40" cy="190" r="16" fill="#27ae60"/><rect x="72" y="176" width="150" height="3" fill="#8e44ad"/><rect x="72" y="196" width="110" height="3" fill="#f39c12"/>';
  return sharp(await svgPng(body)).toColourspace('rgb16').png().toBuffer();
}

export interface Point {
  bytes: number;
  value: number;
}

/** Reference quality at `bytes`: linear in ln(size) between the two reference points around it. */
export function interpolateAt(points: Point[], bytes: number): number {
  const sorted = [...points].sort((a, b) => a.bytes - b.bytes);
  for (let i = 1; i < sorted.length; i += 1) {
    const lo = sorted[i - 1];
    const hi = sorted[i];
    if (bytes >= lo.bytes && bytes <= hi.bytes) {
      const share = (Math.log(bytes) - Math.log(lo.bytes)) / (Math.log(hi.bytes) - Math.log(lo.bytes));
      return lo.value + share * (hi.value - lo.value);
    }
  }
  throw new Error(`${bytes} bytes lies outside the reference curve ${sorted[0].bytes}..${sorted[sorted.length - 1].bytes}`);
}
