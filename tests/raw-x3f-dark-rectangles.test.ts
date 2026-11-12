import { describe, it, expect } from 'vitest';
import { darkRectangles, type CamfMatrix } from '../src/lib/conversions/raw-x3f';

const WIDTH = 5888;
const HEIGHT = 3776;
const CAMERA_ID_SD_QUATTRO_H = 41;

function matrix(...values: number[]): CamfMatrix {
  return { dims: [values.length], dimNames: [], values };
}

function calibration(entries: Record<string, number[]>): Map<string, CamfMatrix> {
  return new Map(Object.entries(entries).map(([name, values]) => [name, matrix(...values)]));
}

const TOP = [216, 2, 5639, 17];
const BOTTOM = [216, 3654, 5639, 3669];
const COLUMNS = [8, 199, 5656, 5847];

describe('dark-shield areas of a Sigma calibration', () => {
  it('uses the top and bottom rectangles when the calibration lists them', () => {
    const found = darkRectangles(calibration({ DarkShieldTop: TOP, DarkShieldBottom: BOTTOM, DarkShieldColRange: COLUMNS }), WIDTH, HEIGHT);
    expect(found).toEqual([
      { left: 216, top: 2, right: 5639, bottom: 17 },
      { left: 216, top: 3654, right: 5639, bottom: 3669 },
    ]);
  });

  it('ignores the bottom rectangle of the sd Quattro H, whose firmware lists it wrongly', () => {
    const found = darkRectangles(calibration({ CAMERAID: [CAMERA_ID_SD_QUATTRO_H], DarkShieldTop: TOP, DarkShieldBottom: BOTTOM }), WIDTH, HEIGHT);
    expect(found).toEqual([{ left: 216, top: 2, right: 5639, bottom: 17 }]);
  });

  it('keeps the bottom rectangle of other cameras', () => {
    const found = darkRectangles(calibration({ CAMERAID: [40], DarkShieldTop: TOP, DarkShieldBottom: BOTTOM }), WIDTH, HEIGHT);
    expect(found).toHaveLength(2);
  });

  it('falls back to the dark columns over the full height when no rectangle is listed', () => {
    const found = darkRectangles(calibration({ DarkShieldColRange: COLUMNS }), WIDTH, HEIGHT);
    expect(found).toEqual([
      { left: 8, top: 0, right: 199, bottom: HEIGHT - 1 },
      { left: 5656, top: 0, right: 5847, bottom: HEIGHT - 1 },
    ]);
  });

  it('falls back to the dark columns when the listed rectangles lie outside the image', () => {
    const found = darkRectangles(calibration({ DarkShieldTop: [0, 0, WIDTH, 5], DarkShieldBottom: [0, 0, 5, HEIGHT], DarkShieldColRange: COLUMNS }), WIDTH, HEIGHT);
    expect(found).toHaveLength(2);
    expect(found[0].bottom).toBe(HEIGHT - 1);
  });

  it.each([
    ['no dark area at all', {}],
    ['a column range of the wrong size', { DarkShieldColRange: [8, 199, 5656] }],
    ['column ranges running backwards', { DarkShieldColRange: [199, 8, 5847, 5656] }],
    ['negative columns', { DarkShieldColRange: [-1, 199, -5, 5847] }],
    ['fractional columns', { DarkShieldColRange: [8.5, 199, 5656.5, 5847] }],
  ])('finds no dark area for %s', (_label, entries) => {
    expect(darkRectangles(calibration(entries), WIDTH, HEIGHT)).toEqual([]);
  });

  it('keeps the valid side when the other dark column range lies past the image width', () => {
    const found = darkRectangles(calibration({ DarkShieldColRange: [8, 199, 5656, WIDTH] }), WIDTH, HEIGHT);
    expect(found).toEqual([{ left: 8, top: 0, right: 199, bottom: HEIGHT - 1 }]);
  });
});
