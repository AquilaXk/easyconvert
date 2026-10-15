import { describe, expect, it } from 'vitest';
import { encodeEmf } from '../src/lib/conversions/vector-metafile';

/**
 * An EMF keeps a vertex to a fraction of a pixel: the logical unit is finer than a pixel, so the polygon of a circle lies on
 * the circle to the precision of the integer coordinates, not to half a pixel. The records are read here from the layout
 * of [MS-EMF] (EMR_SETWINDOWEXTEX = 9, EMR_SETVIEWPORTEXTEX = 11, EMR_POLYGON16 = 86), not by the encoder's own reader.
 */

const EMR_SETWINDOWEXTEX = 9;
const EMR_SETVIEWPORTEXTEX = 11;
const EMR_POLYGON16 = 86;
const CIRCLE = { cx: 120.25, cy: 80.5, r: 60.4 };
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><circle cx="${CIRCLE.cx}" cy="${CIRCLE.cy}" r="${CIRCLE.r}" fill="#1f77b4"/></svg>`;

function records(file: Buffer): Array<{ type: number; body: Buffer }> {
  const found: Array<{ type: number; body: Buffer }> = [];
  for (let at = 0; at < file.length; ) {
    const size = file.readUInt32LE(at + 4);
    found.push({ type: file.readUInt32LE(at), body: file.subarray(at + 8, at + size) });
    at += size;
  }
  return found;
}

describe('encodeEmf', () => {
  const file = encodeEmf(Buffer.from(SVG));
  const all = records(file);

  it('maps a logical unit of 1/16 pixel onto the 96 pixels per inch of the page', () => {
    const windowExtent = all.find((record) => record.type === EMR_SETWINDOWEXTEX);
    const viewportExtent = all.find((record) => record.type === EMR_SETVIEWPORTEXTEX);
    expect(windowExtent?.body.readInt32LE(0)).toBe(96 * 16);
    expect(viewportExtent?.body.readInt32LE(0)).toBe(96);
  });

  it('places every vertex of the circle on the circle to within one logical unit (1/16 pixel)', () => {
    const polygon = all.find((record) => record.type === EMR_POLYGON16);
    expect(polygon).toBeDefined();
    const count = (polygon as { body: Buffer }).body.readUInt32LE(16);
    expect(count).toBeGreaterThan(30);
    for (let i = 0; i < count; i++) {
      const x = (polygon as { body: Buffer }).body.readInt16LE(20 + i * 4);
      const y = (polygon as { body: Buffer }).body.readInt16LE(22 + i * 4);
      const distance = Math.hypot(x - CIRCLE.cx * 16, y - CIRCLE.cy * 16);
      expect(Math.abs(distance - CIRCLE.r * 16)).toBeLessThanOrEqual(1);
    }
  });
});
