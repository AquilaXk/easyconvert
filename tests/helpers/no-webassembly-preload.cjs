/**
 * Preloaded (`node -r`) into the child processes of the "runtime without WebAssembly" tests, ahead of any other module,
 * so that `WebAssembly` does not exist for the code under test. It replaces the `--no-expose-wasm` flag, which newer V8
 * versions (Node.js 24.21 and later) no longer accept.
 */
delete globalThis.WebAssembly;
if (typeof WebAssembly !== 'undefined') throw new Error('WebAssembly could not be removed from the global object');
