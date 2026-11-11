import { describe, expect, it } from 'vitest';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { enqueueGraphNodeJob, GRAPH_NODE_JOB_ATTEMPTS, graphNodeJobId } from '../src/lib/queue/graph/node-jobs';

/**
 * A node of a graph that is still running when its worker is stopped is requeued by the stalled-job recovery and not failed for good,
 * because its job has more than one attempt (the recovery fails a job only when its attempts are used up; see `job-lifecycle-redis`).
 */
describe('the job of a graph node', () => {
  it('is queued with more than one attempt', async () => {
    const graphId = `job_${Date.now()}_attempts`;
    await enqueueGraphNodeJob(graphId, 'convert', { op: 'convert', input: 'upload', targetFormat: 'json' } as never, { createdAt: Date.now() }, []);

    const job = await conversionQueue.getJob(graphNodeJobId(graphId, 'convert'));

    expect(GRAPH_NODE_JOB_ATTEMPTS).toBeGreaterThan(1);
    expect(job?.opts.attempts).toBe(GRAPH_NODE_JOB_ATTEMPTS);
    await conversionQueue.remove(graphNodeJobId(graphId, 'convert'));
  });
});
