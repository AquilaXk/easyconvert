/**
 * Child process of tests/wasm-import-wrappers.test.ts: makes a WebAssembly instance whose JavaScript import is called far past
 * V8's tier-up budget (1,000 calls). The test runs it with --trace-wasm-compilation-times, which prints a "WasmToJS wrapper"
 * line when V8 compiles a wrapper for the import. With the argument "without-flag" the conversion index, which sets the budget, is
 * not loaded.
 */
if (process.argv[2] !== 'without-flag') await import('../../src/lib/conversions/index');

// (module
//   (type (func (param i32) (result i32)))
//   (type (func (param i32)))
//   (import "env" "f" (func (type 0)))
//   (func (type 1) (local i32)
//     (loop (drop (call 0 (local.get 1)))
//           (local.set 1 (i32.add (local.get 1) (i32.const 1)))
//           (br_if 0 (i32.lt_u (local.get 1) (local.get 0)))))
//   (export "run" (func 1)))
const MODULE_BYTES = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x0a, 0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x01, 0x7f, 0x00, 0x02, 0x09,
  0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00, 0x03, 0x02, 0x01, 0x01, 0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01,
  0x0a, 0x1c, 0x01, 0x1a, 0x01, 0x01, 0x7f, 0x03, 0x40, 0x20, 0x01, 0x10, 0x00, 0x1a, 0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01, 0x20,
  0x01, 0x20, 0x00, 0x49, 0x0d, 0x00, 0x0b, 0x0b,
]);
const CALLS = 20_000;

const wasmModule = new WebAssembly.Module(MODULE_BYTES);
const instance = new WebAssembly.Instance(wasmModule, { env: { f: (value: number): number => value } });
(instance.exports as { run: (calls: number) => void }).run(CALLS);
process.exit(0);
