/**
 * Cooperative Event Loop Utilities for High-Throughput Node.js Worker Daemons.
 * Prevents CPU-intensive conversion algorithms (e.g. Bayer CFA demosaicing,
 * CAD triangulation, or PDF rendering) from starving BullMQ job heartbeats,
 * WebSocket events, and container healthcheck endpoints.
 */

/**
 * Yields execution back to the libuv event loop via setImmediate.
 * Allows pending I/O, timer callbacks, and HTTP server requests to execute.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Measures current event loop lag in milliseconds.
 */
export function measureEventLoopLag(): Promise<number> {
  const start = performance.now();
  return new Promise((resolve) => {
    setImmediate(() => {
      const lag = performance.now() - start;
      resolve(Math.max(0, lag));
    });
  });
}

/**
 * Iterates through a collection cooperatively, yielding control to the event loop
 * after every `batchSize` iterations to ensure responsive background operations.
 */
export async function forEachCooperative<T>(
  items: readonly T[],
  batchSize: number,
  callback: (item: T, index: number) => Promise<void> | void
): Promise<void> {
  const effectiveBatchSize = Math.max(1, batchSize);
  for (let i = 0; i < items.length; i++) {
    await callback(items[i], i);
    if ((i + 1) % effectiveBatchSize === 0 && i + 1 < items.length) {
      await yieldToEventLoop();
    }
  }
}

export interface EventLoopMonitorOptions {
  checkIntervalMs?: number;
  lagThresholdMs?: number;
  onLagExceeded?: (lagMs: number) => void;
}

/**
 * Lightweight background monitor that detects event loop starvation and high lag.
 */
export class EventLoopMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly checkIntervalMs: number;
  private readonly lagThresholdMs: number;
  private readonly onLagExceeded?: (lagMs: number) => void;
  private isRunning = false;
  private lastLagMs = 0;

  constructor(options: EventLoopMonitorOptions = {}) {
    this.checkIntervalMs = options.checkIntervalMs ?? 1000;
    this.lagThresholdMs = options.lagThresholdMs ?? 100;
    this.onLagExceeded = options.onLagExceeded;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    let expectedTime = Date.now() + this.checkIntervalMs;
    this.timer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - expectedTime);
      this.lastLagMs = lag;
      expectedTime = now + this.checkIntervalMs;

      if (lag >= this.lagThresholdMs && this.onLagExceeded) {
        this.onLagExceeded(lag);
      }
    }, this.checkIntervalMs);

    // Prevent timer from keeping the Node process alive if unref is available
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  public getLastLagMs(): number {
    return this.lastLagMs;
  }

  public getActive(): boolean {
    return this.isRunning;
  }
}
