/** What a task finding the queue full is refused with: the bound on the tasks that wait, and the error that tells the caller. */
export interface SemaphoreQueue {
  readonly maxQueued: number;
  readonly onSaturated: () => Error;
}

/**
 * Bounds how many tasks run at once. A task that finds every slot taken waits in order for one; with a `queue` the tasks that wait
 * are bounded as well, and one past the bound is refused with the error the queue names.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly queue?: SemaphoreQueue
  ) {}

  /** Runs `task` once a slot is free. A `signal` that aborts ends the wait with its reason, and the task never starts. */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.limit) {
      if (this.queue && this.waiting.length >= this.queue.maxQueued) throw this.queue.onSaturated();
      // The slot is handed over directly, so `active` stays counted across the hand-off.
      await this.handedOver(signal);
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  /** Resolves when a finishing task hands its slot over; a task whose signal aborts leaves the queue, so no slot is handed to it. */
  private handedOver(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const take = () => {
        signal?.removeEventListener('abort', leave);
        resolve();
      };
      const leave = () => {
        const position = this.waiting.indexOf(take);
        if (position >= 0) this.waiting.splice(position, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', leave, { once: true });
      this.waiting.push(take);
    });
  }
}
