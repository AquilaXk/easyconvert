import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { measureInterleaved } from './helpers/timing';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool, type ExternalOracleTool } from './helpers/differential-oracle';

/**
 * Timing-ratio checks moved out of pdf-unicode-text-writers.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in pdf-unicode-text-writers.test.ts.
 */

const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function runPoppler(tool: ExternalOracleTool, args: string[], pdf: Buffer): string {
  const binary = requireOracleTool(tool);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-unicode-oracle-'));
  const file = path.join(dir, 'input.pdf');
  try {
    fs.writeFileSync(file, pdf);
    const trailing = tool === 'pdftotext' ? [file, '-'] : [file];
    return execFileSync(binary, [...args, ...trailing], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pdfText(pdf: Buffer, layout = false): string {
  return runPoppler('pdftotext', layout ? ['-q', '-layout'] : ['-q'], pdf);
}

function withoutWhitespace(text: string): string {
  return text.normalize('NFC').replace(BIDI_CONTROLS, '').replace(/\s+/g, '');
}

const GROWTH_PASSES = 2;
async function measureGrowth<T>(run: (size: number) => Promise<T>, small: number, large: number): Promise<{ growth: number; largeMs: number; result: T }> {
  const measurement = await measureInterleaved(() => run(small), () => run(large), GROWTH_PASSES);
  return { growth: measurement.ratio, largeMs: measurement.largeMs, result: measurement.largeResult };
}

/** Hang guard only: a healthy conversion in these tests takes well under a second. */
const GROWTH_CEILING_MS = 10_000;

describe('In-process PDF layout limits', () => {
  oracleTest('wraps a 1 MB unbroken token in linear time without losing characters', ['pdftotext'], async () => {
    // Growth, not wall-clock: 4x the input must cost well under the 16x a quadratic wrap would.
    const SMALL_BYTES = 256 * 1024;
    const TOKEN_BYTES = 4 * SMALL_BYTES;
    const MAX_GROWTH = 8;
    const { growth, largeMs, result: large } = await measureGrowth(
      async (bytes) => (await convertFile(Buffer.from('a'.repeat(bytes), 'utf-8'), 'txt', 'pdf', {}, 'token.txt')).buffer,
      SMALL_BYTES,
      TOKEN_BYTES
    );
    expect({ linear: growth < MAX_GROWTH, underCeiling: largeMs < GROWTH_CEILING_MS, growth, ms: largeMs }).toEqual({
      linear: true,
      underCeiling: true,
      growth,
      ms: largeMs,
    });
    const extracted = withoutWhitespace(pdfText(large));
    expect(extracted.length).toBe(TOKEN_BYTES);
    expect(extracted).toBe('a'.repeat(TOKEN_BYTES));
  }, 120_000);

  oracleTest('wraps long runs of spaces and tabs in linear time without losing the text around them', ['pdftotext'], async () => {
    // Growth, not wall clock: 8x the input must cost well under the 64x a quadratic wrap would.
    const SMALL = 25_000;
    const LARGE = 8 * SMALL;
    const MAX_GROWTH = 20;
    for (const [label, whitespace] of [
      ['spaces', ' '],
      ['tabs', '\t'],
    ] as const) {
      const { growth, largeMs, result: large } = await measureGrowth(
        async (count) => (await convertFile(Buffer.from(`start${whitespace.repeat(count)}end`, 'utf-8'), 'txt', 'pdf', {}, 'gap.txt')).buffer,
        SMALL,
        LARGE
      );
      expect({ label, linear: growth < MAX_GROWTH, underCeiling: largeMs < GROWTH_CEILING_MS, growth, ms: largeMs }).toEqual({
        label,
        linear: true,
        underCeiling: true,
        growth,
        ms: largeMs,
      });
      expect(withoutWhitespace(pdfText(large))).toBe('startend');
    }
  }, 120_000);

  oracleTest('wraps a long unbroken token inside an HTML paragraph without losing characters', ['pdftotext'], async () => {
    // 4x the token must cost well under the 16x a quadratic wrap would.
    const MAX_GROWTH = 8;
    const { growth, largeMs, result } = await measureGrowth(
      (size) => convertFile(Buffer.from(`<p>start ${'x'.repeat(size)} end</p>`, 'utf-8'), 'html', 'pdf', {}, 'token.html'),
      12_500,
      50_000
    );
    expect({ linear: growth < MAX_GROWTH, underCeiling: largeMs < GROWTH_CEILING_MS, growth, largeMs }).toEqual({
      linear: true,
      underCeiling: true,
      growth,
      largeMs,
    });
    expect(withoutWhitespace(pdfText(result.buffer))).toBe(`start${'x'.repeat(50_000)}end`);
  }, 120_000);
});

describe('Markdown to PDF keeps literal text and structure', () => {
  oracleTest('converts long runs of table pipes in linear time', ['pdftotext'], async () => {
    // 4x the pipes must cost well under the 16x the old quadratic table pattern took.
    const MAX_GROWTH = 8;
    const { growth, largeMs, result } = await measureGrowth(
      (size) => convertFile(Buffer.from('|'.repeat(size), 'utf-8'), 'md', 'pdf', {}, 'pipes.md'),
      10_000,
      40_000
    );
    expect({ linear: growth < MAX_GROWTH, underCeiling: largeMs < GROWTH_CEILING_MS, growth, largeMs }).toEqual({
      linear: true,
      underCeiling: true,
      growth,
      largeMs,
    });
    expect(withoutWhitespace(pdfText(result.buffer))).toBe('|'.repeat(40_000));
  }, 120_000);
});
