import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { setFlagsFromString } from 'node:v8';

// (module (import "env" "f" (func (param i32) (result i32))) (func (export "run") (param i32) (local i32) loop: call f; i++; br_if i<n))
const WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x0a, 0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x01, 0x7f, 0x00,
  0x02, 0x09, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x01,
  0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01,
  0x0a, 0x1c, 0x01, 0x1a, 0x01, 0x01, 0x7f,
  0x03, 0x40, 0x20, 0x01, 0x10, 0x00, 0x1a, 0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01, 0x20, 0x01, 0x20, 0x00, 0x49, 0x0d, 0x00, 0x0b, 0x0b,
]);
const IMPORTS = [(a) => a, (a, b) => a, () => 1, (a, b, c) => a, function f(a) { return a + 1; }];

function runModule(round) {
  const f = IMPORTS[round % IMPORTS.length];
  const instance = new WebAssembly.Instance(new WebAssembly.Module(WASM), { env: { f } });
  instance.exports.run(3000);
}

if (!isMainThread) {
  for (let round = workerData.seed; ; round++) {
    runModule(round);
    if (round % 4 === 0) parentPort.postMessage('tick');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const [threads = '4', seconds = '30', toggle] = process.argv.slice(2);
if (toggle === 'toggle') {
  let on = false;
  setInterval(() => {
    on = !on;
    setFlagsFromString(on ? '--initial-old-space-size=128' : '--initial-old-space-size=0');
  }, 1).unref();
}
const end = Date.now() + Number(seconds) * 1000;
let started = 0;
async function lane() {
  while (Date.now() < end) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { seed: started++ } });
    await new Promise((resolve) => worker.once('message', resolve));
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
    await worker.terminate();
    runModule(started);
  }
}
await Promise.all(Array.from({ length: Number(threads) }, lane));
console.log(`wrapper churn ok: ${started} threads`);
