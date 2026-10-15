import { describe, expect, it } from 'vitest';
import { ModuleBuilder, pushS32, pushU32, VALUE_TYPE } from '../src/lib/conversions/wasm/wasm-assembler';
import { assembleResamplerKernels } from '../src/lib/conversions/wasm/resampler-mac';

/**
 * The WebAssembly assembler against the binary format specification: LEB128 vectors from the specification and the
 * format's reference text, a module whose bytes were written out by hand from the section layout, and the runtime's own
 * validator and executor as the oracle for modules the assembler builds.
 */

function u32(value: number): number[] {
  const bytes: number[] = [];
  pushU32(bytes, value);
  return bytes;
}

function s32(value: number): number[] {
  const bytes: number[] = [];
  pushS32(bytes, value);
  return bytes;
}

describe('LEB128', () => {
  // The unsigned example of the DWARF and WebAssembly texts (624485 = 0x98765) and the boundary cases around 7-bit groups.
  it.each([
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [624485, [0xe5, 0x8e, 0x26]],
    [0xffffffff, [0xff, 0xff, 0xff, 0xff, 0x0f]],
  ])('encodes the unsigned value %i', (value, expected) => {
    expect(u32(value)).toEqual(expected);
  });

  // Signed vectors from the same texts (-123456 = C0 BB 78) and the sign-bit boundaries at 63 and -64.
  it.each([
    [0, [0x00]],
    [63, [0x3f]],
    [64, [0xc0, 0x00]],
    [-1, [0x7f]],
    [-64, [0x40]],
    [-65, [0xbf, 0x7f]],
    [-123456, [0xc0, 0xbb, 0x78]],
    [0x7fffffff, [0xff, 0xff, 0xff, 0xff, 0x07]],
    [-0x80000000, [0x80, 0x80, 0x80, 0x80, 0x78]],
  ])('encodes the signed value %i', (value, expected) => {
    expect(s32(value)).toEqual(expected);
  });

  it('rejects values outside the 32-bit range and non-integers', () => {
    const outcomes = [-1, 2 ** 32, 1.5, Number.NaN].map((value) => {
      try {
        u32(value);
        return 'accepted';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(outcomes).toEqual(['RangeError', 'RangeError', 'RangeError', 'RangeError']);
    expect(() => s32(2 ** 31)).toThrow(RangeError);
    expect(() => s32(-(2 ** 31) - 1)).toThrow(RangeError);
  });
});

describe('module layout', () => {
  it('writes exactly the bytes of the binary format for an add function over an imported memory', () => {
    const builder = new ModuleBuilder('env', 'memory', 1);
    const add = builder.addFunction('add', [VALUE_TYPE.i32, VALUE_TYPE.i32], [VALUE_TYPE.i32]);
    add.localGet(0).localGet(1).i32Add();
    const expected = Uint8Array.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
      0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, // type: (i32, i32) -> i32
      0x02, 0x0f, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x01, // import env.memory, min 1
      0x03, 0x02, 0x01, 0x00, // function 0 has type 0
      0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, // export "add" = function 0
      0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, // code: local.get 0, local.get 1, i32.add, end
    ]);
    expect(Array.from(builder.build())).toEqual(Array.from(expected));
  });

  it('builds a module the runtime validates, instantiates and runs', () => {
    const builder = new ModuleBuilder();
    // sum(n) = 0 + 1 + ... + (n - 1), a loop with a local and a conditional exit.
    const sum = builder.addFunction('sum', [VALUE_TYPE.i32], [VALUE_TYPE.i32]);
    const i = sum.addLocal(VALUE_TYPE.i32);
    const total = sum.addLocal(VALUE_TYPE.i32);
    sum.block().loop();
    sum.localGet(i).localGet(0).i32GeS().brIf(1);
    sum.localGet(total).localGet(i).i32Add().localSet(total);
    sum.localGet(i).i32Const(1).i32Add().localSet(i);
    sum.br(0).end().end();
    sum.localGet(total);
    const bytes = builder.build();
    expect(WebAssembly.validate(bytes)).toBe(true);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
    const run = instance.exports.sum as (n: number) => number;
    expect([run(0), run(1), run(10), run(1000)]).toEqual([0, 0, 45, 499500]);
  });

  it('validates the SIMD ops against the arithmetic of the runtime', () => {
    const builder = new ModuleBuilder();
    // mulAdd(a, b, c, out): out[0..1] = a[0..1] * b[0..1] + c[0..1], and returns lane 1 + lane 0 of the result.
    const f = builder.addFunction('mulAdd', [VALUE_TYPE.i32, VALUE_TYPE.i32, VALUE_TYPE.i32, VALUE_TYPE.i32], [VALUE_TYPE.f64]);
    const v = f.addLocal(VALUE_TYPE.v128);
    f.localGet(0).v128Load(0).localGet(1).v128Load(0).f64x2Mul().localGet(2).v128Load(0).f64x2Add().localSet(v);
    f.localGet(3).localGet(v).v128Store(0);
    f.localGet(v).f64x2ExtractLane(0).localGet(v).f64x2ExtractLane(1).f64Add();
    const bytes = builder.build();
    expect(WebAssembly.validate(bytes)).toBe(true);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
    const view = new Float64Array(memory.buffer);
    view.set([1.5, -2.25, 4, 0.1, 10, 20, 0, 0], 0);
    const returned = (instance.exports.mulAdd as (a: number, b: number, c: number, out: number) => number)(0, 16, 32, 48);
    // a = [1.5, -2.25], b = [4, 0.1], c = [10, 20]
    expect(Array.from(view.subarray(6, 8))).toEqual([1.5 * 4 + 10, -2.25 * 0.1 + 20]);
    expect(returned).toBe(1.5 * 4 + 10 + (-2.25 * 0.1 + 20));
  });

  it('is rejected by the validator when a byte is wrong', () => {
    const bytes = new ModuleBuilder().build();
    const truncated = bytes.slice(0, bytes.length - 1);
    const badMagic = bytes.slice();
    badMagic[1] = 0x00;
    expect([WebAssembly.validate(truncated), WebAssembly.validate(badMagic)]).toEqual([false, false]);
  });
});

describe('resampler kernel module', () => {
  it('assembles to a valid module with the two row kernels exported', () => {
    const bytes = assembleResamplerKernels();
    expect(WebAssembly.validate(bytes)).toBe(true);
    const exported = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((entry) => `${entry.name}:${entry.kind}`);
    expect(exported.sort()).toEqual(['rowMono:function', 'rowStereo:function']);
    expect(Array.from(assembleResamplerKernels())).toEqual(Array.from(bytes));
  });
});
