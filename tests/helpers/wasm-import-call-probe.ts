/**
 * Child process of tests/wasm-import-wrappers.test.ts: loads the conversion dispatcher, the module every conversion route
 * loads, then prints how much cheaper a WebAssembly call into a JavaScript import is on an instance that has made 20,000 such
 * calls than on new instances that have made fewer than V8's tier-up budget (1,000 calls). V8 tiers an import that is called
 * past the budget up from its generic wrapper to a compiled one, about five times cheaper a call; the generic wrapper costs
 * the same before and after. One line of JSON: the five ratios, steady cost over fresh cost, sorted.
 */
import '../../src/lib/conversions/dispatch';

// (module (import "env" "f" (func (param i32) (result i32)))
//   (func (export "run") (param $n i32) (local $i i32) (loop (drop (call 0 (local.get $i))) ... (br_if 0 (i32.lt_u $i $n)))))
const MODULE_BYTES = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x0a, 0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x01, 0x7f, 0x00, 0x02, 0x09,
  0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00, 0x03, 0x02, 0x01, 0x01, 0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01,
  0x0a, 0x1c, 0x01, 0x1a, 0x01, 0x01, 0x7f, 0x03, 0x40, 0x20, 0x01, 0x10, 0x00, 0x1a, 0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01, 0x20,
  0x01, 0x20, 0x00, 0x49, 0x0d, 0x00, 0x0b, 0x0b,
]);
const CALLS_UNDER_BUDGET = 900;
const INSTANCES = 400;
const WARM_CALLS = 20_000;
const SAMPLES = 5;

const module = new WebAssembly.Module(MODULE_BYTES);
const identity = (value: number): number => value;
const newRun = (): ((calls: number) => void) =>
  (new WebAssembly.Instance(module, { env: { f: identity } }).exports as { run: (calls: number) => void }).run;

function nsPerCall(started: number, calls: number): number {
  return ((performance.now() - started) * 1e6) / calls;
}

function freshCost(): number {
  const runs = Array.from({ length: INSTANCES }, newRun);
  const started = performance.now();
  for (const run of runs) run(CALLS_UNDER_BUDGET);
  return nsPerCall(started, INSTANCES * CALLS_UNDER_BUDGET);
}

function steadyCost(): number {
  const run = newRun();
  run(WARM_CALLS);
  const started = performance.now();
  run(INSTANCES * CALLS_UNDER_BUDGET);
  return nsPerCall(started, INSTANCES * CALLS_UNDER_BUDGET);
}

const ratios = Array.from({ length: SAMPLES }, () => steadyCost() / freshCost()).sort((a, b) => a - b);
console.log(JSON.stringify(ratios));
process.exit(0);
