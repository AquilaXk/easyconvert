import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { runConvert } from './imagemagick';
import { SERVICE_MALLOC_ARENA_MAX } from './service-heap';

const execFileAsync = promisify(execFile);
const COLOURS = 256;
const PERF_WIDTH = 1600;
const PERF_HEIGHT = 1200;
const PERF_RUNS = 5;
const CHILD_TIMEOUT_MS = 170_000;
const MEASURE_SCRIPT = path.join(__dirname, 'measure-peak-quantize.mts');

/**
 * The cost of the palette quantizer at 1.92 megapixels and 256 colours, measured in a fresh process with the heap bound of the
 * service: the best CPU time of several runs and the resident memory a run adds (Linux only: the memory is read from /proc).
 */
export async function measureQuantizeCost(workDir: string): Promise<{ bestCpuMs: number; addedMiB: number }> {
  const rgbaFile = path.join(workDir, 'perf.rgba');
  // A textured picture with a smooth tonal range: the statistics of a photograph, 10 thousand histogram bins.
  runConvert(['-seed', '11', '-size', `${PERF_WIDTH}x${PERF_HEIGHT}`, 'plasma:fractal', '-blur', '0x2', '-attenuate', '0.3', '+noise', 'Gaussian', '-alpha', 'on', '-depth', '8', `rgba:${rgbaFile}`]);
  if (readFileSync(rgbaFile).length !== PERF_WIDTH * PERF_HEIGHT * 4) throw new Error('the performance picture was not written whole');
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--expose-gc', '--import', 'tsx', MEASURE_SCRIPT, rgbaFile, String(PERF_WIDTH), String(PERF_HEIGHT), String(COLOURS), String(PERF_RUNS)],
    { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, MALLOC_ARENA_MAX: SERVICE_MALLOC_ARENA_MAX }, timeout: CHILD_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
  );
  return JSON.parse(stdout.trim().split('\n').pop() as string) as { bestCpuMs: number; addedMiB: number };
}
