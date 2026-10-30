import { setFlagsFromString } from 'node:v8';

/**
 * Keeps every WebAssembly call into a JavaScript import on V8's generic wrapper. Import it before any module that
 * instantiates WebAssembly: V8 reads the budget when an instance is made.
 *
 * Past the budget (1,000 calls) V8 compiles a wrapper for the import into a cache shared by every thread of the process.
 * V8 13.6, the one in Node.js 24, adds a wrapper to the caller's code scope before it checks that the wrapper is dying, so a
 * wrapper that wasm code GC is freeing on one thread is freed a second time when the scope of a tier-up on another thread
 * ends (V8 commit 9b8ca54d5a, "Fix lookup of wrappers marked is_dying", first in V8 13.7). The pdf.js decoders and
 * tesseract.js run WebAssembly on threads of their own and HarfBuzz on the main thread, and a job server died with SIGSEGV or
 * a V8 fatal error in `Runtime_TierUpWasmToJSWrapper`. With a budget no instance reaches, no JavaScript import gets a
 * compiled wrapper in that cache.
 *
 * Remove this module when the runtime's V8 has that commit.
 */
setFlagsFromString('--wasm-wrapper-tiering-budget=2147483647');
