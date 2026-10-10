import type { OcrBBox, OcrWord } from './ocr-pdf-combiner';

/**
 * For Korean, Japanese and Chinese the recognizer reports one syllable or character per "word",
 * while the page text it produces keeps the original spacing. Words are rebuilt from that text:
 * consecutive boxes with no whitespace between them in the page text form one word. The same step
 * runs once for every consumer (plain text, searchable PDF text layer, hOCR and ALTO), and Latin
 * words, which are already separated by whitespace, pass through unchanged.
 */

/** Whether the engine's boxes agree with its page text. */
export type OcrWordMerge = 'aligned' | 'unaligned';

const WHITESPACE = /\s/u;

/**
 * For each box, whether whitespace (or the end of the text) follows it in `pageText`, or null when
 * the boxes do not spell out the page text: a box whose text is not next in the page text, or
 * characters other than whitespace left over. One pass over the text, so linear in its length.
 */
export function wordBoundariesAfter(pageText: string, boxTexts: readonly string[]): boolean[] | null {
  const boundaryAfter = new Array<boolean>(boxTexts.length).fill(false);
  let at = 0;
  for (let index = 0; index < boxTexts.length; index++) {
    let skipped = false;
    while (at < pageText.length && WHITESPACE.test(pageText[at])) {
      at++;
      skipped = true;
    }
    if (skipped && index > 0) boundaryAfter[index - 1] = true;
    const boxText = boxTexts[index];
    if (boxText.length === 0 || !pageText.startsWith(boxText, at)) return null;
    at += boxText.length;
  }
  while (at < pageText.length) {
    if (!WHITESPACE.test(pageText[at])) return null;
    at++;
  }
  if (boxTexts.length > 0) boundaryAfter[boxTexts.length - 1] = true;
  return boundaryAfter;
}

function unionBox(members: readonly OcrWord[]): OcrBBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const member of members) {
    x0 = Math.min(x0, member.bbox.x);
    y0 = Math.min(y0, member.bbox.y);
    x1 = Math.max(x1, member.bbox.x + member.bbox.width);
    y1 = Math.max(y1, member.bbox.y + member.bbox.height);
  }
  return { ...members[0].bbox, x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** One word from consecutive boxes: joined text, union box, and the lowest confidence of its parts. */
function joinBoxes(members: readonly OcrWord[]): OcrWord {
  let confidence: number | undefined;
  for (const member of members) {
    if (member.confidence !== undefined && (confidence === undefined || member.confidence < confidence)) {
      confidence = member.confidence;
    }
  }
  return {
    ...members[0],
    text: members.map((member) => member.text).join(''),
    bbox: unionBox(members),
    confidence,
  };
}

/**
 * Groups `items` (in reading order) with the boundaries from `wordBoundariesAfter`:
 * `boundaryAfter[i]` closes the group that holds item `i`, and `join` makes one item of a group.
 */
export function groupAtBoundaries<T>(
  items: readonly T[],
  boundaryAfter: readonly boolean[],
  join: (group: readonly T[]) => T
): T[] {
  const grouped: T[] = [];
  let group: T[] = [];
  for (let index = 0; index < items.length; index++) {
    group.push(items[index]);
    if (boundaryAfter[index]) {
      grouped.push(group.length === 1 ? group[0] : join(group));
      group = [];
    }
  }
  if (group.length > 0) grouped.push(group.length === 1 ? group[0] : join(group));
  return grouped;
}

/**
 * Merges the boxes of text whose spacing is `pageText`. When the boxes and the text disagree the
 * boxes are kept as the engine reported them and the outcome is 'unaligned'; no text is invented.
 */
export function mergeWordsWithPageText(
  pageText: string,
  words: readonly OcrWord[]
): { words: OcrWord[]; wordMerge: OcrWordMerge } {
  const boundaryAfter = wordBoundariesAfter(
    pageText,
    words.map((word) => word.text)
  );
  if (boundaryAfter === null) return { words: [...words], wordMerge: 'unaligned' };
  return { words: groupAtBoundaries(words, boundaryAfter, joinBoxes), wordMerge: 'aligned' };
}

/** Combines per-line outcomes: one unaligned line makes the page unaligned; no words leaves it unset. */
export function combineWordMerge(outcomes: readonly OcrWordMerge[]): OcrWordMerge | undefined {
  if (outcomes.length === 0) return undefined;
  return outcomes.includes('unaligned') ? 'unaligned' : 'aligned';
}
