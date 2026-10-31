import { describe, expect, it } from 'vitest';
import { ParagraphBuilder } from '../src/lib/conversions/pdf-layout/paragraphs';
import { firstChar, isLowercase, lastChar } from '../src/lib/conversions/pdf-layout/text-chars';
import type { LayoutLine } from '../src/lib/conversions/pdf-layout/types';
import { generateRun, HYPHENS, openParagraph, paragraphOf, seeded } from './pdf-layout-reference';

/**
 * `ParagraphBuilder` joins the lines of a paragraph as they come, so a run of paragraphs that continue into one another is
 * built once. The paragraph it makes must be the one the join of all the lines at once makes, whatever the lines, and its
 * `end()` must be what the finished paragraph says of its end. The references are the join and the reading of a finished
 * paragraph as they were before the builder (tests/pdf-layout-reference.ts).
 */

const SEED = 0x5eed930;
const CASES = 600;

describe(`ParagraphBuilder over ${CASES} generated runs of lines (seed ${SEED.toString(16)})`, () => {
  const random = seeded(SEED);
  const runs = Array.from({ length: CASES }, () => generateRun(random));

  it('makes the paragraph that joining all of its lines at once makes, after every page of the run', () => {
    let compared = 0;
    for (const [caseIndex, pages] of runs.entries()) {
      const flow = caseIndex % 7;
      const full = caseIndex % 3 === 0;
      const builder = new ParagraphBuilder(flow, caseIndex + 1, full);
      const seen: LayoutLine[] = [];
      for (const page of pages) {
        builder.addAll(page);
        seen.push(...page);
        expect(builder.finish(), `case ${caseIndex}`).toEqual(paragraphOf([...seen], flow, caseIndex + 1, full));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(CASES);
  });

  it('says of its end after every line what the finished paragraph says of it', () => {
    let compared = 0;
    for (const [caseIndex, pages] of runs.entries()) {
      const builder = new ParagraphBuilder(caseIndex % 7, caseIndex + 1, caseIndex % 3 === 0);
      for (const line of pages.flat()) {
        builder.add(line);
        expect(builder.end(), `case ${caseIndex}`).toEqual(openParagraph(builder.finish()));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(CASES);
  });

  it('covers the cases it is built for', () => {
    const lines = runs.flat(2);
    const texts = lines.map((line) => line.text);
    const endsInHyphenThenLower = lines.some((line, index) => index > 0 && HYPHENS.has(lastChar(texts[index - 1])) && isLowercase(firstChar(line.text)));
    expect(endsInHyphenThenLower).toBe(true);
    expect(texts.some((text) => /\s$/u.test(text) && text.trim() !== '')).toBe(true);
    expect(texts.some((text) => /[֐-ۿ]/u.test(text))).toBe(true);
    expect(lines.some((line) => line.rtl)).toBe(true);
    expect(runs.some((pages) => pages.length > 3)).toBe(true);
    expect(runs.some((pages) => pages.flat().length === 1)).toBe(true);
    expect(new Set(lines.map((line) => line.text.length)).size).toBeLessThan(lines.length / 4);
  });
});
