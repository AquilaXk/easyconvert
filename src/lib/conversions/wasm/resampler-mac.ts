import { ModuleBuilder, VALUE_TYPE, type FunctionBody } from './wasm-assembler';

/**
 * Multiply-accumulate kernels of the polyphase resampler, in WebAssembly with 128-bit SIMD (two doubles per vector).
 * The module is assembled from the instructions below at first use (see wasm-assembler.ts); nothing prebuilt is shipped.
 *
 * Each kernel computes every output of one kernel row, the same loop as the scalar `convolveRowAsymmetric` of
 * audio-resampler.ts, and keeps the accumulators of each output in the same order: a vector lane is one scalar
 * accumulator, and the partial sums are combined in the same order. IEEE double multiplies and adds are not fused, so the
 * results are bit-identical to the scalar path, not merely close. For stereo the scalar loop handles two consecutive
 * periods at once (two accumulators per output) while the second still lies inside the block, and one period (four
 * accumulators) otherwise; four periods at once are two such pairs, so the quad path gives the same samples and has
 * twice the independent accumulator chains to hide the latency of the adds.
 *
 * Exports (all arguments i32; addresses are byte offsets into the imported memory, `frames` are indices):
 *   rowStereo(row, x, out, taps, up, down, base, firstPeriod, periods, firstOutput, count)
 *   rowMono(...same...)
 * `row` points at `taps` doubles (a multiple of 4), `x` at the block's interleaved input, `out` at its output.
 */

const I32 = VALUE_TYPE.i32;
const V128 = VALUE_TYPE.v128;
const DOUBLE_BYTES = 8;
const STEREO_FRAME_SHIFT = 4; // 2 channels x 8 bytes
const MONO_FRAME_SHIFT = 3;
const TAPS_PER_MONO_STEP = 4;
const TAPS_PER_SINGLE_STEP = 4;
const TAPS_PER_MULTI_STEP = 2;
const VECTOR_BYTES = 16;
const BYTES_PER_PAGE = 65536;
const PERIODS_PER_QUAD = 4;
const PERIODS_PER_PAIR = 2;

// Parameter indices shared by both functions.
const P_ROW = 0;
const P_X = 1;
const P_OUT = 2;
const P_TAPS = 3;
const P_UP = 4;
const P_DOWN = 5;
const P_BASE = 6;
const P_FIRST_PERIOD = 7;
const P_PERIODS = 8;
const P_FIRST_OUTPUT = 9;
const P_COUNT = 10;
const PARAMS = Array.from({ length: 11 }, () => I32);

/** Emits `local[acc] = local[acc] + local[coef] * v128.load(local[address] + offset)`. */
function accumulate(f: FunctionBody, acc: number, coef: number, address: number, offset: number): void {
  f.localGet(acc).localGet(coef).localGet(address).v128Load(offset).f64x2Mul().f64x2Add().localSet(acc);
}

/** Emits `local[target] = splat(f64.load(local[address] + offset))`. */
function loadSplat(f: FunctionBody, target: number, address: number, offset: number): void {
  f.localGet(address).f64Load(offset).f64x2Splat().localSet(target);
}

/** Emits the stores' address `local[out] + (local[index] << shift)`. */
function outAddress(f: FunctionBody, out: number, index: number, shift: number): void {
  f.localGet(out).localGet(index).i32Const(shift).i32Shl().i32Add();
}

function zero(f: FunctionBody, ...registers: number[]): void {
  for (const register of registers) f.v128ConstZero().localSet(register);
}

/** Emits `local[local] += constant`. */
function addConstant(f: FunctionBody, local: number, constant: number): void {
  f.localGet(local).i32Const(constant).i32Add().localSet(local);
}

/** The loop head shared by both kernels: leaves n, and the input byte address in `q`, or exits the outer block. */
function periodHead(f: FunctionBody, k: number, n: number, q: number, frameShift: number): void {
  // if (k >= periods) exit
  f.localGet(k).localGet(P_PERIODS).i32GeS().brIf(1);
  // n = k * up + firstOutput
  f.localGet(k).localGet(P_UP).i32Mul().localGet(P_FIRST_OUTPUT).i32Add().localSet(n);
  // if (n >= count) exit
  f.localGet(n).localGet(P_COUNT).i32GeS().brIf(1);
  // q = x + ((k * down + base) << frameShift)
  f.localGet(P_X).localGet(k).localGet(P_DOWN).i32Mul().localGet(P_BASE).i32Add().i32Const(frameShift).i32Shl().i32Add().localSet(q);
}

/**
 * Emits the loop over taps for several consecutive periods that share the kernel row, two taps per pass with the even
 * tap in `even[i]` and the odd tap in `odd[i]` of period i; `addresses[i]` is the input address of period i.
 */
function multiPeriodLoop(f: FunctionBody, t: number, tEnd: number, c0: number, c1: number, even: number[], odd: number[], addresses: number[]): void {
  f.localGet(P_ROW).localSet(t);
  f.loop();
  loadSplat(f, c0, t, 0);
  loadSplat(f, c1, t, DOUBLE_BYTES);
  for (let i = 0; i < addresses.length; i++) {
    accumulate(f, even[i], c0, addresses[i], 0);
    accumulate(f, odd[i], c1, addresses[i], VECTOR_BYTES);
  }
  for (const address of addresses) addConstant(f, address, TAPS_PER_MULTI_STEP * VECTOR_BYTES);
  f.localGet(t).i32Const(TAPS_PER_MULTI_STEP * DOUBLE_BYTES).i32Add().localTee(t).localGet(tEnd).i32LtS().brIf(0);
  f.end();
}

function buildStereo(f: FunctionBody): void {
  const k = f.addLocal(I32);
  const n = f.addLocal(I32);
  const t = f.addLocal(I32);
  const tEnd = f.addLocal(I32);
  const addresses = [f.addLocal(I32), f.addLocal(I32), f.addLocal(I32), f.addLocal(I32)];
  const [qa, qb, qc, qd] = addresses;
  const even = [f.addLocal(V128), f.addLocal(V128), f.addLocal(V128), f.addLocal(V128)];
  const odd = [f.addLocal(V128), f.addLocal(V128), f.addLocal(V128), f.addLocal(V128)];
  const c0 = f.addLocal(V128);
  const c1 = f.addLocal(V128);
  const c2 = f.addLocal(V128);
  const c3 = f.addLocal(V128);

  // tEnd = row + taps * 8; k = firstPeriod
  f.localGet(P_ROW).localGet(P_TAPS).i32Const(MONO_FRAME_SHIFT).i32Shl().i32Add().localSet(tEnd);
  f.localGet(P_FIRST_PERIOD).localSet(k);

  f.block().loop();
  periodHead(f, k, n, qa, STEREO_FRAME_SHIFT);

  // Periods that share the kernel row while they lie inside the block: four if n + 3 up < count, else two if n + up < count.
  f.localGet(n).localGet(P_UP).i32Const(PERIODS_PER_QUAD - 1).i32Mul().i32Add().localGet(P_COUNT).i32LtS().if_();
  {
    // The input addresses of periods k + 1 .. k + 3 follow from `down`.
    for (let i = 1; i < PERIODS_PER_QUAD; i++) {
      f.localGet(addresses[i - 1]).localGet(P_DOWN).i32Const(STEREO_FRAME_SHIFT).i32Shl().i32Add().localSet(addresses[i]);
    }
    zero(f, ...even, ...odd);
    multiPeriodLoop(f, t, tEnd, c0, c1, even, odd, [qa, qb, qc, qd]);
    // out[n + i up] = even[i] + odd[i]
    for (let i = 0; i < PERIODS_PER_QUAD; i++) {
      outAddress(f, P_OUT, n, STEREO_FRAME_SHIFT);
      f.localGet(even[i]).localGet(odd[i]).f64x2Add().v128Store(0);
      if (i < PERIODS_PER_QUAD - 1) f.localGet(n).localGet(P_UP).i32Add().localSet(n);
    }
    addConstant(f, k, PERIODS_PER_QUAD);
  }
  f.else_();
  f.localGet(n).localGet(P_UP).i32Add().localGet(P_COUNT).i32LtS().if_();
  {
    f.localGet(qa).localGet(P_DOWN).i32Const(STEREO_FRAME_SHIFT).i32Shl().i32Add().localSet(qb);
    zero(f, even[0], even[1], odd[0], odd[1]);
    multiPeriodLoop(f, t, tEnd, c0, c1, [even[0], even[1]], [odd[0], odd[1]], [qa, qb]);
    outAddress(f, P_OUT, n, STEREO_FRAME_SHIFT);
    f.localGet(even[0]).localGet(odd[0]).f64x2Add().v128Store(0);
    f.localGet(n).localGet(P_UP).i32Add().localSet(n);
    outAddress(f, P_OUT, n, STEREO_FRAME_SHIFT);
    f.localGet(even[1]).localGet(odd[1]).f64x2Add().v128Store(0);
    addConstant(f, k, PERIODS_PER_PAIR);
  }
  f.else_();
  {
    // One period: four accumulators, taps j mod 4 each.
    const [a0, a1, a2, a3] = even;
    zero(f, a0, a1, a2, a3);
    f.localGet(P_ROW).localSet(t);
    f.loop();
    {
      loadSplat(f, c0, t, 0);
      loadSplat(f, c1, t, DOUBLE_BYTES);
      loadSplat(f, c2, t, 2 * DOUBLE_BYTES);
      loadSplat(f, c3, t, 3 * DOUBLE_BYTES);
      accumulate(f, a0, c0, qa, 0);
      accumulate(f, a1, c1, qa, VECTOR_BYTES);
      accumulate(f, a2, c2, qa, 2 * VECTOR_BYTES);
      accumulate(f, a3, c3, qa, 3 * VECTOR_BYTES);
      addConstant(f, qa, TAPS_PER_SINGLE_STEP * VECTOR_BYTES);
      f.localGet(t).i32Const(TAPS_PER_SINGLE_STEP * DOUBLE_BYTES).i32Add().localTee(t).localGet(tEnd).i32LtS().brIf(0);
    }
    f.end();
    // out[n] = (a0 + a1) + (a2 + a3)
    outAddress(f, P_OUT, n, STEREO_FRAME_SHIFT);
    f.localGet(a0).localGet(a1).f64x2Add().localGet(a2).localGet(a3).f64x2Add().f64x2Add().v128Store(0);
    addConstant(f, k, 1);
  }
  f.end().end();
  f.br(0).end().end();
}

function buildMono(f: FunctionBody): void {
  const k = f.addLocal(I32);
  const n = f.addLocal(I32);
  const q = f.addLocal(I32);
  const t = f.addLocal(I32);
  const tEnd = f.addLocal(I32);
  const v0 = f.addLocal(V128);
  const v1 = f.addLocal(V128);

  f.localGet(P_ROW).localGet(P_TAPS).i32Const(MONO_FRAME_SHIFT).i32Shl().i32Add().localSet(tEnd);
  f.localGet(P_FIRST_PERIOD).localSet(k);

  f.block().loop();
  periodHead(f, k, n, q, MONO_FRAME_SHIFT);
  zero(f, v0, v1);
  f.localGet(P_ROW).localSet(t);
  f.loop();
  {
    // v0 += row[t..t+1] * x[q..q+1]; v1 += row[t+2..t+3] * x[q+2..q+3]
    f.localGet(v0).localGet(t).v128Load(0).localGet(q).v128Load(0).f64x2Mul().f64x2Add().localSet(v0);
    f.localGet(v1).localGet(t).v128Load(VECTOR_BYTES).localGet(q).v128Load(VECTOR_BYTES).f64x2Mul().f64x2Add().localSet(v1);
    addConstant(f, q, TAPS_PER_MONO_STEP * DOUBLE_BYTES);
    f.localGet(t).i32Const(TAPS_PER_MONO_STEP * DOUBLE_BYTES).i32Add().localTee(t).localGet(tEnd).i32LtS().brIf(0);
  }
  f.end();
  // out[n] = (v0[0] + v0[1]) + (v1[0] + v1[1])
  outAddress(f, P_OUT, n, MONO_FRAME_SHIFT);
  f.localGet(v0).f64x2ExtractLane(0).localGet(v0).f64x2ExtractLane(1).f64Add();
  f.localGet(v1).f64x2ExtractLane(0).localGet(v1).f64x2ExtractLane(1).f64Add();
  f.f64Add().f64Store(0);
  addConstant(f, k, 1);
  f.br(0).end().end();
}

/** The module's bytes, assembled from the kernels above. */
export function assembleResamplerKernels(): Uint8Array<ArrayBuffer> {
  const builder = new ModuleBuilder('env', 'memory', 1);
  buildStereo(builder.addFunction('rowStereo', PARAMS, []));
  buildMono(builder.addFunction('rowMono', PARAMS, []));
  return builder.build();
}

export interface MacKernelExports {
  rowStereo(row: number, x: number, out: number, taps: number, up: number, down: number, base: number, firstPeriod: number, periods: number, firstOutput: number, count: number): void;
  rowMono(row: number, x: number, out: number, taps: number, up: number, down: number, base: number, firstPeriod: number, periods: number, firstOutput: number, count: number): void;
}

export interface MacKernel extends MacKernelExports {
  readonly memory: WebAssembly.Memory;
}

/** Largest linear memory a kernel instance may be given (the resampler bounds its scratch well below this). */
export const MAC_MEMORY_MAX_BYTES = 256 * 1024 * 1024;

let compiled: WebAssembly.Module | null | undefined;

/** The compiled module, or null when this runtime has no WebAssembly SIMD (decided once). */
function compiledModule(): WebAssembly.Module | null {
  if (compiled !== undefined) return compiled;
  try {
    const bytes = assembleResamplerKernels();
    compiled = typeof WebAssembly === 'object' && WebAssembly.validate(bytes) ? new WebAssembly.Module(bytes) : null;
  } catch {
    compiled = null;
  }
  return compiled;
}

/** Whether the SIMD kernels can run here. */
export function macKernelSupported(): boolean {
  return compiledModule() !== null;
}

/**
 * Instantiates the kernels over a fresh linear memory of at least `bytes` bytes. Returns null when WebAssembly SIMD is not
 * available; throws a RangeError for a size beyond MAC_MEMORY_MAX_BYTES.
 */
export function createMacKernel(bytes: number): MacKernel | null {
  const compiledKernels = compiledModule();
  if (compiledKernels === null) return null;
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAC_MEMORY_MAX_BYTES) throw new RangeError(`kernel memory of ${bytes} bytes is out of range`);
  const pages = Math.max(1, Math.ceil(bytes / BYTES_PER_PAGE));
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  const instance = new WebAssembly.Instance(compiledKernels, { env: { memory } });
  const exports = instance.exports as unknown as MacKernelExports;
  return { memory, rowStereo: exports.rowStereo, rowMono: exports.rowMono };
}
