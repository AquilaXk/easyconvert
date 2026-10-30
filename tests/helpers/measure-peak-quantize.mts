import fs from 'node:fs';
import { quantizeImage } from '../../src/lib/conversions/color-quantizer';

/**
 * Runs the palette quantizer (palette, then serpentine Floyd-Steinberg mapping) on an RGBA raster in a fresh process and prints the best of several CPU times
 * and the peak resident memory the runs added, read from the kernel's high-water mark (VmHWM in /proc/self/status) before
 * and after. Run with `node --expose-gc --import tsx` so the numbers are not polluted by a test runner's allocations.
 *
 * The time is CPU time of the process (user and system, every thread): a process that waits for a core on a busy host is
 * not charged for the wait, and the best of the runs drops a run the garbage collector or a cold cache stretched.
 * Memory is read after a collection before the first run and between runs, so the high-water mark is the live set of one run
 * and not the garbage of the runs before it, whose collection the host's load can postpone.
 *
 * Usage: measure-peak-quantize.mts <rgba-file> <width> <height> <colours> <runs>
 */

const KIB_PER_MIB = 1024;
const MICROS_PER_MS = 1000;
const SETTLE_MS = 200;

function highWaterMarkMiB(): number {
  const match = /VmHWM:\s+(\d+)\s+kB/.exec(fs.readFileSync('/proc/self/status', 'utf8'));
  if (!match) throw new Error('VmHWM is not available in /proc/self/status');
  return Number(match[1]) / KIB_PER_MIB;
}

const collectGarbage = (globalThis as { gc?: () => void }).gc;
if (!collectGarbage) throw new Error('run with --expose-gc');
const [file, widthText, heightText, coloursText, runsText] = process.argv.slice(2);
const width = Number(widthText);
const height = Number(heightText);
const data = new Uint8Array(fs.readFileSync(file));
await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
collectGarbage();
const baselineMiB = highWaterMarkMiB();
let bestCpuMs = Infinity;
for (let run = 0; run < Number(runsText); run += 1) {
  collectGarbage();
  const started = process.cpuUsage();
  quantizeImage(data, width, height, Number(coloursText), { dither: 'floyd-steinberg' });
  const used = process.cpuUsage(started);
  bestCpuMs = Math.min(bestCpuMs, (used.user + used.system) / MICROS_PER_MS);
}
console.log(JSON.stringify({ bestCpuMs, addedMiB: highWaterMarkMiB() - baselineMiB }));
