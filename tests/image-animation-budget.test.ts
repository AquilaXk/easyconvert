import { describe, it, expect } from 'vitest';
import {
  assertAnimationBudget,
  COMPOSED_MEMORY,
  COMPOSED_WORKING_COPIES,
  MAX_DECODED_ANIMATION_BYTES,
  ORIENTED_WORKING_COPIES,
  orientedMemory,
  stackedMemory,
} from '../src/lib/conversions/image-limits';

/**
 * Exact boundaries of the animation budget. The arithmetic is spelled out here from the documented limit
 * (512 MiB of RGBA) and the measured number of frame-sized buffers alive at once, so a change to either
 * shows up as a moved boundary:
 *  - composed frames (APNG): 7 buffers;
 *  - oriented stacked frames (EXIF orientation on GIF/WebP): the stack decoded twice plus 20 buffers;
 *  - plain stacked frames: the stack decoded twice plus 4 buffers.
 */

const BUDGET_BYTES = 512 * 1024 * 1024;
const RGBA = 4;

describe('constants', () => {
  it('pins the measured working copies and the budget', () => {
    expect(MAX_DECODED_ANIMATION_BYTES).toBe(BUDGET_BYTES);
    expect(ORIENTED_WORKING_COPIES).toBe(20);
    expect(COMPOSED_WORKING_COPIES).toBe(7);
    expect(COMPOSED_MEMORY).toEqual({ residentFrames: 0, workingCopies: 7 });
    expect(orientedMemory(10)).toEqual({ residentFrames: 20, workingCopies: 20 });
    expect(stackedMemory(10)).toEqual({ residentFrames: 20, workingCopies: 4 });
  });
});

describe('oriented stacked animations', () => {
  // 134217728 / (2 * 6 + 20) = 4194304 pixels = 2048 x 2048 exactly.
  const EXACT_FRAMES = 6;
  const EXACT_SIDE = 2048;

  it('admits the exact boundary: 6 frames of 2048 x 2048 use precisely 512 MiB at their peak', () => {
    expect((2 * EXACT_FRAMES + ORIENTED_WORKING_COPIES) * EXACT_SIDE * EXACT_SIDE * RGBA).toBe(BUDGET_BYTES);
    expect(() => assertAnimationBudget(EXACT_SIDE, EXACT_SIDE, EXACT_FRAMES, 'The oriented animation', orientedMemory(EXACT_FRAMES))).not.toThrow();
  });

  it('refuses one more column', () => {
    expect(() =>
      assertAnimationBudget(EXACT_SIDE + 1, EXACT_SIDE, EXACT_FRAMES, 'The oriented animation', orientedMemory(EXACT_FRAMES))
    ).toThrow(/decoded animation limit/);
  });

  it('refuses one more frame', () => {
    expect(() =>
      assertAnimationBudget(EXACT_SIDE, EXACT_SIDE, EXACT_FRAMES + 1, 'The oriented animation', orientedMemory(EXACT_FRAMES + 1))
    ).toThrow(/decoded animation limit/);
  });

  it.each([
    ['2000x2000 x 6 frames (measured 471 MiB gif, 472 MiB webp at 10)', 2000, 6, true],
    ['2000x2000 x 7 frames (measured 482 MiB)', 2000, 7, false],
    ['2000x2000 x 10 frames (measured 565 MiB)', 2000, 10, false],
    ['2000x2000 x 14 frames (measured 617 MiB)', 2000, 14, false],
    ['3000x3000 x 5 frames (measured 685 MiB)', 3000, 5, false],
    ['3000x3000 x 2 frames', 3000, 2, false],
    ['1500x1500 x 19 frames', 1500, 19, true],
    ['1500x1500 x 20 frames', 1500, 20, false],
  ])('%s is %s by the oriented model', (_label, side, frames, admitted) => {
    const run = () => assertAnimationBudget(side, side, frames, 'The oriented animation', orientedMemory(frames));
    if (admitted) expect(run).not.toThrow();
    else expect(run).toThrow(/decoded animation limit/);
  });

  it('reports the modelled peak in MiB', () => {
    expect(() => assertAnimationBudget(3000, 3000, 5, 'The oriented animation', orientedMemory(5))).toThrow(
      '5 frames of 3000x3000 pixels (1030 MiB as RGBA at its peak)'
    );
  });
});

describe('composed animations', () => {
  // floor(134217728 / 7) = 19173961 pixels: 4378 x 4378 = 19166884 fits, 4379 x 4379 = 19175641 does not.
  it('admits 4378 x 4378 and refuses 4379 x 4379', () => {
    expect(7 * 4378 * 4378 * RGBA).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(7 * 4379 * 4379 * RGBA).toBeGreaterThan(BUDGET_BYTES);
    expect(() => assertAnimationBudget(4378, 4378, 2, 'The animated PNG', COMPOSED_MEMORY)).not.toThrow();
    expect(() => assertAnimationBudget(4379, 4379, 2, 'The animated PNG', COMPOSED_MEMORY)).toThrow(/decoded animation limit/);
  });

  it.each([
    ['4000x4000 x 2 (measured 355-384 MiB)', 4000, 2, true],
    ['4000x4000 x 8 (all frames total exactly 512000000 bytes)', 4000, 8, true],
    ['4000x4000 x 9 (total over the budget)', 4000, 9, false],
    ['5000x5000 x 2 (measured 546-578 MiB)', 5000, 2, false],
  ])('%s', (_label, side, frames, admitted) => {
    const run = () => assertAnimationBudget(side, side, frames, 'The animated PNG', COMPOSED_MEMORY);
    if (admitted) expect(run).not.toThrow();
    else expect(run).toThrow(/decoded animation limit/);
  });
});

describe('plain stacked animations keep their model', () => {
  it('10 frames of 2000 x 2000 are modelled at 366 MiB, as measured against', () => {
    const peak = (10 * 2 + 4) * 2000 * 2000 * RGBA;
    expect(Math.round(peak / (1024 * 1024))).toBe(366);
    expect(() => assertAnimationBudget(2000, 2000, 10, 'The animation')).not.toThrow();
  });
});
