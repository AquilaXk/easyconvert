/**
 * Independent character-error-rate oracle for OCR tests. It shares no code with the OCR engine:
 * text is normalized (NFKC, whitespace collapsed) and compared with a plain Levenshtein distance.
 */

export function normalizeOcrText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Levenshtein distance over UTF-16 code units, using two rolling rows. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/** Character error rate in percent: edit distance over the reference length. */
export function characterErrorRatePercent(reference: string, hypothesis: string): number {
  const ref = normalizeOcrText(reference);
  const hyp = normalizeOcrText(hypothesis);
  if (ref.length === 0) {
    throw new Error('CER needs a non-empty reference text');
  }
  return (levenshtein(ref, hyp) / ref.length) * 100;
}
