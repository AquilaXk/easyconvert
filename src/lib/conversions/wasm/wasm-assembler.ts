/**
 * A minimal WebAssembly binary assembler (WebAssembly core specification 2.0, binary format; fixed-width SIMD proposal
 * as merged into it). It emits the bytes of a module from instructions written in TypeScript, so a kernel is built from
 * source in this repository at run time and no prebuilt binary is shipped. The assembler knows only what the kernels
 * use: i32/i64/f64/v128 values, one imported memory, exported functions and structured control flow.
 */

export const VALUE_TYPE = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  v128: 0x7b,
} as const;

export type ValueType = (typeof VALUE_TYPE)[keyof typeof VALUE_TYPE];

const MAGIC_AND_VERSION = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_FUNCTION = 3;
const SECTION_EXPORT = 7;
const SECTION_CODE = 10;
const FUNCTION_TYPE_TAG = 0x60;
const IMPORT_KIND_MEMORY = 0x02;
const EXPORT_KIND_FUNCTION = 0x00;
const LIMITS_MIN_ONLY = 0x00;
const BLOCK_TYPE_EMPTY = 0x40;
const OP_END = 0x0b;
const SIMD_PREFIX = 0xfd;
const LEB_PAYLOAD_BITS = 7;
const LEB_PAYLOAD_MASK = 0x7f;
const LEB_CONTINUE = 0x80;
const LEB_SIGN_BIT = 0x40;
const UINT32_MAX = 0xffffffff;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;
const MAX_NAME_BYTES = 255;

/** Appends the unsigned LEB128 form of `value` (a uint32). */
export function pushU32(bytes: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) throw new RangeError(`u32 out of range: ${value}`);
  let rest = value;
  do {
    let byte = rest % (LEB_CONTINUE as number);
    rest = Math.floor(rest / LEB_CONTINUE);
    if (rest !== 0) byte |= LEB_CONTINUE;
    bytes.push(byte);
  } while (rest !== 0);
}

/** Appends the signed LEB128 form of `value` (an int32). */
export function pushS32(bytes: number[], value: number): void {
  if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) throw new RangeError(`i32 out of range: ${value}`);
  let rest = value;
  for (;;) {
    const byte = rest & LEB_PAYLOAD_MASK;
    rest >>= LEB_PAYLOAD_BITS;
    const done = (rest === 0 && (byte & LEB_SIGN_BIT) === 0) || (rest === -1 && (byte & LEB_SIGN_BIT) !== 0);
    bytes.push(done ? byte : byte | LEB_CONTINUE);
    if (done) return;
  }
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const LEB_PAYLOAD_MASK_BIG = 0x7fn;
const LEB_PAYLOAD_BITS_BIG = 7n;
const LEB_SIGN_BIT_BIG = 0x40n;

/** Appends the signed LEB128 form of `value` (an int64). */
export function pushS64(bytes: number[], value: bigint): void {
  if (value < INT64_MIN || value > INT64_MAX) throw new RangeError(`i64 out of range: ${value}`);
  let rest = value;
  for (;;) {
    const byte = rest & LEB_PAYLOAD_MASK_BIG;
    rest >>= LEB_PAYLOAD_BITS_BIG;
    const done = (rest === 0n && (byte & LEB_SIGN_BIT_BIG) === 0n) || (rest === -1n && (byte & LEB_SIGN_BIT_BIG) !== 0n);
    bytes.push(Number(done ? byte : byte | BigInt(LEB_CONTINUE)));
    if (done) return;
  }
}

/** UTF-8 encoder shared by every name; available in browsers and Node alike, so the edge tier can assemble too. */
const UTF8 = new TextEncoder();

function pushName(bytes: number[], name: string): void {
  const encoded = UTF8.encode(name);
  if (encoded.length > MAX_NAME_BYTES) throw new RangeError('name too long');
  pushU32(bytes, encoded.length);
  for (const byte of encoded) bytes.push(byte);
}

function pushVector(bytes: number[], items: number[][]): void {
  pushU32(bytes, items.length);
  for (const item of items) for (const byte of item) bytes.push(byte);
}

function section(id: number, body: number[]): number[] {
  const out: number[] = [id];
  pushU32(out, body.length);
  for (const byte of body) out.push(byte);
  return out;
}

/** Opcodes by name; the mnemonics follow the specification's text format. */
const OPCODE = {
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  br: 0x0c,
  br_if: 0x0d,
  return: 0x0f,
  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  i32_load: 0x28,
  f64_load: 0x2b,
  i32_store: 0x36,
  f64_store: 0x39,
  i32_const: 0x41,
  f64_const: 0x44,
  i32_eqz: 0x45,
  i64_load: 0x29,
  i64_load8_u: 0x31,
  i64_load32_u: 0x35,
  i64_const: 0x42,
  i64_store: 0x37,
  i32_eq: 0x46,
  i32_lt_s: 0x48,
  i32_gt_s: 0x4a,
  i32_le_s: 0x4c,
  i32_lt_u: 0x49,
  i32_gt_u: 0x4b,
  i32_le_u: 0x4d,
  i32_ge_s: 0x4e,
  i32_ge_u: 0x4f,
  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_mul: 0x6c,
  i32_shl: 0x74,
  i32_shr_s: 0x75,
  i32_and: 0x71,
  i64_add: 0x7c,
  i64_mul: 0x7e,
  i64_xor: 0x85,
  i64_shr_u: 0x88,
  i64_rotl: 0x89,
  i32_wrap_i64: 0xa7,
  i64_extend_i32_u: 0xad,
  f64_add: 0xa0,
  f64_mul: 0xa2,
} as const;

/** SIMD opcodes (after the 0xFD prefix). */
const SIMD_OPCODE = {
  v128_load: 0x00,
  v128_store: 0x0b,
  v128_const: 0x0c,
  f64x2_splat: 0x14,
  f64x2_extract_lane: 0x21,
  f64x2_add: 0xf0,
  f64x2_mul: 0xf2,
  f32x4_splat: 0x13,
  f32x4_extract_lane: 0x1f,
  f32x4_add: 0xe4,
  f32x4_mul: 0xe6,
} as const;

/** Instruction emitter of one function body. Methods append to `code` and return `this` for chaining. */
export class FunctionBody {
  readonly code: number[] = [];
  private readonly localTypes: ValueType[] = [];

  constructor(
    readonly params: readonly ValueType[],
    readonly results: readonly ValueType[]
  ) {}

  /** Declares a local variable and returns its index (parameters come first). */
  addLocal(type: ValueType): number {
    this.localTypes.push(type);
    return this.params.length + this.localTypes.length - 1;
  }

  private op(opcode: number): this {
    this.code.push(opcode);
    return this;
  }

  private simd(opcode: number): this {
    this.code.push(SIMD_PREFIX);
    pushU32(this.code, opcode);
    return this;
  }

  private memarg(opcodeBytes: () => void, align: number, offset: number): this {
    opcodeBytes();
    pushU32(this.code, align);
    pushU32(this.code, offset);
    return this;
  }

  // Control.
  block(): this {
    this.op(OPCODE.block).code.push(BLOCK_TYPE_EMPTY);
    return this;
  }
  loop(): this {
    this.op(OPCODE.loop).code.push(BLOCK_TYPE_EMPTY);
    return this;
  }
  if_(): this {
    this.op(OPCODE.if).code.push(BLOCK_TYPE_EMPTY);
    return this;
  }
  else_(): this {
    return this.op(OPCODE.else);
  }
  end(): this {
    return this.op(OP_END);
  }
  br(depth: number): this {
    this.op(OPCODE.br);
    pushU32(this.code, depth);
    return this;
  }
  brIf(depth: number): this {
    this.op(OPCODE.br_if);
    pushU32(this.code, depth);
    return this;
  }

  // Variables.
  localGet(index: number): this {
    this.op(OPCODE.local_get);
    pushU32(this.code, index);
    return this;
  }
  localSet(index: number): this {
    this.op(OPCODE.local_set);
    pushU32(this.code, index);
    return this;
  }
  localTee(index: number): this {
    this.op(OPCODE.local_tee);
    pushU32(this.code, index);
    return this;
  }

  // i32.
  i32Const(value: number): this {
    this.op(OPCODE.i32_const);
    pushS32(this.code, value);
    return this;
  }
  i32Add(): this {
    return this.op(OPCODE.i32_add);
  }
  i32Sub(): this {
    return this.op(OPCODE.i32_sub);
  }
  i32Mul(): this {
    return this.op(OPCODE.i32_mul);
  }
  i32Shl(): this {
    return this.op(OPCODE.i32_shl);
  }
  i32ShrS(): this {
    return this.op(OPCODE.i32_shr_s);
  }
  i32Eqz(): this {
    return this.op(OPCODE.i32_eqz);
  }
  i32LtS(): this {
    return this.op(OPCODE.i32_lt_s);
  }
  i32GtS(): this {
    return this.op(OPCODE.i32_gt_s);
  }
  i32LeS(): this {
    return this.op(OPCODE.i32_le_s);
  }
  i32GeS(): this {
    return this.op(OPCODE.i32_ge_s);
  }
  i32Eq(): this {
    return this.op(OPCODE.i32_eq);
  }
  i32And(): this {
    return this.op(OPCODE.i32_and);
  }
  i32LtU(): this {
    return this.op(OPCODE.i32_lt_u);
  }
  i32GtU(): this {
    return this.op(OPCODE.i32_gt_u);
  }
  i32LeU(): this {
    return this.op(OPCODE.i32_le_u);
  }
  i32GeU(): this {
    return this.op(OPCODE.i32_ge_u);
  }
  i32WrapI64(): this {
    return this.op(OPCODE.i32_wrap_i64);
  }

  // i64.
  i64Const(value: bigint): this {
    this.op(OPCODE.i64_const);
    pushS64(this.code, value);
    return this;
  }
  i64Add(): this {
    return this.op(OPCODE.i64_add);
  }
  i64Mul(): this {
    return this.op(OPCODE.i64_mul);
  }
  i64Xor(): this {
    return this.op(OPCODE.i64_xor);
  }
  i64ShrU(): this {
    return this.op(OPCODE.i64_shr_u);
  }
  i64Rotl(): this {
    return this.op(OPCODE.i64_rotl);
  }
  i64ExtendI32U(): this {
    return this.op(OPCODE.i64_extend_i32_u);
  }
  i64Load(offset = 0): this {
    return this.memarg(() => this.op(OPCODE.i64_load), 0, offset);
  }
  i64Load32U(offset = 0): this {
    return this.memarg(() => this.op(OPCODE.i64_load32_u), 0, offset);
  }
  i64Load8U(offset = 0): this {
    return this.memarg(() => this.op(OPCODE.i64_load8_u), 0, offset);
  }
  i64Store(offset = 0): this {
    return this.memarg(() => this.op(OPCODE.i64_store), 0, offset);
  }

  i32Load(offset = 0): this {
    return this.memarg(() => this.op(OPCODE.i32_load), 0, offset);
  }
  i32Store(offset = 0): this {
    return this.memarg(() => this.op(OPCODE.i32_store), 0, offset);
  }

  // f64.
  f64Load(offset = 0): this {
    return this.memarg(() => this.op(OPCODE.f64_load), 0, offset);
  }
  f64Store(offset = 0): this {
    return this.memarg(() => this.op(OPCODE.f64_store), 0, offset);
  }
  f64Add(): this {
    return this.op(OPCODE.f64_add);
  }
  f64Mul(): this {
    return this.op(OPCODE.f64_mul);
  }

  // v128 (alignment hint 0: any address works).
  v128Load(offset = 0): this {
    return this.memarg(() => this.simd(SIMD_OPCODE.v128_load), 0, offset);
  }
  v128Store(offset = 0): this {
    return this.memarg(() => this.simd(SIMD_OPCODE.v128_store), 0, offset);
  }
  v128ConstZero(): this {
    this.simd(SIMD_OPCODE.v128_const);
    for (let i = 0; i < 16; i++) this.code.push(0);
    return this;
  }
  f64x2Splat(): this {
    return this.simd(SIMD_OPCODE.f64x2_splat);
  }
  f64x2ExtractLane(lane: 0 | 1): this {
    this.simd(SIMD_OPCODE.f64x2_extract_lane);
    this.code.push(lane);
    return this;
  }
  f64x2Add(): this {
    return this.simd(SIMD_OPCODE.f64x2_add);
  }
  f64x2Mul(): this {
    return this.simd(SIMD_OPCODE.f64x2_mul);
  }
  f32x4Splat(): this {
    return this.simd(SIMD_OPCODE.f32x4_splat);
  }
  f32x4ExtractLane(lane: 0 | 1 | 2 | 3): this {
    this.simd(SIMD_OPCODE.f32x4_extract_lane);
    this.code.push(lane);
    return this;
  }
  f32x4Add(): this {
    return this.simd(SIMD_OPCODE.f32x4_add);
  }
  f32x4Mul(): this {
    return this.simd(SIMD_OPCODE.f32x4_mul);
  }

  /** The encoded body: local declarations, then the instructions and the closing `end`. */
  encode(): number[] {
    const body: number[] = [];
    // One local group per run of equal types.
    const groups: Array<[number, ValueType]> = [];
    for (const type of this.localTypes) {
      const last = groups[groups.length - 1];
      if (last !== undefined && last[1] === type) last[0]++;
      else groups.push([1, type]);
    }
    pushU32(body, groups.length);
    for (const [count, type] of groups) {
      pushU32(body, count);
      body.push(type);
    }
    for (const byte of this.code) body.push(byte);
    body.push(OP_END);
    const sized: number[] = [];
    pushU32(sized, body.length);
    for (const byte of body) sized.push(byte);
    return sized;
  }
}

interface ExportedFunction {
  name: string;
  body: FunctionBody;
}

/** A module that imports one memory and exports functions. */
export class ModuleBuilder {
  private readonly functions: ExportedFunction[] = [];

  constructor(
    private readonly memoryModule = 'env',
    private readonly memoryName = 'memory',
    private readonly memoryMinPages = 1
  ) {}

  /** Adds an exported function and returns its body for the caller to fill. */
  addFunction(name: string, params: readonly ValueType[], results: readonly ValueType[]): FunctionBody {
    const body = new FunctionBody(params, results);
    this.functions.push({ name, body });
    return body;
  }

  build(): Uint8Array<ArrayBuffer> {
    const types: number[][] = this.functions.map(({ body }) => {
      const type: number[] = [FUNCTION_TYPE_TAG];
      pushU32(type, body.params.length);
      for (const param of body.params) type.push(param);
      pushU32(type, body.results.length);
      for (const result of body.results) type.push(result);
      return type;
    });
    const typeBody: number[] = [];
    pushVector(typeBody, types);

    const importEntry: number[] = [];
    pushName(importEntry, this.memoryModule);
    pushName(importEntry, this.memoryName);
    importEntry.push(IMPORT_KIND_MEMORY, LIMITS_MIN_ONLY);
    pushU32(importEntry, this.memoryMinPages);
    const importBody: number[] = [];
    pushVector(importBody, [importEntry]);

    const functionBody: number[] = [];
    pushVector(
      functionBody,
      this.functions.map((_, index) => {
        const entry: number[] = [];
        pushU32(entry, index);
        return entry;
      })
    );

    const exportBody: number[] = [];
    pushVector(
      exportBody,
      this.functions.map(({ name }, index) => {
        const entry: number[] = [];
        pushName(entry, name);
        entry.push(EXPORT_KIND_FUNCTION);
        pushU32(entry, index);
        return entry;
      })
    );

    const codeBody: number[] = [];
    pushVector(
      codeBody,
      this.functions.map(({ body }) => body.encode())
    );

    return Uint8Array.from([
      ...MAGIC_AND_VERSION,
      ...section(SECTION_TYPE, typeBody),
      ...section(SECTION_IMPORT, importBody),
      ...section(SECTION_FUNCTION, functionBody),
      ...section(SECTION_EXPORT, exportBody),
      ...section(SECTION_CODE, codeBody),
    ]);
  }
}
