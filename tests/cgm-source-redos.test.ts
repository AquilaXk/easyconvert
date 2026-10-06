import { describe, it, expect } from 'vitest';
import { parseCgmToSvg } from '../src/lib/conversions/vector-cad';

const TIME_BOUND_MS = 1000;
const REPS = 30_000;

function elapsedMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('CGM clear-text parsing stays linear on adversarial input', () => {
  it('handles repeated POLYGON keywords without a terminator quickly', () => {
    const cgm = `BEGMF ${'POLYGON '.repeat(REPS)}`;
    expect(elapsedMs(() => parseCgmToSvg(cgm))).toBeLessThan(TIME_BOUND_MS);
  });

  it('handles repeated TEXT heads without a quoted string quickly', () => {
    const cgm = `BEGMF ${'TEXT (1,1)'.repeat(REPS)}`;
    expect(elapsedMs(() => parseCgmToSvg(cgm))).toBeLessThan(TIME_BOUND_MS);
  });

  it('still extracts polygons, polylines and text from well-formed input', () => {
    const cgm = [
      'BEGMF "x";',
      'POLYGON (1,1) (5,1) (3,4);',
      'POLYLINE\n  (0,0) (9,9);',
      'POLYGON (1,1) (2,2);',
      'TEXT (7,8) FINAL "a<b";',
      'TEXT (1,1) "";',
      'ENDMF;',
    ].join('\n');
    const svg = parseCgmToSvg(cgm) as string;
    expect(svg).toContain('<polygon points="1,1 5,1 3,4" ');
    expect(svg).toContain('<polyline points="0,0 9,9" ');
    expect(svg).not.toContain('points="1,1 2,2"');
    expect(svg).toContain('x="7" y="8"');
    expect(svg).toContain('>a&lt;b</text>');
    expect(svg.match(/<text /g)).toHaveLength(1);
  });
});
