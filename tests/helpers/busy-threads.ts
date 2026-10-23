import os from 'node:os';
import { Worker } from 'node:worker_threads';

const SPIN = 'for (;;) {}';

/** Starts one thread per core that does nothing but compute, so the work under test shares the machine with a loaded host. The caller stops them with the returned function. */
export function startBusyThreads(count = os.availableParallelism()): () => Promise<void> {
  const threads = Array.from({ length: count }, () => new Worker(SPIN, { eval: true }));
  return async () => {
    await Promise.all(threads.map((thread) => thread.terminate()));
  };
}
