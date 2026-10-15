import { ModuleBuilder, VALUE_TYPE, type FunctionBody } from './wasm-assembler';

/**
 * XXH64 (seed 0) in WebAssembly, for the content checksum of Zstandard frames (RFC 8878 section 3.1.1, the low 32 bits).
 * The algorithm is the one in the xxHash specification: four 64-bit lanes consume 32 bytes per round, the lanes are
 * merged, the tail is folded in by 8, 4 and 1 bytes, and the result is avalanched. WebAssembly has native 64-bit
 * multiplies and rotates, which the 32-bit arithmetic of a script cannot match.
 *
 * Exports (memory is imported; addresses are byte offsets):
 *   stripes(state, ptr, len)             consumes len bytes (a multiple of 32) into the four lanes at `state`
 *   finish(state, tail, tailLen, total, seeded) -> i64
 *                                        merges the lanes (when seeded), folds the tail and avalanches
 */

const I32 = VALUE_TYPE.i32;
const I64 = VALUE_TYPE.i64;
const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;
const INT64_RANGE = 2n ** 64n;
const INT64_SIGN = 2n ** 63n;
const ROTATE_ROUND = 31n;
const ROTATE_MERGE: readonly bigint[] = [1n, 7n, 12n, 18n];
const ROTATE_TAIL_8 = 27n;
const ROTATE_TAIL_4 = 23n;
const ROTATE_TAIL_1 = 11n;
const AVALANCHE_SHIFT_1 = 33n;
const AVALANCHE_SHIFT_2 = 29n;
const AVALANCHE_SHIFT_3 = 32n;
const STRIPE_BYTES = 32;
const LANE_BYTES = 8;
const WORD_BYTES = 4;
const BYTES_PER_PAGE = 65536;
const LANES = 4;
/** Bytes of the lane state, then of the tail buffer, then the chunk buffer inputs are copied into. */
const STATE_PTR = 0;
const TAIL_PTR = 32;
const CHUNK_PTR = 64;
/** Input handed to the kernel per call (a multiple of the stripe size). */
const CHUNK_BYTES = 1024 * 1024;
/** Shorter inputs are hashed by the caller's own code: the call and the copy cost more than they save. */
export const XXH64_WASM_MIN_BYTES = 1024;
/** The total length reaches the kernel as an i32. */
const TOTAL_LENGTH_MAX = 0xffffffff;

/** The constants as the signed 64-bit immediates WebAssembly takes. */
function signed(value: bigint): bigint {
  return value >= INT64_SIGN ? value - INT64_RANGE : value;
}

// Parameter indices.
const STRIPES_STATE = 0;
const STRIPES_PTR = 1;
const STRIPES_LEN = 2;
const FINISH_STATE = 0;
const FINISH_TAIL = 1;
const FINISH_TAIL_LEN = 2;
const FINISH_TOTAL = 3;
const FINISH_SEEDED = 4;

/** Pushes `rotl(value * P2, 31) * P1`, the round with an accumulator of zero, for a value already on the stack. */
function roundOfZero(f: FunctionBody): void {
  f.i64Const(signed(PRIME64_2)).i64Mul().i64Const(ROTATE_ROUND).i64Rotl().i64Const(signed(PRIME64_1)).i64Mul();
}

/** Emits `acc = rotl(acc + input * P2, 31) * P1` for an `input` pushed by `pushInput`. */
function round(f: FunctionBody, acc: number, pushInput: () => void): void {
  f.localGet(acc);
  pushInput();
  f.i64Const(signed(PRIME64_2)).i64Mul().i64Add().i64Const(ROTATE_ROUND).i64Rotl().i64Const(signed(PRIME64_1)).i64Mul().localSet(acc);
}

function buildStripes(f: FunctionBody): void {
  const end = f.addLocal(I32);
  const lanes = [f.addLocal(I64), f.addLocal(I64), f.addLocal(I64), f.addLocal(I64)];
  for (let i = 0; i < LANES; i++) f.localGet(STRIPES_STATE).i64Load(i * LANE_BYTES).localSet(lanes[i]);
  f.localGet(STRIPES_PTR).localGet(STRIPES_LEN).i32Add().localSet(end);
  f.block().loop();
  f.localGet(STRIPES_PTR).localGet(end).i32GeU().brIf(1);
  for (let i = 0; i < LANES; i++) round(f, lanes[i], () => f.localGet(STRIPES_PTR).i64Load(i * LANE_BYTES));
  f.localGet(STRIPES_PTR).i32Const(STRIPE_BYTES).i32Add().localSet(STRIPES_PTR);
  f.br(0).end().end();
  for (let i = 0; i < LANES; i++) f.localGet(STRIPES_STATE).localGet(lanes[i]).i64Store(i * LANE_BYTES);
}

function buildFinish(f: FunctionBody): void {
  const h = f.addLocal(I64);
  const end = f.addLocal(I32);
  const v = [f.addLocal(I64), f.addLocal(I64), f.addLocal(I64), f.addLocal(I64)];

  f.localGet(FINISH_SEEDED).if_();
  {
    for (let i = 0; i < LANES; i++) f.localGet(FINISH_STATE).i64Load(i * LANE_BYTES).localSet(v[i]);
    // h = rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)
    f.localGet(v[0]).i64Const(ROTATE_MERGE[0]).i64Rotl();
    for (let i = 1; i < LANES; i++) f.localGet(v[i]).i64Const(ROTATE_MERGE[i]).i64Rotl().i64Add();
    f.localSet(h);
    // merge round per lane: h = (h ^ round(0, v)) * P1 + P4
    for (let i = 0; i < LANES; i++) {
      f.localGet(h).localGet(v[i]);
      roundOfZero(f);
      f.i64Xor().i64Const(signed(PRIME64_1)).i64Mul().i64Const(signed(PRIME64_4)).i64Add().localSet(h);
    }
  }
  f.else_();
  f.i64Const(signed(PRIME64_5)).localSet(h);
  f.end();

  // h += total length
  f.localGet(h).localGet(FINISH_TOTAL).i64ExtendI32U().i64Add().localSet(h);
  f.localGet(FINISH_TAIL).localGet(FINISH_TAIL_LEN).i32Add().localSet(end);

  // 8 bytes at a time: h = rotl(h ^ round(0, k), 27) * P1 + P4
  f.block().loop();
  f.localGet(FINISH_TAIL).i32Const(LANE_BYTES).i32Add().localGet(end).i32GtU().brIf(1);
  f.localGet(h).localGet(FINISH_TAIL).i64Load(0);
  roundOfZero(f);
  f.i64Xor().i64Const(ROTATE_TAIL_8).i64Rotl().i64Const(signed(PRIME64_1)).i64Mul().i64Const(signed(PRIME64_4)).i64Add().localSet(h);
  f.localGet(FINISH_TAIL).i32Const(LANE_BYTES).i32Add().localSet(FINISH_TAIL);
  f.br(0).end().end();

  // 4 bytes: h = rotl(h ^ (k * P1), 23) * P2 + P3
  f.localGet(FINISH_TAIL).i32Const(WORD_BYTES).i32Add().localGet(end).i32LeU().if_();
  f.localGet(h).localGet(FINISH_TAIL).i64Load32U(0).i64Const(signed(PRIME64_1)).i64Mul().i64Xor();
  f.i64Const(ROTATE_TAIL_4).i64Rotl().i64Const(signed(PRIME64_2)).i64Mul().i64Const(signed(PRIME64_3)).i64Add().localSet(h);
  f.localGet(FINISH_TAIL).i32Const(WORD_BYTES).i32Add().localSet(FINISH_TAIL);
  f.end();

  // 1 byte at a time: h = rotl(h ^ (b * P5), 11) * P1
  f.block().loop();
  f.localGet(FINISH_TAIL).localGet(end).i32GeU().brIf(1);
  f.localGet(h).localGet(FINISH_TAIL).i64Load8U(0).i64Const(signed(PRIME64_5)).i64Mul().i64Xor();
  f.i64Const(ROTATE_TAIL_1).i64Rotl().i64Const(signed(PRIME64_1)).i64Mul().localSet(h);
  f.localGet(FINISH_TAIL).i32Const(1).i32Add().localSet(FINISH_TAIL);
  f.br(0).end().end();

  // avalanche: h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32
  f.localGet(h).localGet(h).i64Const(AVALANCHE_SHIFT_1).i64ShrU().i64Xor().i64Const(signed(PRIME64_2)).i64Mul().localSet(h);
  f.localGet(h).localGet(h).i64Const(AVALANCHE_SHIFT_2).i64ShrU().i64Xor().i64Const(signed(PRIME64_3)).i64Mul().localSet(h);
  f.localGet(h).localGet(h).i64Const(AVALANCHE_SHIFT_3).i64ShrU().i64Xor();
}

/** The module's bytes, assembled from the functions above. */
export function assembleXxh64(): Uint8Array<ArrayBuffer> {
  const builder = new ModuleBuilder('env', 'memory', 1);
  buildStripes(builder.addFunction('stripes', [I32, I32, I32], []));
  buildFinish(builder.addFunction('finish', [I32, I32, I32, I32, I32], [I64]));
  return builder.build();
}

interface Xxh64Exports {
  stripes(state: number, ptr: number, len: number): void;
  finish(state: number, tail: number, tailLen: number, total: number, seeded: number): bigint;
}

interface Xxh64Instance {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly exports: Xxh64Exports;
}

let instance: Xxh64Instance | null | undefined;

/** The shared kernel instance, or null when this runtime has no WebAssembly (decided once). */
function kernel(): Xxh64Instance | null {
  if (instance !== undefined) return instance;
  try {
    const bytes = assembleXxh64();
    if (typeof WebAssembly !== 'object' || !WebAssembly.validate(bytes)) {
      instance = null;
      return instance;
    }
    const pages = Math.ceil((CHUNK_PTR + CHUNK_BYTES) / BYTES_PER_PAGE);
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const created = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
    instance = { bytes: new Uint8Array(memory.buffer), view: new DataView(memory.buffer), exports: created.exports as unknown as Xxh64Exports };
  } catch {
    instance = null;
  }
  return instance;
}

/** Whether the WebAssembly hash can run here. */
export function xxh64WasmSupported(): boolean {
  return kernel() !== null;
}

/**
 * XXH64 of `data` with seed 0, or null when WebAssembly is not available or the input is longer than 4 GiB - 1 (the caller
 * then uses its own implementation). Input is copied through the kernel's memory in chunks of CHUNK_BYTES.
 */
export function xxh64Wasm(data: Uint8Array): bigint | null {
  const host = kernel();
  if (host === null || data.length > TOTAL_LENGTH_MAX) return null;
  const { bytes, view, exports } = host;
  const total = data.length;
  const seeded = total >= STRIPE_BYTES;
  if (seeded) {
    // v1 = P1 + P2, v2 = P2, v3 = 0, v4 = -P1 (modulo 2^64)
    view.setBigUint64(STATE_PTR, BigInt.asUintN(64, PRIME64_1 + PRIME64_2), true);
    view.setBigUint64(STATE_PTR + LANE_BYTES, PRIME64_2, true);
    view.setBigUint64(STATE_PTR + 2 * LANE_BYTES, 0n, true);
    view.setBigUint64(STATE_PTR + 3 * LANE_BYTES, BigInt.asUintN(64, -PRIME64_1), true);
  }
  const stripesEnd = total - (total % STRIPE_BYTES);
  for (let offset = 0; offset < stripesEnd; offset += CHUNK_BYTES) {
    const n = Math.min(CHUNK_BYTES, stripesEnd - offset);
    bytes.set(data.subarray(offset, offset + n), CHUNK_PTR);
    exports.stripes(STATE_PTR, CHUNK_PTR, n);
  }
  bytes.set(data.subarray(stripesEnd), TAIL_PTR);
  return BigInt.asUintN(64, exports.finish(STATE_PTR, TAIL_PTR, total - stripesEnd, total, seeded ? 1 : 0));
}
