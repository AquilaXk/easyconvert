import { clearQueueGauges, setQueueGauges } from './instruments';
import { QUEUE_DEPTH_STATES, type QueueName } from './labels';

const MS_PER_SECOND = 1000;

/** A queue the gauges read, as the engine answers for it. */
export interface QueueSource {
  readonly name: QueueName;
  jobCounts(): Promise<Readonly<Record<string, number>>>;
  oldestWaitingSince?(): Promise<number | undefined>;
}

/**
 * Reads the depth and the age of each queue into the gauges, just before a scrape is answered. When any queue cannot be read (the
 * store is down) the readings are dropped, so that a scrape never reports an old depth as a current one, and the failure is counted.
 */
export async function sampleQueues(sources: readonly QueueSource[], now: number = Date.now()): Promise<void> {
  try {
    const readings = await Promise.all(
      sources.map(async (source) => ({
        name: source.name,
        counts: await source.jobCounts(),
        waitingSince: await source.oldestWaitingSince?.(),
      }))
    );
    for (const { name, counts, waitingSince } of readings) {
      const depth = Object.fromEntries(QUEUE_DEPTH_STATES.map((state) => [state, counts[state] ?? 0])) as Record<(typeof QUEUE_DEPTH_STATES)[number], number>;
      const waitingSeconds = waitingSince === undefined ? 0 : Math.max(0, now - waitingSince) / MS_PER_SECOND;
      setQueueGauges(name, depth, waitingSeconds);
    }
  } catch {
    clearQueueGauges();
  }
}
