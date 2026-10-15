import crypto from 'node:crypto';
import fs from 'node:fs';
import { recognizePdfPages, shutdownOcrWorkerPool } from '../../src/lib/conversions/ocr';

/**
 * Recognizes `pages` copies of one page image with the given concurrency in a fresh process and
 * prints the time taken, the peak resident memory it added (the kernel's VmHWM high-water mark,
 * before and after) and a hash of the text of every page. It is run with `node --import tsx`, so the
 * numbers are not polluted by a test runner's own allocations.
 *
 * Usage: measure-peak-ocr-pages.mts <image> <language> <pages> <concurrency>
 */

const KIB_PER_MIB = 1024;
const SETTLE_MS = 200;

function highWaterMarkMiB(): number {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const match = /VmHWM:\s+(\d+)\s+kB/.exec(status);
  if (!match) throw new Error('VmHWM is not available in /proc/self/status');
  return Number(match[1]) / KIB_PER_MIB;
}

const [imagePath, language, pagesArgument, concurrencyArgument] = process.argv.slice(2);
const image = fs.readFileSync(imagePath);
const pages = Array.from({ length: Number(pagesArgument) }, () => ({ buffer: image }));
await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
const baselineMiB = highWaterMarkMiB();
const started = performance.now();
const results = await recognizePdfPages(pages, language, Number(concurrencyArgument));
const elapsedMs = performance.now() - started;
const peakMiB = highWaterMarkMiB();
await shutdownOcrWorkerPool();
const textHashes = results.map((result) => crypto.createHash('sha256').update(result.text).digest('hex').slice(0, 16));
console.log(JSON.stringify({ elapsedMs, baselineMiB, peakMiB, addedMiB: peakMiB - baselineMiB, textHashes }));
