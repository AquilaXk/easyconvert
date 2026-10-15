import fs from 'node:fs';
import { quantizeImage } from '../../src/lib/conversions/color-quantizer';

/**
 * Runs the palette quantizer (palette, then serpentine Floyd-Steinberg mapping) on an RGBA raster in a fresh process and prints the best of several run times and the
 * peak resident memory the runs added, read from the kernel's high-water mark (VmHWM in /proc/self/status) before
 * and after. Run with `node --import tsx` so the numbers are not polluted by a test runner's allocations.
 *
 * Usage: measure-peak-quantize.mts <rgba-file> <width> <height> <colours> <runs>
 */

const KIB_PER_MIB = 1024;
const SETTLE_MS = 200;

function highWaterMarkMiB(): number {
  const match = /VmHWM:\s+(\d+)\s+kB/.exec(fs.readFileSync('/proc/self/status', 'utf8'));
  if (!match) throw new Error('VmHWM is not available in /proc/self/status');
  return Number(match[1]) / KIB_PER_MIB;
}

const [file, widthText, heightText, coloursText, runsText] = process.argv.slice(2);
const width = Number(widthText);
const height = Number(heightText);
const data = new Uint8Array(fs.readFileSync(file));
await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
const baselineMiB = highWaterMarkMiB();
let bestMs = Infinity;
for (let run = 0; run < Number(runsText); run += 1) {
  const start = performance.now();
  quantizeImage(data, width, height, Number(coloursText), { dither: 'floyd-steinberg' });
  bestMs = Math.min(bestMs, performance.now() - start);
}
console.log(JSON.stringify({ bestMs, addedMiB: highWaterMarkMiB() - baselineMiB }));
