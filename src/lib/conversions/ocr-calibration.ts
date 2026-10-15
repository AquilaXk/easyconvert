import { OcrEngineUnavailableError } from '../types';
import type { OcrLineBlock, OcrResult, OcrWord } from './ocr-pdf-combiner';
import engWasm from './ocr-calibration/eng.wasm.json';
import engCli from './ocr-calibration/eng.cli.json';
import korWasm from './ocr-calibration/kor.wasm.json';
import korCli from './ocr-calibration/kor.cli.json';

/**
 * The engine's word confidence is a raw score, not a probability: a page can read perfectly at a
 * mean score of 0.7 and misread words can score 0.8. Each word's score is mapped to the observed
 * share of correct words at that score (isotonic regression; Zadrozny and Elkan, 2002) with a
 * table per language and engine path, fitted by tests/helpers/fit-ocr-calibration.mts on rendered
 * pages whose text is known. A language without a table keeps the raw score and says so.
 */

/** The recognizers that produce word scores: the WebAssembly engine and the native command line tool. */
export type OcrEnginePath = 'wasm' | 'cli';

export interface CalibrationProvenance {
  /** What the table was fitted on: how the pages were made and where the labels come from. */
  method: string;
  engine: string;
  languageData: string;
  fittedOn: { pages: string[]; degradations: string[]; words: number; correctWords: number };
  generator: string;
}

export interface CalibrationTable {
  language: string;
  enginePath: OcrEnginePath;
  /** Raw engine confidence of each knot, 0..1, strictly increasing. */
  x: number[];
  /** Share of correct words at each knot, 0..1, never decreasing. */
  y: number[];
  provenance: CalibrationProvenance;
}

/** Pooled blocks of fewer samples than this are merged into a neighbour so a table does not follow noise. */
export const CALIBRATION_MIN_BLOCK_SAMPLES = 30;
/** Most knots a table may hold; a fitted table has a few dozen. */
const MAX_TABLE_KNOTS = 256;

const TABLES: ReadonlyArray<CalibrationTable> = [
  engWasm as CalibrationTable,
  engCli as CalibrationTable,
  korWasm as CalibrationTable,
  korCli as CalibrationTable,
];

function invalidTable(table: CalibrationTable, why: string): OcrEngineUnavailableError {
  return new OcrEngineUnavailableError(`OCR calibration table ${table.language}/${table.enginePath} is invalid: ${why}.`);
}

/** A table that is not a monotone map from 0..1 to 0..1 would silently corrupt every confidence. */
export function assertCalibrationTable(table: CalibrationTable): CalibrationTable {
  const { x, y } = table;
  if (!Array.isArray(x) || !Array.isArray(y) || x.length === 0 || x.length !== y.length) {
    throw invalidTable(table, 'knots are missing or unequal');
  }
  if (x.length > MAX_TABLE_KNOTS) throw invalidTable(table, `more than ${MAX_TABLE_KNOTS} knots`);
  for (let i = 0; i < x.length; i++) {
    const inRange = x[i] >= 0 && x[i] <= 1 && y[i] >= 0 && y[i] <= 1;
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i]) || !inRange) throw invalidTable(table, 'a knot is outside 0..1');
    if (i > 0 && !(x[i] > x[i - 1])) throw invalidTable(table, 'raw scores do not increase');
    if (i > 0 && y[i] < y[i - 1]) throw invalidTable(table, 'probabilities decrease');
  }
  return table;
}

const TABLE_BY_KEY = new Map<string, CalibrationTable>(
  TABLES.map((table) => [`${table.language}/${table.enginePath}`, assertCalibrationTable(table)])
);

/** The table for a recognition language (such as `eng`) and engine path, or null when none was fitted. */
export function calibrationTableFor(language: string | undefined, enginePath: OcrEnginePath): CalibrationTable | null {
  if (!language) return null;
  return TABLE_BY_KEY.get(`${language}/${enginePath}`) ?? null;
}

/** Maps a raw score (0..1) to the probability the word is correct: linear between knots, flat beyond them. */
export function calibrateScore(raw: number, table: Pick<CalibrationTable, 'x' | 'y'>): number {
  const { x, y } = table;
  if (raw <= x[0]) return y[0];
  const last = x.length - 1;
  if (raw >= x[last]) return y[last];
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (x[middle] <= raw) low = middle;
    else high = middle;
  }
  const share = (raw - x[low]) / (x[high] - x[low]);
  return y[low] + share * (y[high] - y[low]);
}

export interface CalibrationSample {
  /** Raw engine confidence, 0..1. */
  raw: number;
  correct: boolean;
}

interface Block {
  weight: number;
  /** Sum of raw scores of the block's samples. */
  rawSum: number;
  correct: number;
}

function blockMean(block: Block): number {
  return block.correct / block.weight;
}

function pool(into: Block, from: Block): void {
  into.weight += from.weight;
  into.rawSum += from.rawSum;
  into.correct += from.correct;
}

/**
 * Isotonic regression of correctness on the raw score by pool-adjacent-violators: samples with the
 * same score are pooled first, then neighbouring blocks are merged while a block's share of correct
 * words is lower than its predecessor's. Blocks of fewer than `minBlockSamples` samples are then
 * merged into the neighbour with the closer mean. Each block becomes one knot at its mean raw score.
 */
export function fitIsotonicTable(
  samples: readonly CalibrationSample[],
  minBlockSamples = CALIBRATION_MIN_BLOCK_SAMPLES
): { x: number[]; y: number[] } {
  if (samples.length === 0) throw new Error('Calibration needs at least one labelled word');
  const sorted = [...samples].sort((a, b) => a.raw - b.raw);
  const stack: Block[] = [];
  const push = (block: Block): void => {
    stack.push(block);
    while (stack.length > 1 && blockMean(stack[stack.length - 2]) >= blockMean(stack[stack.length - 1])) {
      const top = stack.pop() as Block;
      pool(stack[stack.length - 1], top);
    }
  };
  for (let i = 0; i < sorted.length; ) {
    const block: Block = { weight: 0, rawSum: 0, correct: 0 };
    const raw = sorted[i].raw;
    for (; i < sorted.length && sorted[i].raw === raw; i++) {
      block.weight++;
      block.rawSum += raw;
      if (sorted[i].correct) block.correct++;
    }
    push(block);
  }
  // Small blocks follow noise; fold each into the neighbour whose mean is closest, which keeps the order.
  let smallest = stack.findIndex((block) => block.weight < minBlockSamples);
  while (stack.length > 1 && smallest !== -1) {
    const mean = blockMean(stack[smallest]);
    const before = smallest > 0 ? Math.abs(blockMean(stack[smallest - 1]) - mean) : Infinity;
    const after = smallest < stack.length - 1 ? Math.abs(blockMean(stack[smallest + 1]) - mean) : Infinity;
    const target = before <= after ? smallest - 1 : smallest + 1;
    pool(stack[Math.min(smallest, target)], stack[Math.max(smallest, target)]);
    stack.splice(Math.max(smallest, target), 1);
    smallest = stack.findIndex((block) => block.weight < minBlockSamples);
  }
  const x: number[] = [];
  const y: number[] = [];
  for (const block of stack) {
    const knotX = block.rawSum / block.weight;
    if (x.length > 0 && knotX <= x[x.length - 1]) continue;
    x.push(knotX);
    y.push(blockMean(block));
  }
  return { x, y };
}

function wordCharacters(word: OcrWord): number {
  return Array.from(word.text).length;
}

/**
 * How much of a page was read, and how well: the sum over its words of confidence times length in
 * characters. A page read in full at a given confidence scores higher than the same text read in part,
 * which the mean confidence cannot show, and marks read from noise add little because their confidence is low.
 */
export function confidenceWeightedCharacters(lineBlocks: readonly OcrLineBlock[]): number {
  let total = 0;
  for (const block of lineBlocks) {
    for (const word of block.words) {
      if (word.confidence !== undefined) total += word.confidence * wordCharacters(word);
    }
  }
  return total;
}

/**
 * Page confidence: the mean of the words' confidences weighted by their length in characters, so
 * a long misread word weighs more than a stray mark. Null when no word carries a confidence.
 */
export function characterWeightedConfidence(lineBlocks: readonly OcrLineBlock[]): number | null {
  let weighted = 0;
  let characters = 0;
  for (const block of lineBlocks) {
    for (const word of block.words) {
      if (word.confidence === undefined) continue;
      const length = wordCharacters(word);
      weighted += word.confidence * length;
      characters += length;
    }
  }
  return characters > 0 ? weighted / characters : null;
}

/**
 * Replaces each word's raw score with the calibrated probability when a table exists for the
 * result's language and engine path, and sets the page confidence to the character-weighted mean of
 * the words' confidences. Without a table the words keep their raw scores (0..1) and the result says
 * `confidenceCalibrated: false`. Every confidence in the result is within 0..1.
 */
export function calibrateOcrResult(result: OcrResult, enginePath: OcrEnginePath): OcrResult {
  const table = calibrationTableFor(result.language, enginePath);
  const lineBlocks = result.lineBlocks?.map((block) => ({
    ...block,
    words: block.words.map((word) => {
      if (word.confidence === undefined) return word;
      const raw = Math.min(1, Math.max(0, word.confidence));
      return { ...word, confidence: table ? calibrateScore(raw, table) : raw };
    }),
  }));
  return {
    ...result,
    lineBlocks,
    confidence: characterWeightedConfidence(lineBlocks ?? []),
    confidenceCalibrated: table !== null,
  };
}
