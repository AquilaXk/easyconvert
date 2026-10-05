import fs from 'node:fs';
import path from 'node:path';

/**
 * Deterministic corpora for the Zstandard encoder suites. Everything is generated from fixed seeds
 * or read from the repository's own sources, so no network or fixture download is involved.
 */

export const MIB = 1024 * 1024;
const XORSHIFT_MODULUS = 0x100000000;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const RUN_LENGTH_SPAN = 20000;
const RUN_VALUE_COUNT = 4;
const MUTATION_SPACING = 4096;
const BYTE_VALUES = 256;

export function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / XORSHIFT_MODULUS;
  };
}

export function noiseBytes(length: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

export function jsonRecords(length: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const pick = (n: number): number => Math.floor(rng() * n);
  const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy'];
  const statuses = ['active', 'pending', 'suspended', 'archived'];
  const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  const rows: string[] = [];
  let total = 0;
  let id = 1000;
  while (total < length) {
    const row = JSON.stringify({
      id: id++,
      name: names[pick(names.length)] + pick(500),
      email: `${names[pick(names.length)]}${pick(9999)}@example.com`,
      status: statuses[pick(statuses.length)],
      score: pick(100000) / 100,
      tags: [tags[pick(8)], tags[pick(8)], tags[pick(8)]],
      address: { city: 'City' + pick(300), zip: String(10000 + pick(80000)), country: 'US' },
      createdAt: `2024-${String(1 + pick(12)).padStart(2, '0')}-${String(1 + pick(28)).padStart(2, '0')}T12:00:00Z`,
    });
    rows.push(row);
    total += row.length + 1;
  }
  return Buffer.from(rows.join('\n'), 'latin1').subarray(0, length);
}

/** Zipf-distributed pseudo-words grouped into sentences: English-like entropy and word reuse. */
export function englishLikeText(length: number, vocabSize: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const syllables = ['ba', 'ke', 'lo', 'mi', 'nu', 'ra', 'se', 'ti', 'vo', 'wa', 'xe', 'zi', 'an', 'el', 'in', 'or', 'um', 'st', 'tr', 'ch'];
  const vocab: string[] = [];
  for (let i = 0; i < vocabSize; i++) {
    const syllableCount = 1 + Math.floor(rng() * 3);
    let word = '';
    for (let k = 0; k < syllableCount; k++) word += syllables[Math.floor(rng() * syllables.length)];
    vocab.push(word);
  }
  const parts: string[] = [];
  let total = 0;
  let sentenceLength = 0;
  while (total < length) {
    const rank = Math.max(0, Math.floor(vocabSize ** rng()) - 1);
    let word = vocab[Math.min(vocabSize - 1, rank)];
    if (sentenceLength === 0) word = word[0].toUpperCase() + word.slice(1);
    sentenceLength++;
    const endsSentence = sentenceLength > 6 + Math.floor(rng() * 10);
    const comma = rng() < 0.08;
    let token = word + ' ';
    if (endsSentence) token = word + '.\n';
    else if (comma) token = word + ', ';
    if (endsSentence) sentenceLength = 0;
    parts.push(token);
    total += token.length;
  }
  return Buffer.from(parts.join('').slice(0, length), 'latin1');
}

function collectSourceFiles(dir: string, into: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, into);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) into.push(full);
  }
}

/** First `length` bytes of the repository's TypeScript sources, concatenated in sorted path order. */
export function typescriptSourceCorpus(root: string, length: number): Buffer {
  const files: string[] = [];
  collectSourceFiles(path.join(root, 'src'), files);
  const chunks: Buffer[] = [];
  let total = 0;
  for (const file of files) {
    if (total >= length) break;
    const chunk = fs.readFileSync(file);
    chunks.push(chunk);
    total += chunk.length;
  }
  if (total < length) throw new Error(`TypeScript corpus needs ${length} bytes but src/ holds only ${total}.`);
  return Buffer.concat(chunks).subarray(0, length);
}

/** Random bytes over a two-symbol alphabet: maximal match-candidate density with no real structure. */
export function twoSymbolRandom(length: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = rng() < 0.5 ? 0x61 : 0x62;
  return out;
}

/** Long single-value runs of random length: overlapping offset-1 matches everywhere. */
export function longRuns(length: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const out = Buffer.alloc(length);
  let i = 0;
  while (i < length) {
    const run = 1 + Math.floor(rng() * RUN_LENGTH_SPAN);
    const value = Math.floor(rng() * RUN_VALUE_COUNT);
    out.fill(value, i, Math.min(length, i + run));
    i += run;
  }
  return out;
}

/** A short random pattern repeated end to end, with rare single-byte mutations. */
export function periodic(length: number, period: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const pattern = noiseBytes(period, seed + 1);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = pattern[i % period];
  for (let k = 0; k < length / MUTATION_SPACING; k++) out[Math.floor(rng() * length)] ^= 0xff;
  return out;
}

/** Zeros with one random non-zero byte every `step` bytes: long overlapping matches broken by unique literals. */
export function perturbedZeros(length: number, step: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const out = Buffer.alloc(length);
  for (let i = step; i < length; i += step) out[i] = 1 + Math.floor(rng() * (BYTE_VALUES - 1));
  return out;
}

/** A random pattern repeated end to end with a random XOR applied every `step` bytes. */
export function mutatedPeriodic(length: number, period: number, step: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const pattern = noiseBytes(period, seed + 1);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = pattern[i % period];
  for (let i = step; i < length; i += step) out[i] ^= 1 + Math.floor(rng() * (BYTE_VALUES - 1));
  return out;
}

/** The cyclic de Bruijn sequence B(alphabet, order) (Fredricksen-Kessler-Maiorana), repeated to `length`. */
export function deBruijnSequence(alphabet: number, order: number, length: number): Buffer {
  const work = new Array<number>(alphabet * order).fill(0);
  const sequence: number[] = [];
  const generate = (t: number, p: number): void => {
    if (t > order) {
      if (order % p === 0) for (let j = 1; j <= p; j++) sequence.push(work[j]);
      return;
    }
    work[t] = work[t - p];
    generate(t + 1, p);
    for (let j = work[t - p] + 1; j < alphabet; j++) {
      work[t] = j;
      generate(t + 1, t);
    }
  };
  generate(1, 1);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = sequence[i % sequence.length];
  return out;
}
