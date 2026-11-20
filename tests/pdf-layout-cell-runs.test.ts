import { describe, expect, it } from 'vitest';
import { splitAtLines } from '../src/lib/conversions/pdf-layout/cell-runs';
import type { PdfContentItem } from '../src/lib/conversions/pdf-text-types';

/**
 * A run that crosses the lines of a ruled table is cut at them. The widths of the characters are estimated, so the cut is moved to
 * a place that breaks no word, and a line with no such place near it cuts nothing.
 */

function run(text: string, x: number, width: number, extra: Partial<PdfContentItem> = {}): PdfContentItem {
  return { text, x, baseline: 100, width, size: 10, font: 0, rtl: false, angled: false, vertical: false, ...extra };
}

describe('splitAtLines', () => {
  it('cuts headings that came as one run at the white space between them', () => {
    const heading = '3 Bedroom 4 Bedroom 5 Bedroom';
    // Three equal headings of 9 characters, each 50 points wide with a 7 point gap, drawn in a row.
    const pieces = splitAtLines(run(heading, 0, 164), [57, 114]);
    expect(pieces.map((piece) => piece.text)).toEqual(['3 Bedroom', '4 Bedroom', '5 Bedroom']);
    expect(pieces[0].x).toBe(0);
    expect(pieces[1].x).toBeGreaterThan(50);
    expect(pieces[2].x + pieces[2].width).toBeCloseTo(164, 5);
  });

  it('cuts a name from the next cell where a lowercase letter meets a capital', () => {
    const pieces = splitAtLines(run('Aroostook Band of MicMacMaine', 38, 136), [149]);
    expect(pieces.map((piece) => piece.text)).toEqual(['Aroostook Band of MicMac', 'Maine']);
  });

  it('cuts at a letter and a digit', () => {
    expect(splitAtLines(run('Total2024', 0, 45), [26]).map((piece) => piece.text)).toEqual(['Total', '2024']);
  });

  it('does not cut inside a word', () => {
    const item = run('universityvarious', 0, 80);
    expect(splitAtLines(item, [40])).toEqual([item]);
  });

  it('returns a run that no line crosses, a run of right-to-left text and a vertical run as they are', () => {
    const item = run('Alabama State', 0, 60);
    expect(splitAtLines(item, [])).toEqual([item]);
    const arabic = run('abc def', 0, 30, { rtl: true });
    expect(splitAtLines(arabic, [15])).toEqual([arabic]);
    const vertical = run('abc def', 0, 30, { vertical: true });
    expect(splitAtLines(vertical, [15])).toEqual([vertical]);
  });

  it('gives each piece the colours of its own characters', () => {
    const item = run('red blue', 0, 40, {
      colors: [
        { end: 3, color: 0xff0000 },
        { end: 8, color: 0x0000ff },
      ],
    });
    const pieces = splitAtLines(item, [20]);
    expect(pieces.map((piece) => piece.text)).toEqual(['red', 'blue']);
    expect(pieces[0].colors).toEqual([{ end: 3, color: 0xff0000 }]);
    expect(pieces[1].colors).toEqual([{ end: 4, color: 0x0000ff }]);
  });
});
