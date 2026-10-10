'use strict';
// Thread code for tests/cpu-pool.test.ts: small task kinds that make pool behaviour observable. Plain CommonJS with no
// imports from src/, so that the pool is exercised against a worker it does not share code with.
const { parentPort, threadId } = require('node:worker_threads');

const handlers = {
  echo: (payload) => ({ result: { value: payload.value, threadId } }),
  spin: (payload) => {
    const end = Date.now() + payload.ms;
    let n = 0;
    while (Date.now() < end) n++;
    return { result: { threadId, spun: n > 0 } };
  },
  sum: (payload) => {
    const view = new Uint8Array(payload.bytes);
    let total = 0;
    for (let i = 0; i < view.length; i++) total += view[i];
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, total);
    return { result: out, transfer: [out.buffer] };
  },
  typedFailure: (payload) => {
    const error = new Error(payload.message);
    error.name = payload.name;
    throw error;
  },
  exit: () => {
    process.exit(3);
  },
};

parentPort.on('message', (message) => {
  const handler = handlers[message.kind];
  if (!handler) {
    parentPort.postMessage({ id: message.id, ok: false, error: { name: 'ConversionFailedError', message: 'unknown kind ' + message.kind } });
    return;
  }
  try {
    const { result, transfer } = handler(message.payload);
    parentPort.postMessage({ id: message.id, ok: true, result }, transfer || []);
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: { name: error.name, message: error.message } });
  }
});
