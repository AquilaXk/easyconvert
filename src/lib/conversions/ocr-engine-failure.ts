/**
 * Which failures of the WebAssembly OCR engine the native tool may take over, and how the others are reported.
 *
 * Only these classes are recoverable, because each says the WebAssembly runtime failed and not that the page or
 * the request is wrong: the same page can be read by the native engine and gives the same answer it would have.
 * Anything else (a defect in the recognition code, a result that cannot be read back, an unknown error) is not
 * answered with a second engine: it is an OcrEngineUnavailableError (503), so that a fault is seen and not hidden
 * behind a reading that merely looks fine. A fallback that does happen is recorded on the result
 * (`engineFallback`), never silent.
 */

export const OCR_WASM_RUNTIME_TRAP = 'wasm-runtime-trap';
export const OCR_WASM_OUT_OF_MEMORY = 'wasm-out-of-memory';
export const OCR_WASM_WORKER_LOST = 'wasm-worker-lost';

/** Failure classes of the WebAssembly engine that the native tool takes over. */
export const OCR_RECOVERABLE_WASM_FAILURES: ReadonlySet<string> = new Set([
  OCR_WASM_RUNTIME_TRAP,
  OCR_WASM_OUT_OF_MEMORY,
  OCR_WASM_WORKER_LOST,
]);

/** Longest part of an engine error message that is kept in an error a client sees. */
const MAX_REPORTED_MESSAGE_CHARS = 200;

const RUNTIME_TRAP = /memory access out of bounds|unreachable|divide by zero|integer overflow|indirect call|table index is out of bounds|stack overflow|Aborted\(/i;
const OUT_OF_MEMORY = /out of memory|cannot enlarge memory|failed to allocate|allocation failed/i;
const WORKER_LOST = /worker .*(terminated|exited|crashed)|(terminated|exited|crashed) .*worker/i;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : '';
}

/**
 * The recoverable class of a WebAssembly engine failure, or null when it is not one: the engine's own traps
 * (`WebAssembly.RuntimeError`), running out of memory, and a worker thread that died.
 */
export function recoverableWasmFailure(err: unknown): string | null {
  const message = messageOf(err);
  if (err instanceof WebAssembly.RuntimeError || RUNTIME_TRAP.test(message)) return OCR_WASM_RUNTIME_TRAP;
  if (OUT_OF_MEMORY.test(message) || (err instanceof RangeError && /WebAssembly/i.test(message))) return OCR_WASM_OUT_OF_MEMORY;
  if (WORKER_LOST.test(message)) return OCR_WASM_WORKER_LOST;
  return null;
}

/** What a client may be told about an engine error: one line of printable text, bounded. */
export function describeEngineError(err: unknown): string {
  const text = messageOf(err).replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? 'unknown error' : text.slice(0, MAX_REPORTED_MESSAGE_CHARS);
}
