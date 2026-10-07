import { describe, expect, it } from 'vitest';
import { UnsupportedOptionError } from '../src/lib/types';
import { checkWasmSimdSupport } from '../src/lib/edge/tier-router';
import { instantiateSimdEngine } from '../src/lib/edge/workers/simd-bytecode';
import {
  applyRgbaQuantize,
  runWasmWorkerJob,
  WASM_MAX_INPUT_BYTES,
  WASM_MAX_MODULE_BYTES,
  WasmEngine,
  type WasmTaskRequest,
} from '../src/lib/edge/workers/wasm-engine.worker';
import { EdgeUnsupportedError, rehydrateWorkerError } from '../src/lib/edge/workers/worker-errors';
import { mulberry32 } from './helpers/audio-signals';
import { addToEachByte, allocAt, craftModule, OP } from './helpers/wasm-craft';

const PAGE = 65_536;
const IO_ADDRESS = 1_024;

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function runCustom(input: Uint8Array, module?: Uint8Array): Promise<Uint8Array> {
  const engine = new WasmEngine();
  const request: WasmTaskRequest = {
    jobId: 'custom',
    task: 'custom-module',
    buffer: asArrayBuffer(input),
    options: module ? { customWasmBytes: asArrayBuffer(module) } : {},
  };
  return new Uint8Array((await engine.executeTask(request)).buffer);
}

async function failure(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the task resolved but was expected to fail');
}

describe('custom Wasm task (issue #480)', () => {
  const INPUT = Uint8Array.from([0, 1, 2, 250, 251, 255, 127, 128]);
  const INCREMENT = craftModule({ alloc: allocAt(IO_ADDRESS), transform: addToEachByte(1), memoryPages: 1 });

  it('refuses to run without a module instead of inverting the image', async () => {
    const error = await failure(runCustom(INPUT));
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(error.message).toMatch(/customWasmBytes/);
  });

  it('returns what the module wrote, not the input it was given', async () => {
    expect(WebAssembly.validate(INCREMENT)).toBe(true);
    const output = await runCustom(INPUT, INCREMENT);
    // Each byte plus one, wrapping at 256: computed here, not by the module under test.
    expect(Array.from(output)).toEqual(Array.from(INPUT, (byte) => (byte + 1) % 256));
  });

  it('returns exactly the length the module reports', async () => {
    const halve = craftModule({
      alloc: allocAt(IO_ADDRESS),
      transform: addToEachByte(3, [OP.localGet, 1, ...[0x41, 1], OP.i32ShrU]),
      memoryPages: 1,
    });
    const output = await runCustom(INPUT, halve);
    expect(Array.from(output)).toEqual(Array.from(INPUT.subarray(0, 4), (byte) => (byte + 3) % 256));
  });

  it('hands the module only its own copy of the input', async () => {
    const buffer = asArrayBuffer(INPUT);
    const engine = new WasmEngine();
    await engine.executeTask({ jobId: 'copy', task: 'custom-module', buffer, options: { customWasmBytes: asArrayBuffer(INCREMENT) } });
    expect(Array.from(new Uint8Array(buffer))).toEqual(Array.from(INPUT));
  });

  describe.each([
    [
      'a module that does not export transform',
      craftModule({ alloc: allocAt(IO_ADDRESS), transform: null, memoryPages: 1 }),
      /transform/,
    ],
    [
      'a module that does not export alloc',
      craftModule({ alloc: null, transform: addToEachByte(1), memoryPages: 1 }),
      /alloc/,
    ],
    [
      'a module that does not export its memory',
      craftModule({ alloc: allocAt(IO_ADDRESS), transform: addToEachByte(1), memoryPages: null }),
      /memory/,
    ],
    [
      'a module that imports a host function',
      craftModule({ alloc: allocAt(IO_ADDRESS), transform: addToEachByte(1), memoryPages: 1, importsHostFunction: true }),
      /imports/,
    ],
    [
      'an alloc that returns an address past the end of memory',
      craftModule({ alloc: allocAt(PAGE - 4), transform: addToEachByte(1), memoryPages: 1 }),
      /outside the module memory/,
    ],
    [
      'an alloc that returns a negative address',
      craftModule({ alloc: allocAt(-8), transform: addToEachByte(1), memoryPages: 1 }),
      /outside the module memory/,
    ],
    [
      'a transform that reports more bytes than it was given room for',
      craftModule({ alloc: allocAt(IO_ADDRESS), transform: addToEachByte(1, [OP.localGet, 1, ...[0x41, 1], OP.i32Add]), memoryPages: 1 }),
      /reported 9 output bytes/,
    ],
    [
      'a transform that reports a negative length',
      craftModule({ alloc: allocAt(IO_ADDRESS), transform: addToEachByte(1, [0x41, 0x7f]), memoryPages: 1 }),
      /reported \d+ output bytes/,
    ],
  ])('%s', (_name, module, pattern) => {
    it('fails with a typed error naming the break in the ABI', async () => {
      const error = await failure(runCustom(INPUT, module));
      expect(error).toBeInstanceOf(EdgeUnsupportedError);
      expect(error.message).toMatch(pattern);
    });
  });

  it('refuses an input that does not fit the module memory', async () => {
    const error = await failure(runCustom(new Uint8Array(PAGE), INCREMENT));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/outside the module memory/);
  });

  it('refuses bytes that are not a WebAssembly module', async () => {
    const error = await failure(runCustom(INPUT, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/not a valid WebAssembly module/);
  });

  it('refuses a module larger than the module cap before compiling it', async () => {
    const huge = craftModule({
      alloc: allocAt(IO_ADDRESS),
      transform: addToEachByte(1),
      memoryPages: 1,
      paddingBytes: WASM_MAX_MODULE_BYTES + 1,
    });
    const error = await failure(runCustom(INPUT, huge));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/larger than/);
  });

  it('refuses an input larger than the input cap before compiling the module', async () => {
    const error = await failure(runCustom(new Uint8Array(WASM_MAX_INPUT_BYTES + 1), INCREMENT));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/input is larger than/);
  });

  it('refuses an empty input', async () => {
    const error = await failure(runCustom(new Uint8Array(0), INCREMENT));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/no input/);
  });

  it('reports the failure through the worker message with its class', async () => {
    const messages: Array<Record<string, unknown>> = [];
    await runWasmWorkerJob(
      { type: 'EXECUTE', jobId: 'w1', task: 'custom-module', buffer: asArrayBuffer(INPUT), options: {} },
      (message) => messages.push(message),
      new WasmEngine()
    );
    const failures = messages.filter((message) => message.type === 'ERROR');
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatchObject({ name: 'UnsupportedOptionError', message: expect.stringMatching(/customWasmBytes/) });
    expect(rehydrateWorkerError(failures[0].error)).toBeInstanceOf(UnsupportedOptionError);
  });
});

// --- quantiser ---------------------------------------------------------------------------------------------

const MAX_COLORS_CASES = [8, 9, 16, 27, 50, 64, 100, 125, 216, 256, 343, 500, 1_000, 4_096, 65_536];
const GRID_STEPS = 64;

/** Every colour of a 64 x 64 x 64 grid over 0..255 as opaque RGBA pixels. */
function colourGrid(): Uint8Array {
  const out = new Uint8Array(GRID_STEPS ** 3 * 4);
  let at = 0;
  for (let r = 0; r < GRID_STEPS; r++) {
    for (let g = 0; g < GRID_STEPS; g++) {
      for (let b = 0; b < GRID_STEPS; b++) {
        out[at++] = Math.round((r * 255) / (GRID_STEPS - 1));
        out[at++] = Math.round((g * 255) / (GRID_STEPS - 1));
        out[at++] = Math.round((b * 255) / (GRID_STEPS - 1));
        out[at++] = 255;
      }
    }
  }
  return out;
}

function distinctColours(rgba: Uint8Array): number {
  const seen = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) seen.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  return seen.size;
}

describe('quantiser levels follow maxColors (issue #480)', () => {
  const GRID = colourGrid();
  const hasSimd = checkWasmSimdSupport();
  // Without SIMD the kernel comparison cannot run: skip it, or fail under ORACLE_STRICT_MODE=1 as CI does.
  const simdIt = it.skipIf(!hasSimd && process.env.ORACLE_STRICT_MODE !== '1');
  const requireSimd = (): void => {
    if (!hasSimd) throw new Error('WebAssembly SIMD is required by this test (ORACLE_STRICT_MODE=1)');
  };

  it.each(MAX_COLORS_CASES)('keeps at most %i colours and uses most of the allowance (JS path)', (maxColors) => {
    const colours = distinctColours(applyRgbaQuantize(GRID, 0, 0, maxColors, false));
    expect(colours).toBeLessThanOrEqual(maxColors);
    // Uniform per-channel levels cannot always hit the allowance exactly, but they come within a quarter of it.
    expect(colours).toBeGreaterThanOrEqual(Math.floor(maxColors * 0.75));
  });

  it.each(MAX_COLORS_CASES)('keeps at most %i colours with error diffusion on', (maxColors) => {
    const side = Math.sqrt(GRID.length / 4);
    const colours = distinctColours(applyRgbaQuantize(GRID.subarray(0, side * side * 4), side, side, maxColors, true));
    expect(colours).toBeLessThanOrEqual(maxColors);
  });

  /** The 8-bit value of level `index` of `levels` and the level nearest to `value`, by exact rational comparison. */
  function referenceQuantize(value: number, levels: number): number {
    const top = levels - 1;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < levels; index++) {
      // |value - 255 * index / top| scaled by top, so every distance is an exact integer; a tie goes to the higher level.
      const distance = Math.abs(value * top - 255 * index);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    // 255 * index / top rounded half up, from the exact fraction.
    return Math.floor((2 * 255 * bestIndex + top) / (2 * top));
  }

  it('rounds every level count from 2 to 256 to the nearest level, half up, in exact arithmetic', () => {
    const ramp = new Uint8Array(256 * 4);
    for (let value = 0; value < 256; value++) ramp.set([value, value, value, 255], value * 4);
    const mismatches: string[] = [];
    for (let levels = 2; levels <= 256; levels++) {
      // levels^3 colours is exactly `levels` levels in each channel.
      const out = applyRgbaQuantize(ramp, 0, 0, levels ** 3, false);
      for (let value = 0; value < 256; value++) {
        const expected = referenceQuantize(value, levels);
        for (let channel = 0; channel < 3; channel++) {
          if (out[value * 4 + channel] !== expected) {
            mismatches.push(`levels ${levels} value ${value} channel ${channel}: got ${out[value * 4 + channel]} want ${expected}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('keeps the exact tie that the SIMD kernel rounds the other way (15 levels, 127.5)', () => {
    // 15 levels: level 7 sits at exactly 127.5 and rounds half up to 128; 3375 = 15^3 colours give 15 levels per channel.
    const pixel = Uint8Array.from([128, 128, 128, 255]);
    expect(Array.from(applyRgbaQuantize(pixel, 0, 0, 3_375, false))).toEqual([128, 128, 128, 255]);
  });

  it.each(MAX_COLORS_CASES)('gives the same pixels from the engine as from the JS path for maxColors %i', async (maxColors) => {
    const next = mulberry32(maxColors);
    const pixels = new Uint8Array(4 * 4_096);
    for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(next() * 256);
    for (let i = 0; i < 256; i++) pixels.set([i, i, i, 255], i * 4);

    const engine = new WasmEngine();
    const result = await engine.executeTask({
      jobId: 'q',
      task: 'rgba-quantize',
      buffer: asArrayBuffer(pixels),
      options: { colors: maxColors, width: 0, height: 0, dither: false },
    });
    expect(Buffer.from(result.buffer).equals(Buffer.from(applyRgbaQuantize(pixels, 0, 0, maxColors, false)))).toBe(true);
    // One definition on every runtime: the SIMD kernel does not compute these pixels.
    expect(result.simdUsed).toBe(false);
  });

  simdIt('still runs the SIMD kernels for the colour transforms and reports it', async () => {
    requireSimd();
    const engine = new WasmEngine();
    const pixels = asArrayBuffer(GRID.subarray(0, 64 * 4));
    const inverted = await engine.executeTask({ jobId: 's1', task: 'rgba-invert', buffer: pixels.slice(0) });
    expect(inverted.simdUsed).toBe(true);
    expect(Array.from(new Uint8Array(inverted.buffer).subarray(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it.each([0, 1, 2, 7, -5, 3.5, Number.NaN])('refuses maxColors %s, which uniform levels cannot express', (maxColors) => {
    expect(() => applyRgbaQuantize(GRID.subarray(0, 16), 0, 0, maxColors, false)).toThrow(EdgeUnsupportedError);
    expect(() => applyRgbaQuantize(GRID.subarray(0, 16), 0, 0, maxColors, false)).toThrow(/colors/);
  });
});
