import { normalizeOcrText } from './ocr-cer';
import type { DocxStructure } from './docx-structure';
import { teds } from './teds';

/**
 * Scores the structure of a DOCX against the blocks a document was written from: headings, list items, tables,
 * columns, paragraph count and reading order. Texts are compared after the shared normalisation; the numbers are
 * counts and ratios, aggregated over a corpus by `aggregate`.
 */

export type TruthBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; bordered: boolean; rows: string[][] }
  | { type: 'image'; file: string; width: number; height: number };

export interface StructureTruth {
  columns: number;
  blocks: TruthBlock[];
}

export interface Counts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface DocumentScore {
  headings: Counts;
  /** Headings found with the right text and the right level. */
  headingLevelHits: number;
  headingMatches: number;
  listItems: Counts;
  /** TEDS of each reference table against its best predicted table. */
  tableScores: number[];
  tablesPredicted: number;
  columnsCorrect: boolean;
  paragraphError: number;
  readingOrderTau: number;
}

const ANCHOR_CHARS = 20;
const norm = (text: string): string => normalizeOcrText(text);

/** Matches two multisets of texts. */
function matchCounts(truth: string[], predicted: string[]): { counts: Counts; matched: Map<string, number> } {
  const available = new Map<string, number>();
  for (const text of truth.map(norm)) available.set(text, (available.get(text) ?? 0) + 1);
  const matched = new Map<string, number>();
  let truePositives = 0;
  for (const text of predicted.map(norm)) {
    const left = available.get(text) ?? 0;
    if (left > 0) {
      truePositives++;
      available.set(text, left - 1);
      matched.set(text, (matched.get(text) ?? 0) + 1);
    }
  }
  return { counts: { truePositives, falsePositives: predicted.length - truePositives, falseNegatives: truth.length - truePositives }, matched };
}

function kendallTau(positions: number[]): number {
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

export function scoreStructure(truth: StructureTruth, docx: DocxStructure): DocumentScore {
  const body = docx.paragraphs.filter((paragraph) => !paragraph.inTable && paragraph.text.trim() !== '');
  const truthHeadings = truth.blocks.filter((block): block is Extract<TruthBlock, { type: 'heading' }> => block.type === 'heading');
  const predictedHeadings = body.filter((paragraph) => paragraph.headingLevel !== null);
  const headings = matchCounts(truthHeadings.map((block) => block.text), predictedHeadings.map((paragraph) => paragraph.text));
  // Level accuracy: of the headings found by text, how many carry the level they were written with, counting the levels
  // as ranks (a document without level-1 headings has its smallest level first).
  const writtenLevels = [...new Set(truthHeadings.map((block) => block.level))].sort((a, b) => a - b);
  let headingLevelHits = 0;
  for (const block of truthHeadings) {
    const found = predictedHeadings.find((paragraph) => norm(paragraph.text) === norm(block.text));
    if (found && found.headingLevel === writtenLevels.indexOf(block.level) + 1) headingLevelHits++;
  }

  const truthItems = truth.blocks.flatMap((block) => (block.type === 'list' ? block.items : []));
  const predictedItems = body.filter((paragraph) => paragraph.list !== null && paragraph.headingLevel === null).map((paragraph) => paragraph.text);
  const listItems = matchCounts(truthItems, predictedItems);

  const truthTables = truth.blocks.filter((block): block is Extract<TruthBlock, { type: 'table' }> => block.type === 'table');
  const tableScores = truthTables.map((table) => Math.max(0, ...docx.tables.map((candidate) => teds(table.rows, candidate))));

  const truthParagraphs = truth.blocks.filter((block) => block.type === 'paragraph').length;
  const predictedParagraphs = body.filter((paragraph) => paragraph.headingLevel === null && paragraph.list === null).length;

  // Reading order: where each written text starts in the text of the whole result.
  const flat = norm([...docx.paragraphs.map((paragraph) => paragraph.text), ...docx.tables.flat().flat()].join(' '));
  const anchors = truth.blocks.flatMap((block) => {
    if (block.type === 'list') return block.items;
    if (block.type === 'table' || block.type === 'image') return [];
    return [block.text];
  });
  const positions: number[] = [];
  for (const anchor of anchors) {
    const at = flat.indexOf(norm(anchor).slice(0, ANCHOR_CHARS));
    if (at >= 0) positions.push(at);
  }
  // Text that is missing from the result lowers the score in proportion.
  const tau = anchors.length === 0 ? 1 : kendallTau(positions) * (positions.length / anchors.length);

  return {
    headings: headings.counts,
    headingLevelHits,
    headingMatches: headings.counts.truePositives,
    listItems: listItems.counts,
    tableScores,
    tablesPredicted: docx.tables.length,
    columnsCorrect: docx.maxColumns === truth.columns,
    paragraphError: truthParagraphs === 0 ? 0 : Math.abs(predictedParagraphs - truthParagraphs) / truthParagraphs,
    readingOrderTau: tau,
  };
}

function f1(counts: Counts): { precision: number; recall: number; f1: number } {
  const { truePositives: tp, falsePositives: fp, falseNegatives: fn } = counts;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return { precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) };
}

function sum(counts: Counts[]): Counts {
  return counts.reduce(
    (total, item) => ({
      truePositives: total.truePositives + item.truePositives,
      falsePositives: total.falsePositives + item.falsePositives,
      falseNegatives: total.falseNegatives + item.falseNegatives,
    }),
    { truePositives: 0, falsePositives: 0, falseNegatives: 0 }
  );
}

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

export interface CorpusScore {
  heading: { precision: number; recall: number; f1: number };
  headingLevelAccuracy: number;
  list: { precision: number; recall: number; f1: number };
  /** Mean TEDS over every reference table (a table that was not found scores 0). */
  tableTeds: number;
  columnAccuracy: number;
  /** Mean of |predicted - written| / written paragraph counts. */
  paragraphCountError: number;
  readingOrderTau: number;
}

export function aggregate(scores: DocumentScore[]): CorpusScore {
  const matches = scores.reduce((total, score) => total + score.headingMatches, 0);
  const levelHits = scores.reduce((total, score) => total + score.headingLevelHits, 0);
  return {
    heading: f1(sum(scores.map((score) => score.headings))),
    headingLevelAccuracy: matches === 0 ? 0 : levelHits / matches,
    list: f1(sum(scores.map((score) => score.listItems))),
    tableTeds: mean(scores.flatMap((score) => score.tableScores)),
    columnAccuracy: mean(scores.map((score) => (score.columnsCorrect ? 1 : 0))),
    paragraphCountError: mean(scores.map((score) => score.paragraphError)),
    readingOrderTau: mean(scores.map((score) => score.readingOrderTau)),
  };
}
