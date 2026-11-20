/**
 * Measures how long a piece of work holds the event loop of this thread: a timer fires every few milliseconds and records the CPU time
 * the thread used since the previous tick; the largest value is the longest stretch of work the loop did without turning. CPU time is
 * measured, not the lateness of the timer: a runner shared with other processes delays the timer by tens of milliseconds whatever the
 * code does, while the work the thread itself does between two turns is the same on a busy host.
 */
export const LOOP_SAMPLE_INTERVAL_MS = 5;
const US_PER_MS = 1000;

export interface LoopStats {
  /** The most CPU time the loop thread used between two consecutive timer ticks. */
  heldMs: number;
}

function threadCpuMs(): number {
  const { user, system } = (process as unknown as { threadCpuUsage: () => NodeJS.CpuUsage }).threadCpuUsage();
  return (user + system) / US_PER_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withLoopMonitor<T>(work: () => Promise<T>): Promise<{ value: T } & LoopStats> {
  let previous = threadCpuMs();
  let heldMs = 0;
  const timer = setInterval(() => {
    const now = threadCpuMs();
    heldMs = Math.max(heldMs, now - previous);
    previous = now;
  }, LOOP_SAMPLE_INTERVAL_MS);
  try {
    // The first tick only sets the baseline for the stretch that follows it.
    await sleep(LOOP_SAMPLE_INTERVAL_MS * 3);
    const value = await work();
    // Let a final timer tick land so that the last stretch of work is accounted for.
    await sleep(LOOP_SAMPLE_INTERVAL_MS * 2);
    return { value, heldMs };
  } finally {
    clearInterval(timer);
  }
}
