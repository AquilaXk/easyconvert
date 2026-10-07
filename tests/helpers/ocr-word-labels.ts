/**
 * Labels recognized words as correct or incorrect against the words that were drawn, by a
 * word-level Levenshtein alignment. It shares no code with the recognizer or the calibration
 * under test: the labels are the oracle that calibration is fitted to and scored against.
 */

/** Whitespace-separated words after NFKC normalization. */
export function splitWords(text: string): string[] {
  return text.normalize('NFKC').split(/\s+/).filter(Boolean);
}

/**
 * For each word of `hypothesis`, whether the alignment with `truth` pairs it with an equal word.
 * A word with no partner (an insertion) or paired with a different word (a substitution) is wrong.
 * Ties between equally cheap alignments prefer pairing, so a misread word costs one label, not two.
 */
export function labelWords(truth: readonly string[], hypothesis: readonly string[]): boolean[] {
  const rows = truth.length + 1;
  const cols = hypothesis.length + 1;
  const cost = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) cost[i][0] = i;
  for (let j = 0; j < cols; j++) cost[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const pair = cost[i - 1][j - 1] + (truth[i - 1] === hypothesis[j - 1] ? 0 : 1);
      cost[i][j] = Math.min(pair, cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }
  const labels = new Array<boolean>(hypothesis.length).fill(false);
  let i = truth.length;
  let j = hypothesis.length;
  while (i > 0 && j > 0) {
    const equal = truth[i - 1] === hypothesis[j - 1];
    if (cost[i][j] === cost[i - 1][j - 1] + (equal ? 0 : 1)) {
      labels[j - 1] = equal;
      i--;
      j--;
    } else if (cost[i][j] === cost[i - 1][j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  return labels;
}

export interface ScoredWord {
  /** Confidence in 0..1. */
  confidence: number;
  correct: boolean;
}

/**
 * Expected calibration error with equal-width bins: the sum over bins of
 * (share of words in the bin) x |mean confidence - accuracy|. A confidence of exactly 1 falls in the last bin.
 */
export function expectedCalibrationError(words: readonly ScoredWord[], bins: number): number {
  if (words.length === 0) throw new Error('Expected calibration error needs at least one word');
  const counts = new Array<number>(bins).fill(0);
  const confidenceSums = new Array<number>(bins).fill(0);
  const correctCounts = new Array<number>(bins).fill(0);
  for (const word of words) {
    const bin = Math.min(bins - 1, Math.floor(word.confidence * bins));
    counts[bin]++;
    confidenceSums[bin] += word.confidence;
    if (word.correct) correctCounts[bin]++;
  }
  let error = 0;
  for (let bin = 0; bin < bins; bin++) {
    if (counts[bin] === 0) continue;
    error += (counts[bin] / words.length) * Math.abs(confidenceSums[bin] / counts[bin] - correctCounts[bin] / counts[bin]);
  }
  return error;
}
