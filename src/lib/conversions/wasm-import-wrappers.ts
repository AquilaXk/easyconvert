import { setFlagsFromString } from 'node:v8';

/**
 * Keeps WebAssembly calls into JavaScript imports on V8's generic wrapper, so tier-up adds no wrapper to the cache that the
 * threads of a process share (Node.js 24's V8 frees such a wrapper twice). It must be the first import of every module that
 * converts, because V8 reads the budget when an instance is made. The mechanism, the cost for JavaScript-to-WebAssembly calls
 * and the evidence are in docs/policy-decisions.md, entry 115.
 *
 * Remove this module and its test when the runtime's V8 has V8 commit 9b8ca54d5a (V8 13.7).
 */
setFlagsFromString('--wasm-wrapper-tiering-budget=2147483647');
