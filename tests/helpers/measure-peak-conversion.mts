import fs from 'node:fs';
import { convertImage } from '../../src/lib/conversions/image';

/**
 * Runs one conversion in a fresh process and prints the peak resident memory it added, read from the kernel's
 * high-water mark (VmHWM in /proc/self/status) before and after. Used by tests that bound memory; it is run
 * with `node --import tsx` so the numbers are not polluted by a test runner's own allocations.
 *
 * Usage: measure-peak-conversion.mts <input> <target> <options-json> <source-format>
 */

const BYTES_PER_MIB = 1024 * 1024;
const KIB_PER_MIB = 1024;
const SETTLE_MS = 200;

function highWaterMarkMiB(): number {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const match = /VmHWM:\s+(\d+)\s+kB/.exec(status);
  if (!match) throw new Error('VmHWM is not available in /proc/self/status');
  return Number(match[1]) / KIB_PER_MIB;
}

const [input, target, optionsJson, sourceFormat] = process.argv.slice(2);
const buffer = fs.readFileSync(input);
await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
const baselineMiB = highWaterMarkMiB();
let status = 'converted';
let outputBytes = 0;
try {
  const result = await convertImage(buffer, target, JSON.parse(optionsJson), 'fixture', sourceFormat);
  outputBytes = result.buffer.length;
} catch (error) {
  status = `refused: ${error instanceof Error ? error.message : String(error)}`;
}
const peakMiB = highWaterMarkMiB();
console.log(JSON.stringify({ status, outputBytes, baselineMiB, peakMiB, addedMiB: peakMiB - baselineMiB, inputMiB: buffer.length / BYTES_PER_MIB }));
