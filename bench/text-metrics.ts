import { characterErrorRatePercent, normalizeOcrText } from '../tests/helpers/ocr-cer';

/**
 * Text scoring against ground truth. Character error rate comes from the test suite's independent Levenshtein
 * helper; word F1 is a multiset overlap of lower-cased word tokens.
 */

export { characterErrorRatePercent };

/** A word is a run of letters and digits; each Han or kana character is a word of its own, since those scripts have no spaces. */
const WORD_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{N}])+/gu;

function words(text: string): string[] {
  return normalizeOcrText(text).toLowerCase().match(WORD_PATTERN) ?? [];
}

/** F1 of the word multisets of `hypothesis` against `reference`, in 0..1. */
export function wordF1(reference: string, hypothesis: string): number {
  const ref = words(reference);
  const hyp = words(hypothesis);
  if (ref.length === 0) throw new RangeError('word F1 needs a reference with at least one word');
  if (hyp.length === 0) return 0;
  const available = new Map<string, number>();
  for (const word of ref) available.set(word, (available.get(word) ?? 0) + 1);
  let matched = 0;
  for (const word of hyp) {
    const left = available.get(word) ?? 0;
    if (left > 0) {
      matched++;
      available.set(word, left - 1);
    }
  }
  if (matched === 0) return 0;
  const precision = matched / hyp.length;
  const recall = matched / ref.length;
  return (2 * precision * recall) / (precision + recall);
}
