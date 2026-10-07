/**
 * Runs the work a WebCodecs decoder hands out, one item at a time and in arrival order.
 *
 * A decoder calls its output callback without waiting for the previous call to finish. Work that awaits (encoder
 * backpressure, a canvas resize) would otherwise interleave, reorder frames and strand all but one waiter of
 * the flow controller. This queue serialises that work, caps how many decoded items wait in memory, and keeps
 * the first failure: after it, queued items are not processed but their `skip` callback still runs so the
 * frame or audio data they hold is released.
 */

export class OrderedWorkQueue {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private failed = false;
  private pendingCount = 0;
  private idleWaiters: Array<() => void> = [];

  /** Items accepted and not yet finished. */
  get pending(): number {
    return this.pendingCount;
  }

  /** Queues `work`; if an earlier item failed, runs `skip` instead. Never throws. */
  push(work: () => Promise<void>, skip: () => void): void {
    this.pendingCount++;
    this.tail = this.tail.then(async () => {
      try {
        if (this.failed) {
          skip();
        } else {
          await work();
        }
      } catch (error) {
        this.fail(error);
      } finally {
        this.pendingCount--;
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const wake of waiters) wake();
      }
    });
  }

  /** Records a failure from outside the queue, such as a decoder error callback. */
  fail(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.failure = error;
    }
  }

  throwIfFailed(): void {
    if (this.failed) throw this.failure;
  }

  /** Resolves once fewer than `limit` items are pending; throws the first failure. */
  async waitBelow(limit: number): Promise<void> {
    while (this.pendingCount >= limit) {
      this.throwIfFailed();
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
    this.throwIfFailed();
  }

  /** Resolves when every queued item has finished, whether or not one failed; use it to release held frames. */
  async settle(): Promise<void> {
    await this.tail;
  }

  /** Resolves when every queued item has finished; throws the first failure. */
  async drain(): Promise<void> {
    await this.tail;
    this.throwIfFailed();
  }
}
