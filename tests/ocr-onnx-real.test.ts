import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { recognizePage, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import {
  onnxOcrModelDirectory,
  onnxOcrUnavailableReason,
  OnnxOcrPool,
} from '../src/lib/conversions/ocr-onnx-helper';
import { prepareOnnxInput } from '../src/lib/conversions/ocr-onnx-input';
import { skipUnless } from './helpers/strict-skip';

/**
 * The ONNX Korean engine with the real models, through the sandboxed helper process, on the golden Korean pages (drawn from known text).
 * The models are installed by scripts/install-onnx-ocr-models.sh (CI: the ci-setup action, which fails this suite instead of skipping it
 * under ORACLE_STRICT_MODE=1 when they are missing); the standalone ONNX_OCR_DIR override of earlier versions is the same directory.
 */

const unavailable = onnxOcrUnavailableReason();
const modelsMissing = skipUnless(`the ONNX OCR models and runtime (${unavailable?.message ?? 'present'})`, unavailable === null);
const FIXTURES = path.join(__dirname, 'fixtures/ocr');
const TIMEOUT_MS = 180_000;
/** Whether this host lets a process make the user and network namespaces a helper is started in; CI enables them. */
const canIsolate = process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0;
const namespacesMissing = skipUnless('unprivileged user and network namespaces (unshare -r -n)', canIsolate);

function levenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

function characterError(truth: string, read: string): number {
  const expected = [...truth.normalize('NFC').replace(/\s+/g, '')];
  return levenshtein(expected, [...read.normalize('NFC').replace(/\s+/g, '')]) / expected.length;
}

const truth = (name: string): string => fs.readFileSync(path.join(FIXTURES, `${name}.gt.txt`), 'utf8');
const image = (variant: string): Buffer => fs.readFileSync(path.join(FIXTURES, `ko_a__${variant}.png`));

afterAll(async () => {
  await shutdownOcrWorkerPool();
});

describe.skipIf(modelsMissing)('the ONNX Korean engine with the real models', () => {
  it('is what a Korean page is read with by default, with word boxes, a baseline and the page size', async () => {
    const page = await recognizePage(image('clean300'), 'kor', { detectOrientation: false });
    expect(page.enginePath).toBe('onnx');
    expect(page.result.engineFallback).toBeUndefined();
    expect(characterError(truth('ko_a'), page.result.text)).toBeLessThan(0.03);
    const blocks = page.result.lineBlocks ?? [];
    expect(blocks.length).toBeGreaterThan(3);
    expect(blocks.every((b) => b.words.length > 0 && b.baseline && b.bbox.width > 0)).toBe(true);
    expect(page.result.imageWidth).toBeGreaterThan(1000);
    expect(page.result.language).toBe('kor');
  }, TIMEOUT_MS);

  it('keeps the full stop that ends each line of a page of short sentences', async () => {
    // Production dropped the last character of every such line: the detector's box ended at the last syllable or inside the full stop.
    const lines = truth('ko_lines').trim().split('\n');
    const page = await recognizePage(fs.readFileSync(path.join(FIXTURES, 'ko_lines__clean.png')), 'kor', { detectOrientation: false });
    expect(page.enginePath).toBe('onnx');
    expect(page.result.lines).toHaveLength(lines.length);
    expect(page.result.lines?.map((line) => line.trim().slice(-1))).toEqual(lines.map(() => '.'));
    expect(characterError(truth('ko_lines'), page.result.text)).toBeLessThan(0.02);
  }, TIMEOUT_MS);

  it('keeps the final stops and the order of the lines of that page turned by 3 degrees', async () => {
    const lines = truth('ko_lines').trim().split('\n');
    const page = await recognizePage(fs.readFileSync(path.join(FIXTURES, 'ko_lines__skew3.png')), 'kor', { detectOrientation: false });
    expect(page.result.lines?.map((line) => line.trim().slice(-1))).toEqual(lines.map(() => '.'));
    expect(characterError(truth('ko_lines'), page.result.text)).toBeLessThan(0.02);
  }, TIMEOUT_MS);

  it('reads a page turned by 3 degrees in the order of its lines', async () => {
    const page = await recognizePage(image('skew3'), 'kor', { detectOrientation: false });
    expect(page.enginePath).toBe('onnx');
    expect(characterError(truth('ko_a'), page.result.text)).toBeLessThan(0.03);
    // The lines come down the page: each starts below the one before it (a turned page read line by line, not column of fragments).
    const tops = (page.result.lineBlocks ?? []).map((b) => (b.baseline ? (b.baseline.y0 + b.baseline.y1) / 2 : b.bbox.y));
    expect(tops.every((y, i) => i === 0 || y > tops[i - 1])).toBe(true);
  }, TIMEOUT_MS);

  it('reads a noisy page and an unevenly lit one', async () => {
    for (const variant of ['noise', 'shade']) {
      const page = await recognizePage(image(variant), 'kor', { detectOrientation: false });
      expect(characterError(truth('ko_a'), page.result.text)).toBeLessThan(0.05);
    }
  }, TIMEOUT_MS);

  it('keeps Latin text beside Korean when English is requested too', async () => {
    const page = await recognizePage(image('clean300'), 'kor+eng', { detectOrientation: false });
    expect(page.enginePath).toBe('onnx');
    expect(page.result.language).toBe('kor+eng');
  }, TIMEOUT_MS);

  it('leaves an English page to Tesseract', async () => {
    const english = fs.readFileSync(path.join(FIXTURES, 'en_a__clean300.png'));
    const page = await recognizePage(english, 'eng', { detectOrientation: false });
    expect(page.enginePath).not.toBe('onnx');
  }, TIMEOUT_MS);

  it('keeps one helper for the pages of a burst and ends it with the pool', async () => {
    const pool = new OnnxOcrPool({ modelDir: onnxOcrModelDirectory() });
    try {
      const input = await prepareOnnxInput(image('clean300'), { detectorMaxSide: 1280 });
      await pool.read(input, { language: 'kor' });
      await pool.read(input, { language: 'kor' });
      expect(pool.size).toBe(1);
    } finally {
      pool.shutdown();
    }
    expect(pool.size).toBe(0);
  }, TIMEOUT_MS);

  it.skipIf(namespacesMissing)('runs the helper in a user and a network namespace of its own', async () => {
    const pool = new OnnxOcrPool({ modelDir: onnxOcrModelDirectory() });
    try {
      const input = await prepareOnnxInput(image('clean300'), { detectorMaxSide: 1280 });
      const reading = pool.read(input, { language: 'kor' });
      // The helper holds its pages one after the other: look at it while it reads this one.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const own = (kind: string): string => fs.readlinkSync(`/proc/self/ns/${kind}`);
      // The node process of the helper: the one whose command line runs the helper program (the wrappers before it only start it).
      const helper = fs
        .readdirSync('/proc')
        .filter((d) => /^\d+$/.test(d))
        .find((d) => {
          try {
            const [program, ...rest] = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
            return path.basename(program) === path.basename(process.execPath) && rest.join(' ').includes('ocr-onnx-child');
          } catch {
            return false;
          }
        });
      await reading;
      expect(helper).toMatch(/^\d+$/);
      expect(fs.readlinkSync(`/proc/${helper}/ns/net`)).not.toBe(own('net'));
      expect(fs.readlinkSync(`/proc/${helper}/ns/user`)).not.toBe(own('user'));
    } finally {
      pool.shutdown();
    }
  }, TIMEOUT_MS);
});

describe('the ONNX engine without its runtime', () => {
  it('reports why it is unavailable instead of failing in a way that looks like a reading', () => {
    // Either available (null) or a typed reason; never a throw.
    const reason = onnxOcrUnavailableReason('/nonexistent-ocr-onnx');
    expect(reason?.reason).toBe('models-missing');
  });
});
