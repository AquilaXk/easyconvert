/**
 * The messages between the benchmark (bench/ab-host.ts) and the process that measures the base of the change
 * (bench/ab-child.ts). The child runs the same family runners as the benchmark, with the product of the base checkout;
 * each time a runner asks for the time of a row it announces it (`ready`, numbered in the order of the runners'
 * requests) and then times its `ours` on request until the benchmark moves to the next row (`next`). Both sides run the
 * same runners in the same order, so the n-th request of one is the n-th request of the other.
 */
export type HostMessage =
  | { type: 'call' }
  | { type: 'sample'; calls: number }
  | { type: 'next' }
  | { type: 'exit' };

export type ChildMessage =
  | { type: 'hello' }
  | { type: 'ready'; row: number }
  /** Milliseconds of one call, or the mean per call of a sample. */
  | { type: 'timed'; ms: number }
  /** The base cannot run this row (the product of the base lacks what the row asks for). */
  | { type: 'failed'; message: string }
  | { type: 'finished'; rows: number }
  | { type: 'crashed'; message: string };
