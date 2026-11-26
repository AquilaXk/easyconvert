/**
 * Returns true only when executing inside a dedicated browser Web Worker (or a test Worker global mock),
 * avoiding undefined-window checks which Next.js SWC folds to `false` in client bundles.
 */
export function isDedicatedWorkerScope(): boolean {
  const workerGlobalScope = (globalThis as { WorkerGlobalScope?: abstract new (...args: never[]) => unknown })
    .WorkerGlobalScope;
  const workerWindow = (globalThis as { window?: unknown }).window;
  return (
    typeof self !== 'undefined' &&
    typeof (self as { postMessage?: unknown }).postMessage === 'function' &&
    (typeof workerGlobalScope === 'function' ? self instanceof workerGlobalScope : workerWindow == null)
  );
}
