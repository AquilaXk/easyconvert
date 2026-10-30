import { describe, expect, it } from 'vitest';
import { htmlToText, trimBlanksBeforeLineBreaks } from '../src/lib/conversions/office/html-text';
import { expectNoHangOnInput } from './helpers/timing';

/**
 * The blanks in front of a line break are cut by a pass over the text, not by a pattern that restarts at every blank of a run:
 * the pattern `[ \t]+\n` took 4.5 s for 100,000 tabs followed by a letter. The text that `htmlToText` hands to it holds no tab
 * (every white space run of a text node is one space), so this guards the helper as well as the page text.
 */

describe('blanks in front of a line break', () => {
  it('are cut, and the line breaks, the blanks after them and the last line stay as they were', () => {
    expect(trimBlanksBeforeLineBreaks('a \t \nb\t\n\n c \t')).toBe('a\nb\n\n c \t');
    expect(trimBlanksBeforeLineBreaks('\t\nx')).toBe('\nx');
    expect(trimBlanksBeforeLineBreaks('no break \t')).toBe('no break \t');
  });

  it('are cut within the hang guard when a run of 300,000 tabs is not followed by a line break', async () => {
    const run = `a${'\t'.repeat(300_000)}x\n`;
    const { largeResult } = await expectNoHangOnInput('a run of tabs', (text: string) => trimBlanksBeforeLineBreaks(text), run);
    expect(largeResult).toBe(run);
  });
});

describe('the page text keeps its lines', () => {
  it('reads a run of tabs and a paragraph break as one space and one blank line', () => {
    expect(htmlToText(`<p>a${'\t'.repeat(100_000)}x</p><p>b \t </p>`)).toBe('a x\n\nb');
  });
});
