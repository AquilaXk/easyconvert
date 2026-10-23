import type { PdfArray, PdfValue } from './pdf-document';

/**
 * The widths a CIDFont's /W array (ISO 32000-1 section 9.7.4.3) gives the CIDs from one CID to another, read by the rules
 * pdfjs reads /W with (`extractWidths`, src/core/evaluator.js): `c [w1 w2 ...]` gives consecutive CIDs from c their widths and
 * `c1 c2 w` gives the CIDs c1 to c2 one width; a start that is no integer ends the array, a width that is no number is
 * skipped, and a later entry for a CID wins.
 *
 * The bounds are ours: pdfjs reads every entry of a nested array whatever CIDs are asked for, so one array that /W names
 * again and again costs its length each time. Here a pair costs at most the CIDs asked for, an array's widths are read
 * once however many fonts share it, and one reader gives no width at all once it has spent its steps.
 */

/**
 * Steps one reader may spend. A /W that lists each of the 65,536 CIDs as a pair of its own costs about 65,700 (one step a
 * pair, and the widths in the span asked for); the largest document of the real-world corpus (1,241 PDFs, 294 with composite
 * fonts) spends 1,655 on all its fonts, and 148 on the fonts the pass reads. The limit is 16 times the first and keeps a
 * hostile /W to tens of milliseconds.
 */
export const MAX_WIDTH_STEPS = 1 << 20;

type WidthsByArray = WeakMap<PdfArray, Map<string, Map<number, number>>>;

function isArray(value: PdfValue | undefined): value is PdfArray {
  return typeof value === 'object' && value !== null && value.kind === 'array';
}

export class CidWidthReader {
  private steps = 0;
  private readonly known: WidthsByArray = new WeakMap();

  /**
   * @param resolve follows references to the object they name
   * @param limit steps (the pairs of an array and the widths of its nested arrays that are read) after which no width is given
   */
  constructor(
    private readonly resolve: (value: PdfValue | undefined) => PdfValue,
    private readonly limit: number = MAX_WIDTH_STEPS
  ) {}

  get stepsUsed(): number {
    return this.steps;
  }

  /** The widths of /W (`value`, resolved first) for the CIDs from `first` to `last`; none when /W is no array or the steps are spent. */
  read(value: PdfValue | undefined, first: number, last: number): Map<number, number> {
    const array = this.resolve(value);
    if (!isArray(array)) return new Map();
    const span = `${first}:${last}`;
    let spans = this.known.get(array);
    if (spans === undefined) {
      spans = new Map();
      this.known.set(array, spans);
    }
    let widths = spans.get(span);
    if (widths === undefined) {
      widths = this.widthsOf(array, first, last);
      if (this.steps <= this.limit) spans.set(span, widths);
    }
    return widths;
  }

  /** Counts `count` steps; false once more than the limit are spent. */
  private spend(count: number): boolean {
    this.steps += count;
    return this.steps <= this.limit;
  }

  private widthsOf(array: PdfArray, first: number, last: number): Map<number, number> {
    const slots = new Float64Array(last - first + 1).fill(Number.NaN);
    const { items } = array;
    for (let i = 0; i + 1 < items.length; i += 2) {
      if (!this.spend(1)) return new Map();
      const start = this.resolve(items[i]);
      if (typeof start !== 'number' || !Number.isInteger(start)) break;
      const next = this.resolve(items[i + 1]);
      if (isArray(next)) {
        const from = Math.max(0, first - start);
        const to = Math.min(next.items.length, last - start + 1);
        if (to > from && !this.spend(to - from)) return new Map();
        for (let index = from; index < to; index++) {
          const width = this.resolve(next.items[index]);
          if (typeof width === 'number') slots[start + index - first] = width;
        }
      } else if (typeof next === 'number' && Number.isInteger(next)) {
        const width = this.resolve(items[i + 2]);
        i++;
        if (typeof width === 'number' && start <= last && next >= first) slots.fill(width, Math.max(start, first) - first, Math.min(next, last) - first + 1);
      } else {
        break;
      }
    }
    const widths = new Map<number, number>();
    slots.forEach((width, index) => {
      if (!Number.isNaN(width)) widths.set(first + index, width);
    });
    return widths;
  }
}
