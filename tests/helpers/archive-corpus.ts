import { createHash } from 'node:crypto';

/**
 * Deterministic inputs for the archive encoder tests: a seeded word-model text, English-like prose, TypeScript-like
 * source, JSON records, incompressible bytes and long runs. Nothing here imports production code, so it can serve as
 * an independent corpus for ratio, golden and round-trip tests.
 */

const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const UINT32_RANGE = 4294967296;

/** A small seeded generator (an LCG); the same seed always yields the same stream. */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next uniform integer in [0, bound). */
  below(bound: number): number {
    this.state = (Math.imul(this.state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return Math.floor((this.state / UINT32_RANGE) * bound);
  }

  bytes(length: number): Buffer {
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i++) out[i] = this.below(256);
    return out;
  }
}

const COMMON_WORDS = [
  'the', 'of', 'and', 'to', 'in', 'a', 'is', 'that', 'for', 'it', 'as', 'was', 'with', 'be', 'by', 'on', 'not', 'he',
  'this', 'are', 'or', 'his', 'from', 'at', 'which', 'but', 'have', 'an', 'had', 'they', 'you', 'were', 'their',
  'one', 'all', 'we', 'can', 'her', 'has', 'there', 'been', 'if', 'more', 'when', 'will', 'would', 'who', 'so', 'no',
];
const RARE_SYLLABLES = ['ar', 'be', 'cor', 'den', 'el', 'fa', 'gor', 'hin', 'ist', 'jun', 'kel', 'lum', 'mar', 'nor', 'ost', 'pel', 'qua', 'ril', 'sen', 'tor', 'ul', 'ven', 'wyn', 'xe', 'yar', 'zen'];

/** English-like prose: a Zipf-ish mix of common words and invented rare words, in sentences and paragraphs. */
export function proseText(length: number, seed: number): Buffer {
  const rng = new SeededRandom(seed);
  const rare: string[] = [];
  for (let i = 0; i < 400; i++) {
    let w = '';
    const syllables = 2 + rng.below(3);
    for (let s = 0; s < syllables; s++) w += RARE_SYLLABLES[rng.below(RARE_SYLLABLES.length)];
    rare.push(w);
  }
  const parts: string[] = [];
  let total = 0;
  while (total < length) {
    const sentenceWords = 6 + rng.below(14);
    const words: string[] = [];
    for (let i = 0; i < sentenceWords; i++) {
      const pick = rng.below(100);
      words.push(pick < 62 ? COMMON_WORDS[rng.below(COMMON_WORDS.length)] : rare[rng.below(rare.length)]);
    }
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    const sentence = `${words.join(' ')}${rng.below(10) === 0 ? '?' : '.'}${rng.below(8) === 0 ? '\n\n' : ' '}`;
    parts.push(sentence);
    total += sentence.length;
  }
  return Buffer.from(parts.join('').slice(0, length), 'latin1');
}

const ZIPF_VOCABULARY = 1800;
const ZIPF_PHRASES = 6000;
/** Percentage of the text taken from the phrase book rather than single words. */
const ZIPF_PHRASE_SHARE = 30;
const ZIPF_PHRASE_WORDS_MIN = 2;
const ZIPF_PHRASE_WORDS_SPAN = 4;
const ZIPF_SENTENCE_END_ONE_IN = 9;
const ZIPF_SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'ti', 've', 'wo', 'da', 'ge', 'hu', 'jo', 'pa', 'qi', 'ze'];
const ZIPF_RESOLUTION = 1_000_000;

function zipfCumulative(count: number): Float64Array {
  const cumulative = new Float64Array(count);
  let sum = 0;
  for (let rank = 0; rank < count; rank++) {
    sum += 1 / (rank + 1);
    cumulative[rank] = sum;
  }
  return cumulative;
}

function zipfPick(rng: SeededRandom, cumulative: Float64Array): number {
  const target = (rng.below(ZIPF_RESOLUTION) / ZIPF_RESOLUTION) * cumulative[cumulative.length - 1];
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Running text from a Zipf-distributed vocabulary of invented words (rank r drawn with weight 1/r), part of it as
 * recurring multi-word phrases: its compressibility is that of English prose (a 1 MiB sample is about 0.19 of its
 * size under the strongest xz level), which is what the text ratio targets refer to.
 */
export function zipfText(length: number, seed: number): Buffer {
  const rng = new SeededRandom(seed);
  const words: string[] = [];
  for (let rank = 0; rank < ZIPF_VOCABULARY; rank++) {
    // Frequent words are short, as in natural language.
    const syllables = 1 + Math.min(3, Math.floor(Math.log2(rank + 2) / 3.5)) + rng.below(2);
    let w = '';
    for (let i = 0; i < syllables; i++) w += ZIPF_SYLLABLES[rng.below(ZIPF_SYLLABLES.length)];
    words.push(w);
  }
  const wordWeights = zipfCumulative(ZIPF_VOCABULARY);
  const book: string[] = [];
  for (let p = 0; p < ZIPF_PHRASES; p++) {
    const count = ZIPF_PHRASE_WORDS_MIN + rng.below(ZIPF_PHRASE_WORDS_SPAN);
    const phrase: string[] = [];
    for (let i = 0; i < count; i++) phrase.push(words[zipfPick(rng, wordWeights)]);
    book.push(phrase.join(' '));
  }
  const phraseWeights = zipfCumulative(ZIPF_PHRASES);
  const parts: string[] = [];
  let total = 0;
  while (total < length) {
    const piece = rng.below(100) < ZIPF_PHRASE_SHARE ? book[zipfPick(rng, phraseWeights)] : words[zipfPick(rng, wordWeights)];
    const text = piece + (rng.below(ZIPF_SENTENCE_END_ONE_IN) === 0 ? '. ' : ' ');
    parts.push(text);
    total += text.length;
  }
  return Buffer.from(parts.join('').slice(0, length), 'latin1');
}

const IDENTIFIERS = ['value', 'buffer', 'offset', 'length', 'result', 'options', 'input', 'output', 'index', 'state', 'config', 'header', 'chunk', 'table', 'symbol'];
const KEYWORDS = ['const', 'let', 'return', 'if', 'else', 'for', 'while', 'function', 'export', 'import', 'throw new Error'];

/** TypeScript-like source lines with repeated identifiers and indentation. */
export function sourceText(length: number, seed: number): Buffer {
  const rng = new SeededRandom(seed);
  const lines: string[] = [];
  let total = 0;
  let depth = 0;
  while (total < length) {
    const id = () => IDENTIFIERS[rng.below(IDENTIFIERS.length)];
    const kind = rng.below(6);
    let line: string;
    if (kind === 0) {
      line = `export function ${id()}${rng.below(40)}(${id()}: number, ${id()}: Uint8Array): number {`;
      depth++;
    } else if (kind === 1 && depth > 0) {
      line = '}';
      depth--;
    } else if (kind === 2) {
      line = `${KEYWORDS[rng.below(KEYWORDS.length)]} ${id()} = ${id()}[${id()} + ${rng.below(16)}] & 0x${rng.below(256).toString(16)};`;
    } else if (kind === 3) {
      line = `if (${id()} < ${id()}.length) ${id()} += ${rng.below(9)};`;
    } else if (kind === 4) {
      line = `// ${id()} of the ${id()} is ${rng.below(1000)} bytes`;
    } else {
      line = `return ${id()} ^ (${id()} >>> ${rng.below(31)});`;
    }
    const text = `${'  '.repeat(depth)}${line}\n`;
    lines.push(text);
    total += text.length;
  }
  return Buffer.from(lines.join('').slice(0, length), 'latin1');
}

/** JSON-lines records with a fixed schema and varying values. */
export function jsonRecords(length: number, seed: number): Buffer {
  const rng = new SeededRandom(seed);
  const cities = ['Seoul', 'Busan', 'Incheon', 'Daegu', 'Daejeon', 'Gwangju', 'Suwon', 'Ulsan'];
  const lines: string[] = [];
  let total = 0;
  while (total < length) {
    const rec = {
      id: lines.length,
      name: `user${rng.below(5000)}`,
      city: cities[rng.below(cities.length)],
      active: rng.below(2) === 0,
      score: rng.below(100000) / 100,
      tags: Array.from({ length: rng.below(4) }, () => COMMON_WORDS[rng.below(COMMON_WORDS.length)]),
    };
    const text = `${JSON.stringify(rec)}\n`;
    lines.push(text);
    total += text.length;
  }
  return Buffer.from(lines.join('').slice(0, length), 'latin1');
}

/** Long runs of a few byte values with occasional changes. */
export function runBytes(length: number, seed: number): Buffer {
  const rng = new SeededRandom(seed);
  const out = Buffer.alloc(length);
  let pos = 0;
  while (pos < length) {
    const value = rng.below(4) * 61;
    const run = 1 + rng.below(rng.below(8) === 0 ? 3000 : 40);
    out.fill(value, pos, Math.min(length, pos + run));
    pos += run;
  }
  return out;
}

export interface PinCorpusFile {
  name: string;
  data: Buffer;
}

/** The fixed corpus the golden pins are recorded on: text, source, JSON, binary noise and runs. */
export function pinCorpus(): PinCorpusFile[] {
  return [
    { name: 'prose-60k', data: proseText(60_000, 101) },
    { name: 'source-90k', data: sourceText(90_000, 202) },
    { name: 'json-70k', data: jsonRecords(70_000, 303) },
    { name: 'noise-20k', data: new SeededRandom(404).bytes(20_000) },
    { name: 'runs-50k', data: runBytes(50_000, 505) },
    { name: 'empty', data: Buffer.alloc(0) },
    { name: 'single-byte', data: Buffer.from([0x41]) },
  ];
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
