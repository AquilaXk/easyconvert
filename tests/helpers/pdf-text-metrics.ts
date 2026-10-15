import { characterErrorRatePercent, normalizeOcrText } from './ocr-cer';

/**
 * Text-extraction metrics for the PDF golden set. Independent of the extractor: CER is the plain Levenshtein
 * oracle of the OCR tests, and the order metric locates each expected paragraph in the extracted text by its own
 * opening characters, so it does not depend on how the extractor splits paragraphs.
 */

const ANCHOR_CHARS = 20;

/** Character error rate as a fraction (0.01 is 1 percent), after the shared normalisation. */
export function cer(reference: string, hypothesis: string): number {
  return characterErrorRatePercent(reference, hypothesis) / 100;
}

/** Words of the text, lower-cased, split on anything that is not a letter or digit. */
function wordsOf(text: string): string[] {
  return normalizeOcrText(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** F1 of the word multisets of the hypothesis against the reference. */
export function wordF1(reference: string, hypothesis: string): number {
  const ref = wordsOf(reference);
  const hyp = wordsOf(hypothesis);
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

/**
 * Kendall tau-a between the order the paragraphs should come in and the order they are found in the text.
 * Each paragraph is located by its first characters; a paragraph that is not found makes the result -Infinity so a
 * test cannot pass on missing text.
 */
export function paragraphOrderTau(paragraphs: readonly string[], extracted: string): number {
  const haystack = normalizeOcrText(extracted);
  const positions: number[] = [];
  for (const paragraph of paragraphs) {
    const anchor = normalizeOcrText(paragraph).slice(0, ANCHOR_CHARS);
    const at = haystack.indexOf(anchor);
    if (at < 0) return Number.NEGATIVE_INFINITY;
    positions.push(at);
  }
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      if (positions[i] < positions[j]) concordant++;
      else discordant++;
    }
  }
  const pairs = concordant + discordant;
  return pairs === 0 ? 1 : (concordant - discordant) / pairs;
}

/** Control characters other than line feed and tab, which no extracted text may contain. */
export function hasControlCharacters(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}
