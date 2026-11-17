import { availableCpus } from './available-cpus';

/**
 * Cooperative CPU thread-token broker across concurrent conversion slots in one process.
 *
 * Reference:
 * - `imgproxy/imgproxy` (`vips/vips.go:84`, `workers/workers.go:30-56`, Apache-2.0): when several worker slots run
 *   concurrently inside a container, letting every slot spawn `availableCpus()` encoder threads produces `W * T`
 *   runnable threads and heavy CFS quota throttling; contended slots must fall back to single-thread execution while
 *   an uncontended slot may still lease the full core budget.
 *
 * Lease rules:
 * - Never blocks or deadlocks: every caller immediately receives at least 1 thread.
 * - When no other lease is active (`activeCount === 0`), the caller receives its full `desired` count (preserving
 *   exact single-job encoder behaviour such as x264's `floor(cores * 1.5)` frame/lookahead threads) while claiming at
 *   most `capacity` core tokens from the pool.
 * - When one or more leases are already active, the caller receives `max(1, min(desired, capacity - claimedTokens))`
 *   and claims `min(capacity - claimedTokens, granted)` tokens until `release()`.
 */

export interface CpuThreadLease {
  readonly threads: number;
  release(): void;
}

export class CpuThreadBudget {
  private claimedTokens = 0;
  private activeLeases = 0;

  constructor(private readonly readCapacity: () => number = () => availableCpus()) {}

  get capacity(): number {
    return Math.max(1, Math.floor(this.readCapacity()));
  }

  get stats(): { capacity: number; claimedTokens: number; activeLeases: number } {
    return {
      capacity: this.capacity,
      claimedTokens: this.claimedTokens,
      activeLeases: this.activeLeases,
    };
  }

  acquire(desired: number): CpuThreadLease {
    const requested = Number.isFinite(desired) ? Math.max(1, Math.floor(desired)) : 1;
    const total = this.capacity;
    let granted: number;
    let claimed: number;

    if (this.activeLeases === 0) {
      granted = requested;
      claimed = Math.min(total, granted);
    } else {
      const free = Math.max(0, total - this.claimedTokens);
      granted = Math.max(1, Math.min(requested, free));
      claimed = Math.min(free, granted);
    }

    this.activeLeases += 1;
    this.claimedTokens += claimed;

    let released = false;
    return {
      threads: granted,
      release: () => {
        if (released) return;
        released = true;
        this.activeLeases = Math.max(0, this.activeLeases - 1);
        this.claimedTokens = Math.max(0, this.claimedTokens - claimed);
      },
    };
  }

  async run<T>(desired: number, task: (threads: number) => Promise<T>): Promise<T> {
    const lease = this.acquire(desired);
    try {
      return await task(lease.threads);
    } finally {
      lease.release();
    }
  }
}

export const sharedCpuThreadBudget = new CpuThreadBudget();

export function withCpuThreadBudget<T>(desired: number, task: (threads: number) => Promise<T>): Promise<T> {
  return sharedCpuThreadBudget.run(desired, task);
}
