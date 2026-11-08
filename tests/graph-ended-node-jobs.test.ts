import { describe, vi } from 'vitest';
import { itLeavesTheNodeJobsOfAnEndedGraphAlone } from './helpers/graph-ended-node-cases';
import { InMemoryGraphScheduler } from '../src/lib/queue/graph/in-memory-scheduler';
import { allConversionQueues } from '../src/lib/queue/conversion-queue';
import { QueueUnavailableError } from '../src/lib/types';

// The scheduler, the queues and the quota store pick Redis or this process when they are first imported.
vi.hoisted(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

describe('the node jobs of an ended graph, with the in-memory scheduler and queues', () => {
  itLeavesTheNodeJobsOfAnEndedGraphAlone({
    scheduler: () => {
      let stored = 0;
      let storeAtMost = Number.POSITIVE_INFINITY;
      for (const queue of allConversionQueues) {
        const add = queue.add.bind(queue);
        vi.spyOn(queue, 'add').mockImplementation(async (name, data, opts) => {
          if (data.graphId) {
            if (stored >= storeAtMost) throw new QueueUnavailableError(queue.name, 'the node job could not be stored');
            stored++;
          }
          return add(name, data, opts);
        });
      }
      return {
        scheduler: new InMemoryGraphScheduler(),
        refuseNodeJobsAfter: (count) => {
          storeAtMost = count;
        },
        failNodeJobCancels: (failures) => {
          const tries = new Map<string, number>();
          for (const queue of allConversionQueues) {
            const cancelJob = queue.cancelJob.bind(queue);
            vi.spyOn(queue, 'cancelJob').mockImplementation(async (jobId, reason) => {
              const made = (tries.get(jobId) ?? 0) + 1;
              tries.set(jobId, made);
              if (made <= failures) throw new Error('the queue could not be reached');
              return cancelJob(jobId, reason);
            });
          }
          return () => tries;
        },
      };
    },
  });
});
