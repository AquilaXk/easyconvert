import { describe, it, expect } from 'vitest';
import { parseCgmToSvg } from '../src/lib/conversions/vector-cad';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

const REPS = 300_000;
/** A CGM states its canvas size; one without a VDC extent is refused. */
const EXTENT = 'VDCEXT (0,0) (100,100); ';

describe('CGM clear-text parsing stays linear on adversarial input', () => {
  it('handles repeated POLYGON keywords without a terminator in linear time', async () => {
    // Growth, not wall-clock: a quarter of the repetitions takes about a quarter of the time (tests/helpers/timing.ts).
    const cgm = (n: number) => `BEGMF ${EXTENT}${'POLYGON '.repeat(n)}`;
    await expectLinearOnInputs('POLYGON keywords', (input: string) => parseCgmToSvg(input), {
      small: cgm(REPS),
      large: cgm(REPS * SCALING_FACTOR),
    });
  }, SCALING_TEST_TIMEOUT_MS);

  it('handles repeated TEXT heads without a quoted string in linear time', async () => {
    const cgm = (n: number) => `BEGMF ${EXTENT}${'TEXT (1,1)'.repeat(n)}`;
    await expectLinearOnInputs('TEXT heads', (input: string) => parseCgmToSvg(input), {
      small: cgm(REPS),
      large: cgm(REPS * SCALING_FACTOR),
    });
  }, SCALING_TEST_TIMEOUT_MS);

  it('still extracts polygons, polylines and text from well-formed input', () => {
    const cgm = [
      'BEGMF "x";',
      'VDCEXT (0,0) (100,100);',
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
