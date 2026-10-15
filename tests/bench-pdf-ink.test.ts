import { describe, expect, it } from 'vitest';
import { type GrayRaster, lineAngleDifference, measureInk, parsePgm } from '../bench/pdf-ink';

/**
 * The stamp oracle is checked on rasters drawn here with known darkness, position and angle, so that its numbers are
 * known to follow the stamp and not the renderer.
 */

const WIDTH = 600;
const HEIGHT = 840;
const DPI = 72;

const blank = (): GrayRaster => ({ width: WIDTH, height: HEIGHT, pixels: new Uint8Array(WIDTH * HEIGHT).fill(255) });

/** A bar `length` x `thickness` points, turned by `angleDegrees`, centred `offset` points from the page centre, losing `lost` of 255. */
function bar(length: number, thickness: number, angleDegrees: number, offset: { x: number; y: number }, lost: number): GrayRaster {
  const raster = blank();
  const angle = (angleDegrees * Math.PI) / 180;
  for (let row = 0; row < HEIGHT; row++) {
    for (let column = 0; column < WIDTH; column++) {
      const x = column + 0.5 - WIDTH / 2 - offset.x;
      const y = HEIGHT / 2 - row - 0.5 - offset.y;
      const along = x * Math.cos(angle) + y * Math.sin(angle);
      const across = -x * Math.sin(angle) + y * Math.cos(angle);
      if (Math.abs(along) <= length / 2 && Math.abs(across) <= thickness / 2) raster.pixels[row * WIDTH + column] = 255 - lost;
    }
  }
  return raster;
}

describe('the ink oracle', () => {
  it('reports the mass as the area times the share of brightness lost', () => {
    const measure = measureInk(bar(300, 30, -45, { x: 0, y: 0 }, 77), blank(), DPI, -45);
    expect(Math.abs(measure.mass / ((300 * 30 * 77) / 255) - 1)).toBeLessThan(0.03);
    const lighter = measureInk(bar(300, 30, -45, { x: 0, y: 0 }, 38), blank(), DPI, -45);
    expect(lighter.mass / measure.mass).toBeCloseTo(38 / 77, 2);
  });

  it('finds the centre of a bar centred on the page and its angle', () => {
    const measure = measureInk(bar(300, 30, -45, { x: 0, y: 0 }, 77), blank(), DPI, -45);
    expect(Math.abs(measure.centreAlong)).toBeLessThan(0.6);
    expect(Math.abs(measure.centreAcross)).toBeLessThan(0.6);
    expect(measure.principalAngleDegrees).toBeCloseTo(-45, 0);
  });

  it('sees a bar moved 5 points across its direction, and one turned by 10 degrees', () => {
    // Moving by (dx, dy) = 5 points along the normal of the -45 degree frame: the normal is (sin, cos)(-45) = (0.707, 0.707).
    const shifted = measureInk(bar(300, 30, -45, { x: 5 * Math.SQRT1_2, y: 5 * Math.SQRT1_2 }, 77), blank(), DPI, -45);
    expect(shifted.centreAcross).toBeCloseTo(5, 0);
    expect(Math.abs(shifted.centreAlong)).toBeLessThan(0.6);
    const turned = measureInk(bar(300, 30, -35, { x: 0, y: 0 }, 77), blank(), DPI, -45);
    expect(turned.principalAngleDegrees).toBeCloseTo(-35, 0);
  });

  it('finds no ink on identical pages', () => {
    const measure = measureInk(blank(), blank(), DPI, -45);
    expect(measure.inkPixels).toBe(0);
    expect(measure.mass).toBe(0);
    expect(measure.box).toBeNull();
  });

  it('measures lengths in points at another resolution', () => {
    const wide = { width: WIDTH * 2, height: HEIGHT * 2, pixels: new Uint8Array(WIDTH * 2 * HEIGHT * 2).fill(255) };
    for (let row = 0; row < wide.height; row++) {
      for (let column = 0; column < wide.width; column++) {
        if (Math.abs(column - wide.width / 2) < 200 && Math.abs(row - wide.height / 2) < 20) wide.pixels[row * wide.width + column] = 100;
      }
    }
    const measure = measureInk(wide, { ...wide, pixels: new Uint8Array(wide.pixels.length).fill(255) }, 2 * DPI, 0);
    // 399 columns by 39 rows of 2x2 pixels per square point, each losing 155 of 255.
    expect(measure.mass).toBeCloseTo((399 * 39 * 155) / 255 / 4, 6);
    expect(measure.box?.maxX).toBeCloseTo(WIDTH / 2 + 100, 0);
  });

  it('folds angles as lines and reads a PGM', () => {
    expect(lineAngleDifference(179, -1)).toBeCloseTo(0);
    expect(lineAngleDifference(-45, 45)).toBeCloseTo(90);
    const pgm = Buffer.concat([Buffer.from('P5\n2 1\n255\n', 'latin1'), Buffer.from([10, 20])]);
    expect(parsePgm(pgm)).toEqual({ width: 2, height: 1, pixels: Uint8Array.from([10, 20]) });
    expect(() => parsePgm(Buffer.from('P6\n1 1\n255\nabc', 'latin1'))).toThrow(RangeError);
  });
});
