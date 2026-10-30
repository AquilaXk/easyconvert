import { describe, expect, it } from 'vitest';
import { safeExtractXmlElements } from '../src/lib/conversions/safe-xml-scanner';
import { SCALING_TEST_TIMEOUT_MS, SCALING_FACTOR, expectLinearOnInputs } from './helpers/timing';

/**
 * Each opening of a tag searches ahead for its own close and counts the openings of the same name between, up to the depth bound.
 * Repeated openings of one name that nest too deep, or are never closed, used to make every one of them walk the whole run again:
 * 4,000 of them took 3.8 s and 16,000 over a minute. A nest past the bound now ends the scan, so the cost is that of one walk.
 */

const OPENINGS = 1_000;
const unclosed = (count: number): string => `${'<row>'.repeat(count)}${'x'.repeat(count * 20)}</row>`;
const nested = (count: number): string => `${'<row>'.repeat(count)}${'</row>'.repeat(count)}`;

describe('repeated openings of one tag', () => {
  const shapes: Array<[string, (count: number) => string]> = [
    ['never closed but once', unclosed],
    ['nested and closed', nested],
  ];

  for (const [shape, build] of shapes) {
    it(`cost time linear in their number when they are ${shape}`, async () => {
      const { largeResult } = await expectLinearOnInputs(
        shape,
        (xml: string) => safeExtractXmlElements(xml, 'row'),
        { small: build(OPENINGS), large: build(OPENINGS * SCALING_FACTOR) }
      );
      expect(largeResult).toEqual([]);
    }, SCALING_TEST_TIMEOUT_MS);
  }

  it('still return every element before a nest that is too deep, and every element of a nest within the bound', () => {
    const shallow = nested(65);
    expect(safeExtractXmlElements(shallow, 'row')).toHaveLength(1);
    const tooDeep = `<row>a</row><row>b</row>${nested(66)}<row>c</row>`;
    expect(safeExtractXmlElements(tooDeep, 'row').map((element) => element.content)).toEqual(['a', 'b']);
  });
});
