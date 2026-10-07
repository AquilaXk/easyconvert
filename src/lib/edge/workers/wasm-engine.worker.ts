/**
 * Zero-COOP Single-Threaded SIMD WebAssembly Worker (Level 2 - L2)
 *
 * Implements high-performance client-side WebAssembly execution:
 * 1. Dual-mode runtime detection (crossOriginIsolated vs Zero-COOP Transferables).
 * 2. 128-bit SIMD vector image transformations.
 * 3. Memory bounding: 32MB initial (512 pages), 1GB max (16,384 pages).
 * 4. Transferable Objects IPC for zero-copy ownership transfer without blocking CDNs.
 */

export interface WasmTaskRequest {
  jobId: string;
  task: 'rgba-grayscale' | 'rgba-invert' | 'rgba-brightness' | 'rgba-quantize' | 'custom-module';
  buffer: ArrayBuffer;
  options?: {
    brightnessDelta?: number;
    width?: number;
    height?: number;
    colors?: number;
    palette?: boolean;
    dither?: boolean;
    colorDepth?: number;
    customWasmBytes?: ArrayBuffer;
  };
}

export interface WasmTaskResult {
  jobId: string;
  buffer: ArrayBuffer;
  executionMode: 'isolated-threads' | 'zero-coop-transferable';
  simdUsed: boolean;
  bytesProcessed: number;
}

export interface WasmWorkerStats {
  cumulativeBytes: number;
  tasksCompleted: number;
  currentHeapPages: number;
  executionMode: 'isolated-threads' | 'zero-coop-transferable';
}

import { UnsupportedOptionError } from '../../types';
import { checkWasmSimdSupport } from '../tier-router';
import { instantiateSimdEngine, WasmSimdExports } from './simd-bytecode';
import { EdgeUnsupportedError, serializeWorkerError } from './worker-errors';

const WASM_PAGE_BYTES = 65_536;
const WASM_INITIAL_PAGES = 512;
const WASM_MAX_PAGES = 16_384;
const WASM_ENGINE_INITIAL_PAGES = 64;
const MAX_CHANNEL_VALUE = 255;
const DEFAULT_QUANTIZE_COLORS = 256;
/** Fewest colours uniform levels can describe: two levels in each of three channels. */
const MIN_QUANTIZE_COLORS = 8;
const MAX_CHANNEL_LEVELS = 256;
/** Largest ratio between the finest and the coarsest channel of the levels derived for a colour count. */
const MAX_LEVEL_RATIO = 2;
const MIN_CHANNEL_LEVELS = 2;

/** Largest module a custom task compiles. */
export const WASM_MAX_MODULE_BYTES = 8 * 1024 * 1024;
/** Largest input a custom task hands to a module. */
export const WASM_MAX_INPUT_BYTES = 512 * 1024 * 1024;
/** Largest linear memory a custom module may have after it is instantiated (the engine's own 1 GiB ceiling). */
export const WASM_MAX_MEMORY_BYTES = WASM_MAX_PAGES * WASM_PAGE_BYTES;

/**
 * Detects whether the current runtime environment is cross-origin isolated.
 */
export function isCrossOriginIsolated(): boolean {
  return typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
}

/**
 * Creates bounded WebAssembly Memory instance.
 * Initial: 512 pages (32MB), Max: 16,384 pages (1GB).
 */
export function createBoundedWasmMemory(
  initialPages: number = WASM_INITIAL_PAGES,
  maxPages: number = WASM_MAX_PAGES
): WebAssembly.Memory {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.Memory !== 'function') {
    throw new Error('WebAssembly is not supported in this environment');
  }
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: maxPages,
    shared: isCrossOriginIsolated(),
  });
}

/**
 * Applies RGBA grayscale conversion using 32-bit vector fixed-point integer arithmetic.
 * Y = (77 * R + 150 * G + 29 * B) >> 8.
 */
export function applyRgbaGrayscale(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.byteLength);
  const len = input.byteLength;

  // Process 4 bytes (1 pixel) at a time with fixed-point math
  for (let i = 0; i < len; i += 4) {
    const r = input[i];
    const g = input[i + 1];
    const b = input[i + 2];
    const gray = (77 * r + 150 * g + 29 * b) >> 8;
    output[i] = gray;
    output[i + 1] = gray;
    output[i + 2] = gray;
    output[i + 3] = input[i + 3]; // Preserve alpha
  }
  return output;
}

/**
 * Applies RGBA color inversion.
 */
export function applyRgbaInvert(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.byteLength);
  const len = input.byteLength;

  for (let i = 0; i < len; i += 4) {
    output[i] = 255 - input[i];
    output[i + 1] = 255 - input[i + 1];
    output[i + 2] = 255 - input[i + 2];
    output[i + 3] = input[i + 3];
  }
  return output;
}

/**
 * Applies RGBA brightness adjustment.
 */
export function applyRgbaBrightness(input: Uint8Array, delta: number = 20): Uint8Array {
  const output = new Uint8Array(input.byteLength);
  const len = input.byteLength;

  for (let i = 0; i < len; i += 4) {
    output[i] = Math.max(0, Math.min(255, input[i] + delta));
    output[i + 1] = Math.max(0, Math.min(255, input[i + 1] + delta));
    output[i + 2] = Math.max(0, Math.min(255, input[i + 2] + delta));
    output[i + 3] = input[i + 3];
  }
  return output;
}

export interface QuantizerLevels {
  r: number;
  g: number;
  b: number;
}

/**
 * The per-channel level counts that keep at most `maxColors` colours: the largest product of three counts
 * (each 2..256, the finest at most twice the coarsest) that does not exceed `maxColors`, the finest going to
 * green and the coarsest to blue, as the eye resolves them. 256 colours give 8 x 8 x 4 levels, 64 give 4 x 4 x 4.
 */
export function deriveQuantizerLevels(maxColors: number): QuantizerLevels {
  if (!Number.isInteger(maxColors) || maxColors < MIN_QUANTIZE_COLORS) {
    throw new EdgeUnsupportedError(
      `The edge quantiser keeps whole numbers of colours from ${MIN_QUANTIZE_COLORS} up (colors ${maxColors}); the server engine builds smaller palettes.`
    );
  }
  // More colours than three full channels hold change nothing; the cap also bounds the search below.
  const allowance = Math.min(maxColors, MAX_CHANNEL_LEVELS ** 3);
  let best = { product: 0, spread: 0, levels: [MIN_CHANNEL_LEVELS, MIN_CHANNEL_LEVELS, MIN_CHANNEL_LEVELS] };
  for (let coarse = MIN_CHANNEL_LEVELS; coarse * coarse * coarse <= allowance; coarse++) {
    for (let middle = coarse; middle * middle * coarse <= allowance; middle++) {
      const fine = Math.min(MAX_CHANNEL_LEVELS, MAX_LEVEL_RATIO * coarse, Math.floor(allowance / (middle * coarse)));
      if (fine < middle) continue;
      const product = fine * middle * coarse;
      const spread = fine - coarse;
      if (product > best.product || (product === best.product && spread < best.spread)) {
        best = { product, spread, levels: [fine, middle, coarse] };
      }
    }
  }
  const [fine, middle, coarse] = best.levels;
  return { g: fine, r: middle, b: coarse };
}

/**
 * The level of `levels` evenly spaced values over 0..255 that is nearest to `value` (a tie goes to the higher
 * level), as that level's value (rounded half up). It is integer arithmetic, so every runtime gives the same bytes.
 */
function quantizeChannelValue(value: number, levels: number): number {
  const top = levels - 1;
  const index = Math.floor((2 * value * top + MAX_CHANNEL_VALUE) / (2 * MAX_CHANNEL_VALUE));
  return Math.floor((2 * MAX_CHANNEL_VALUE * index + top) / (2 * top));
}

/**
 * Applies RGBA color quantization and optional error diffusion dithering.
 * Preserves chromatic color channels instead of forcing grayscale. Levels come from `maxColors` through
 * deriveQuantizerLevels, so the output holds at most that many colours.
 */
export function applyRgbaQuantize(
  input: Uint8Array,
  width: number = 0,
  height: number = 0,
  maxColors: number = DEFAULT_QUANTIZE_COLORS,
  dither: boolean = false
): Uint8Array {
  const output = new Uint8Array(input.byteLength);
  const len = input.byteLength;
  const { r: rLevels, g: gLevels, b: bLevels } = deriveQuantizerLevels(maxColors);

  if (len === 0) return output;

  const quantizeChannel = quantizeChannelValue;

  if (!dither || width <= 0 || height <= 0 || width * height * 4 !== len) {
    for (let i = 0; i < len; i += 4) {
      output[i] = quantizeChannel(input[i], rLevels);
      output[i + 1] = quantizeChannel(input[i + 1], gLevels);
      output[i + 2] = quantizeChannel(input[i + 2], bLevels);
      output[i + 3] = input[i + 3];
    }
    return output;
  }

  // Floyd-Steinberg error diffusion dithering
  const curRowErrR = new Float32Array(width + 2);
  const curRowErrG = new Float32Array(width + 2);
  const curRowErrB = new Float32Array(width + 2);
  const nextRowErrR = new Float32Array(width + 2);
  const nextRowErrG = new Float32Array(width + 2);
  const nextRowErrB = new Float32Array(width + 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const xOffset = x + 1;

      const r = Math.max(0, Math.min(255, input[idx] + curRowErrR[xOffset]));
      const g = Math.max(0, Math.min(255, input[idx + 1] + curRowErrG[xOffset]));
      const b = Math.max(0, Math.min(255, input[idx + 2] + curRowErrB[xOffset]));

      const qr = quantizeChannel(r, rLevels);
      const qg = quantizeChannel(g, gLevels);
      const qb = quantizeChannel(b, bLevels);

      output[idx] = qr;
      output[idx + 1] = qg;
      output[idx + 2] = qb;
      output[idx + 3] = input[idx + 3]; // Preserve alpha

      const errR = r - qr;
      const errG = g - qg;
      const errB = b - qb;

      // Diffuse Floyd-Steinberg errors:
      // (x+1, y)   * 7/16
      curRowErrR[xOffset + 1] += (errR * 7) / 16;
      curRowErrG[xOffset + 1] += (errG * 7) / 16;
      curRowErrB[xOffset + 1] += (errB * 7) / 16;

      // (x-1, y+1) * 3/16
      nextRowErrR[xOffset - 1] += (errR * 3) / 16;
      nextRowErrG[xOffset - 1] += (errG * 3) / 16;
      nextRowErrB[xOffset - 1] += (errB * 3) / 16;

      // (x, y+1)   * 5/16
      nextRowErrR[xOffset] += (errR * 5) / 16;
      nextRowErrG[xOffset] += (errG * 5) / 16;
      nextRowErrB[xOffset] += (errB * 5) / 16;

      // (x+1, y+1) * 1/16
      nextRowErrR[xOffset + 1] += (errR * 1) / 16;
      nextRowErrG[xOffset + 1] += (errG * 1) / 16;
      nextRowErrB[xOffset + 1] += (errB * 1) / 16;
    }

    curRowErrR.set(nextRowErrR);
    curRowErrG.set(nextRowErrG);
    curRowErrB.set(nextRowErrB);
    nextRowErrR.fill(0);
    nextRowErrG.fill(0);
    nextRowErrB.fill(0);
  }

  return output;
}

/**
 * Wasm Engine Executor class with memory bounding and statistics tracking.
 */
export class WasmEngine {
  private cumulativeBytes: number = 0;
  private tasksCompleted: number = 0;
  private readonly memory: WebAssembly.Memory | null = null;
  private readonly simdExports: WasmSimdExports | null = null;
  private readonly hasSimd: boolean;
  /** Whether a SIMD kernel computed the pixels of the task in progress (a JS fallback leaves it false). */
  private simdKernelRan = false;

  constructor() {
    this.hasSimd = checkWasmSimdSupport();
    try {
      this.memory = createBoundedWasmMemory(WASM_ENGINE_INITIAL_PAGES, WASM_MAX_PAGES); // Safe initialization in workers
      if (this.hasSimd && this.memory) {
        const { exports } = instantiateSimdEngine(this.memory);
        this.simdExports = exports;
      }
    } catch {
      this.memory = null;
      this.simdExports = null;
    }
  }

  public getStats(): WasmWorkerStats {
    let currentHeapPages = 0;
    try {
      currentHeapPages = this.memory ? this.memory.buffer.byteLength / WASM_PAGE_BYTES : 0;
    } catch {
      currentHeapPages = 0;
    }

    return {
      cumulativeBytes: this.cumulativeBytes,
      tasksCompleted: this.tasksCompleted,
      currentHeapPages,
      executionMode: isCrossOriginIsolated() ? 'isolated-threads' : 'zero-coop-transferable',
    };
  }

  private ensureMemoryCapacity(byteLength: number): boolean {
    if (!this.memory) return false;
    const currentBytes = this.memory.buffer.byteLength;
    if (currentBytes >= byteLength) return true;
    const neededPages = Math.ceil((byteLength - currentBytes) / WASM_PAGE_BYTES);
    try {
      this.memory.grow(neededPages);
      return true;
    } catch {
      return false;
    }
  }

  public executeGrayscale(input: Uint8Array): Uint8Array {
    if (this.simdExports && this.memory && this.ensureMemoryCapacity(input.byteLength)) {
      const u8 = new Uint8Array(this.memory.buffer);
      u8.set(input, 0);
      this.simdKernelRan = true;
      this.simdExports.rgba_grayscale(0, input.byteLength);
      return new Uint8Array(u8.subarray(0, input.byteLength));
    }
    return applyRgbaGrayscale(input);
  }

  public executeInvert(input: Uint8Array): Uint8Array {
    if (this.simdExports && this.memory && this.ensureMemoryCapacity(input.byteLength)) {
      const u8 = new Uint8Array(this.memory.buffer);
      u8.set(input, 0);
      this.simdKernelRan = true;
      this.simdExports.rgba_invert(0, input.byteLength);
      return new Uint8Array(u8.subarray(0, input.byteLength));
    }
    return applyRgbaInvert(input);
  }

  public executeBrightness(input: Uint8Array, delta: number = 20): Uint8Array {
    if (this.simdExports && this.memory && this.ensureMemoryCapacity(input.byteLength)) {
      const u8 = new Uint8Array(this.memory.buffer);
      u8.set(input, 0);
      this.simdKernelRan = true;
      this.simdExports.rgba_brightness(0, input.byteLength, delta);
      return new Uint8Array(u8.subarray(0, input.byteLength));
    }
    return applyRgbaBrightness(input, delta);
  }

  /**
   * Quantises on the JS path only. The SIMD kernel rounds in 32-bit floats and lands one step away from the
   * exact rounding at the levels where a boundary falls on a half (15 levels, 127.5), so the same file would
   * come out differently with and without SIMD; one definition keeps the bytes the same on every runtime.
   */
  public executeQuantize(
    input: Uint8Array,
    width: number = 0,
    height: number = 0,
    maxColors: number = DEFAULT_QUANTIZE_COLORS,
    dither: boolean = false
  ): Uint8Array {
    return applyRgbaQuantize(input, width, height, maxColors, dither);
  }

  public async executeTask(
    request: WasmTaskRequest,
    onProgress?: (progress: number) => void
  ): Promise<WasmTaskResult> {
    onProgress?.(10);
    const inputBytes = new Uint8Array(request.buffer);
    let outputBytes: Uint8Array;
    this.simdKernelRan = false;

    onProgress?.(40);

    switch (request.task) {
      case 'rgba-grayscale':
        outputBytes = this.executeGrayscale(inputBytes);
        break;
      case 'rgba-invert':
        outputBytes = this.executeInvert(inputBytes);
        break;
      case 'rgba-brightness':
        outputBytes = this.executeBrightness(inputBytes, request.options?.brightnessDelta ?? 25);
        break;
      case 'rgba-quantize':
        outputBytes = this.executeQuantize(
          inputBytes,
          request.options?.width || 0,
          request.options?.height || 0,
          request.options?.colors ?? DEFAULT_QUANTIZE_COLORS,
          request.options?.dither ?? false
        );
        break;
      case 'custom-module':
        outputBytes = await this.executeCustomWasm(inputBytes, request.options?.customWasmBytes);
        break;
      default:
        throw new Error(`Unknown Wasm task: ${(request as any).task}`);
    }

    onProgress?.(90);

    this.cumulativeBytes += inputBytes.byteLength;
    this.tasksCompleted += 1;

    const outBuffer = new ArrayBuffer(outputBytes.byteLength);
    new Uint8Array(outBuffer).set(outputBytes);

    onProgress?.(100);

    return {
      jobId: request.jobId,
      buffer: outBuffer,
      executionMode: isCrossOriginIsolated() ? 'isolated-threads' : 'zero-coop-transferable',
      simdUsed: this.simdKernelRan,
      bytesProcessed: inputBytes.byteLength,
    };
  }

  /**
   * Runs a caller's WebAssembly module over `inputBytes`. The ABI has no imports and three exports:
   * `memory`, `alloc(len: i32) -> i32` (the address of a region of `len` bytes) and `transform(ptr: i32, len: i32) -> i32`
   * (rewrites the region in place and returns the number of output bytes, at most `len`). The result is those bytes.
   * Every address and length is checked against the module's memory; a module that breaks the ABI is refused.
   */
  private async executeCustomWasm(inputBytes: Uint8Array, customWasmBytes?: ArrayBuffer): Promise<Uint8Array> {
    if (!customWasmBytes) {
      throw new UnsupportedOptionError('The custom-module task needs customWasmBytes: the WebAssembly module to run.');
    }
    if (customWasmBytes.byteLength > WASM_MAX_MODULE_BYTES) {
      throw customModuleRefusal(`the module is larger than ${WASM_MAX_MODULE_BYTES} bytes (module limit)`);
    }
    if (inputBytes.byteLength === 0) throw customModuleRefusal('there is no input to hand to the module');
    if (inputBytes.byteLength > WASM_MAX_INPUT_BYTES) {
      throw customModuleRefusal(`the input is larger than ${WASM_MAX_INPUT_BYTES} bytes (input limit)`);
    }

    let wasmModule: WebAssembly.Module;
    try {
      wasmModule = await WebAssembly.compile(customWasmBytes);
    } catch (error) {
      throw customModuleRefusal(`the bytes are not a valid WebAssembly module (${describeFault(error)})`);
    }
    const imports = WebAssembly.Module.imports(wasmModule);
    if (imports.length > 0) {
      throw customModuleRefusal(
        `the module imports ${imports.map((item) => `${item.module}.${item.name}`).join(', ')}, and the ABI has no imports`
      );
    }
    let instance: WebAssembly.Instance;
    try {
      instance = await WebAssembly.instantiate(wasmModule);
    } catch (error) {
      throw customModuleRefusal(`the module could not be instantiated (${describeFault(error)})`);
    }

    const { memory, alloc, transform } = instance.exports;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw customModuleRefusal('the module does not export its linear memory as "memory"');
    }
    if (typeof alloc !== 'function') throw customModuleRefusal('the module does not export "alloc(len) -> ptr"');
    if (typeof transform !== 'function') {
      throw customModuleRefusal('the module does not export "transform(ptr, len) -> len"');
    }
    if (memory.buffer.byteLength > WASM_MAX_MEMORY_BYTES) {
      throw customModuleRefusal(`the module memory is larger than ${WASM_MAX_MEMORY_BYTES} bytes (memory limit)`);
    }

    const length = inputBytes.byteLength;
    const pointer = runModuleFunction('alloc', () => alloc(length)) >>> 0;
    if (pointer + length > memory.buffer.byteLength) {
      throw customModuleRefusal(
        `alloc returned address ${pointer} for ${length} bytes, outside the module memory of ${memory.buffer.byteLength} bytes`
      );
    }
    new Uint8Array(memory.buffer, pointer, length).set(inputBytes);

    const outputLength = runModuleFunction('transform', () => transform(pointer, length)) >>> 0;
    if (outputLength > length) {
      throw customModuleRefusal(`transform reported ${outputLength} output bytes for a region of ${length}`);
    }
    if (outputLength === 0) throw customModuleRefusal('transform reported no output bytes');
    if (pointer + outputLength > memory.buffer.byteLength) {
      throw customModuleRefusal('the module memory shrank below its own output');
    }
    // A copy: the module's memory is not the caller's to keep.
    return new Uint8Array(memory.buffer, pointer, outputLength).slice();
  }
}

function customModuleRefusal(message: string): EdgeUnsupportedError {
  return new EdgeUnsupportedError(`The custom Wasm module is refused: ${message}.`);
}

function describeFault(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Calls one export of a caller's module; a trap inside it becomes a refusal instead of a raw RuntimeError. */
function runModuleFunction(name: string, call: () => unknown): number {
  let result: unknown;
  try {
    result = call();
  } catch (error) {
    throw customModuleRefusal(`${name} trapped (${describeFault(error)})`);
  }
  if (typeof result !== 'number') throw customModuleRefusal(`${name} did not return an i32`);
  return result;
}

type WasmWorkerPost = (message: Record<string, unknown>, transfer?: Transferable[]) => void;

/**
 * Runs one worker request and reports through `post`: progress, the result, or the error serialised with its
 * class name so the main thread can rethrow the same typed error.
 */
export async function runWasmWorkerJob(
  data: Record<string, any>,
  post: WasmWorkerPost,
  engine: WasmEngine
): Promise<void> {
  if (!data) return;
  if (data.type === 'EXECUTE') {
    try {
      const result = await engine.executeTask(
        { jobId: data.jobId, task: data.task, buffer: data.buffer, options: data.options },
        (progress) => post({ type: 'PROGRESS', jobId: data.jobId, progress })
      );
      // Zero-copy transfer of output buffer
      post(
        {
          type: 'COMPLETED',
          jobId: result.jobId,
          buffer: result.buffer,
          executionMode: result.executionMode,
          simdUsed: result.simdUsed,
          bytesProcessed: result.bytesProcessed,
        },
        [result.buffer]
      );
    } catch (err) {
      const error = serializeWorkerError(err);
      post({ type: 'ERROR', jobId: data.jobId, message: error.message, error });
    }
  } else if (data.type === 'GET_STATS') {
    post({ type: 'STATS', jobId: data.jobId, stats: engine.getStats() });
  }
}

// Global engine singleton for worker
const workerEngine = new WasmEngine();

if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = async (e: MessageEvent) => {
    await runWasmWorkerJob(e.data, (message, transfer) => (self as any).postMessage(message, transfer ?? []), workerEngine);
  };
}
