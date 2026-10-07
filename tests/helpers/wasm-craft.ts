/**
 * A tiny WebAssembly binary assembler for tests (WebAssembly core spec 1.0, binary format chapter 5): it writes
 * the type, import, function, memory, export and code sections for modules of the shapes the custom Wasm task
 * ABI talks about. It imports nothing from src, and the modules it writes are checked by the engine's own
 * WebAssembly.validate in the tests that use them.
 */

const I32 = 0x7f;
const SECTION = { type: 1, import: 2, function: 3, memory: 5, export: 7, code: 10, custom: 0 } as const;

export const OP = {
  block: 0x02,
  loop: 0x03,
  br: 0x0c,
  brIf: 0x0d,
  end: 0x0b,
  localGet: 0x20,
  localSet: 0x21,
  i32Load8U: 0x2d,
  i32Store8: 0x3a,
  drop: 0x1a,
  memoryGrow: 0x40,
  i32Const: 0x41,
  i32Eqz: 0x45,
  i32GeU: 0x4f,
  i32Add: 0x6a,
  i32ShrU: 0x76,
} as const;

function uleb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

function sleb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    const done = (rest === 0 && (byte & 0x40) === 0) || (rest === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

/** `i32.const value` as instruction bytes. */
export function i32Const(value: number): number[] {
  return [OP.i32Const, ...sleb(value)];
}

function name(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

function vector(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

export interface CraftedModule {
  /** Body of `alloc(len: i32) -> i32` (instructions without locals or the final end), or null to leave it out. */
  alloc: number[] | null;
  /** Body of `transform(ptr: i32, len: i32) -> i32`, with one extra i32 local at index 2, or null to leave it out. */
  transform: number[] | null;
  /** Pages of linear memory; null leaves the memory out. */
  memoryPages: number | null;
  /** Names the exports use. */
  names?: { memory?: string; alloc?: string; transform?: string };
  /** An import of `env.f: () -> ()`, which the ABI forbids. */
  importsHostFunction?: boolean;
  /** Extra bytes written as a custom section (to make the module large). */
  paddingBytes?: number;
}

function funcBody(code: number[]): number[] {
  const body = [...vector([[1, I32]]), ...code, OP.end];
  return [...uleb(body.length), ...body];
}

/** The bytes of a module with `alloc`, `transform` and `memory` exports as described. */
export function craftModule(spec: CraftedModule): Uint8Array {
  const names = { memory: 'memory', alloc: 'alloc', transform: 'transform', ...spec.names };
  const bodies: Array<{ code: number[]; type: number; export: string }> = [];
  if (spec.alloc) bodies.push({ code: spec.alloc, type: 0, export: names.alloc });
  if (spec.transform) bodies.push({ code: spec.transform, type: 1, export: names.transform });
  const importCount = spec.importsHostFunction ? 1 : 0;

  const types = vector([
    [0x60, ...vector([[I32]]), ...vector([[I32]])],
    [0x60, ...vector([[I32], [I32]]), ...vector([[I32]])],
    [0x60, 0x00, 0x00],
  ]);
  const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...section(SECTION.type, types)];
  if (spec.importsHostFunction) {
    out.push(...section(SECTION.import, vector([[...name('env'), ...name('f'), 0x00, 2]])));
  }
  out.push(...section(SECTION.function, vector(bodies.map((b) => [b.type]))));
  if (spec.memoryPages !== null) out.push(...section(SECTION.memory, vector([[0x00, ...uleb(spec.memoryPages)]])));
  const exports: number[][] = [];
  if (spec.memoryPages !== null) exports.push([...name(names.memory), 0x02, 0x00]);
  bodies.forEach((b, i) => exports.push([...name(b.export), 0x00, ...uleb(importCount + i)]));
  out.push(...section(SECTION.export, vector(exports)));
  out.push(...section(SECTION.code, vector(bodies.map((b) => funcBody(b.code)))));
  const assembled = Uint8Array.from(out);
  if (!spec.paddingBytes) return assembled;
  // A custom section of zeros, appended without spreading millions of values into a call.
  const sectionBody = name('pad');
  const header = [SECTION.custom, ...uleb(sectionBody.length + spec.paddingBytes), ...sectionBody];
  const padded = new Uint8Array(assembled.length + header.length + spec.paddingBytes);
  padded.set(assembled, 0);
  padded.set(header, assembled.length);
  return padded;
}

/** `alloc` that returns a fixed address. */
export function allocAt(address: number): number[] {
  return i32Const(address);
}

/** Function body that adds `delta` to each byte of [ptr, ptr + len) and returns `len`. */
export function addToEachByte(delta: number, returns: number[] = [OP.localGet, 1]): number[] {
  const at = [OP.localGet, 0, OP.localGet, 2, OP.i32Add];
  return [
    OP.block,
    0x40,
    OP.loop,
    0x40,
    OP.localGet,
    2,
    OP.localGet,
    1,
    OP.i32GeU,
    OP.brIf,
    1,
    ...at,
    ...at,
    OP.i32Load8U,
    0,
    0,
    ...i32Const(delta),
    OP.i32Add,
    OP.i32Store8,
    0,
    0,
    OP.localGet,
    2,
    ...i32Const(1),
    OP.i32Add,
    OP.localSet,
    2,
    OP.br,
    0,
    OP.end,
    OP.end,
    ...returns,
  ];
}

/** `memory.grow(pages)` as instruction bytes, leaving the previous size (or -1) on the stack. */
export function growMemory(pages: number): number[] {
  return [...i32Const(pages), OP.memoryGrow, 0x00];
}
