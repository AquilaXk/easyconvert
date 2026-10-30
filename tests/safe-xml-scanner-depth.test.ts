import { describe, expect, it } from 'vitest';
import { safeExtractXmlElements } from '../src/lib/conversions/safe-xml-scanner';
import { SCALING_TEST_TIMEOUT_MS, SCALING_FACTOR, cpuClockMs, expectLinearOnInputs } from './helpers/timing';

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
        { small: build(OPENINGS), large: build(OPENINGS * SCALING_FACTOR), clock: cpuClockMs }
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

/**
 * The search for the next opening and the next closing of a tag used to start afresh at every step, so a search that found nothing (or
 * found the close far ahead) walked to the end of the input each time. 80,000 self-closing children of one element took 13.7 s, and 64,000
 * openings after a stray closing tag 7.8 s. A search that has already answered for an earlier position answers for the later ones.
 */
const CHILDREN = 5_000;
const childrenOfOne = (count: number): string => `<T>${'<T/>'.repeat(count)}</T>`;
const openingsAfterStrayClose = (count: number): string => `</t>${'<t id="1">'.repeat(count)}`;

describe('one open tag with many self-closing children, and openings after a stray closing tag', () => {
  it('cost CPU time linear in the number of self-closing children of one open tag', async () => {
    const { largeResult } = await expectLinearOnInputs(
      'self-closing children',
      (xml: string) => safeExtractXmlElements(xml, 'T'),
      { small: childrenOfOne(CHILDREN), large: childrenOfOne(CHILDREN * SCALING_FACTOR), clock: cpuClockMs }
    );
    expect(largeResult).toHaveLength(1);
    expect(largeResult[0].content).toBe('<T/>'.repeat(CHILDREN * SCALING_FACTOR));
  }, SCALING_TEST_TIMEOUT_MS);

  it('cost CPU time linear in the number of openings that follow a stray closing tag', async () => {
    const { largeResult } = await expectLinearOnInputs(
      'openings after a stray close',
      (xml: string) => safeExtractXmlElements(xml, 't'),
      { small: openingsAfterStrayClose(CHILDREN), large: openingsAfterStrayClose(CHILDREN * SCALING_FACTOR), clock: cpuClockMs }
    );
    expect(largeResult).toEqual([]);
  }, SCALING_TEST_TIMEOUT_MS);

  it('still close each opening that has a close, and skip the closes that only share a name prefix', () => {
    const xml = '</t>a<t id="1">b</t><t id="2"><tx></tx></t><t id="3">';
    const found = safeExtractXmlElements(xml, 't').map((element) => [element.attrs.id, element.content]);
    expect(found).toEqual([['1', 'b'], ['2', '<tx></tx>']]);
  });
});
