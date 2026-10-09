import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { compressZstd } from '../src/lib/conversions/zstd';
import { pinCorpus, sha256Hex, sourceText, zipfText } from './helpers/archive-corpus';
import { oracleTest } from './helpers/oracle-test';

/**
 * REGRESSION PINS, not oracles. Each hash is the SHA-256 of the Zstandard frame the encoder wrote for a fixed generated
 * input (tests/helpers/archive-corpus.ts) at one of the levels 1-15, recorded in tests/fixtures/zstd-encoder-pins.json
 * before the optimal parser for levels 16-19 was added. They state that work on the high levels leaves levels 1-15
 * byte-identical; they do not state that the bytes are good. Correctness is established separately: the `zstd` command
 * line decodes every pinned frame in this file. When a lower level is changed on purpose, its pins are re-recorded in
 * the same commit and that commit says so.
 */
const PINS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'zstd-encoder-pins.json'), 'utf8')) as Record<string, string>;
const PINNED_LEVELS = [1, 2, 3, 5, 7, 9, 12, 15];
const MULTI_BLOCK_BYTES = 300_000;

interface PinInput {
  name: string;
  data: Buffer;
}

const INPUTS: PinInput[] = [
  ...pinCorpus().filter((file) => file.data.length > 0),
  { name: 'zipf-300k', data: zipfText(MULTI_BLOCK_BYTES, 497) },
  { name: 'source-300k', data: sourceText(MULTI_BLOCK_BYTES, 498) },
];

describe('zstd levels 1-15 regression pins', () => {
  it('pins every input at every pinned level', () => {
    const missing: string[] = [];
    for (const input of INPUTS) {
      for (const level of PINNED_LEVELS) if (!(`${input.name}/${level}` in PINS)) missing.push(`${input.name}/${level}`);
    }
    expect(missing).toEqual([]);
  });

  describe.each(INPUTS)('$name', ({ name, data }) => {
    it.each(PINNED_LEVELS)('level %i bytes match the pin', (level) => {
      expect(sha256Hex(compressZstd(data, { level }))).toBe(PINS[`${name}/${level}`]);
    });
  });

  oracleTest('the zstd command line restores every pinned frame', ['zstd'], () => {
    for (const { name, data } of INPUTS) {
      for (const level of PINNED_LEVELS) {
        const frame = compressZstd(data, { level });
        const restored = execFileSync('zstd', ['-d', '-q', '-c'], { input: frame, maxBuffer: 1 << 26 });
        expect(restored.equals(data), `${name} at level ${level}`).toBe(true);
      }
    }
  });
});
