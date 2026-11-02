import { afterAll, describe, expect, it, vi } from 'vitest';
import { itChargesAGraphOnlyThroughItsScheduler } from './helpers/graph-charge-cases';
import { InMemoryGraphScheduler } from '../src/lib/queue/graph/in-memory-scheduler';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';

// The scheduler, the queues and the quota store pick Redis or this process when they are first imported.
vi.hoisted(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));
vi.mock('@/lib/security/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/ssrf')>()),
  validateUrlForSsrf: vi.fn(async () => true),
  createSsrfSafeAgent: () => ({ close: async () => undefined }),
}));

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('what a queued graph is charged, with the in-memory scheduler and store', () => {
  itChargesAGraphOnlyThroughItsScheduler();
});

describe('the in-memory graph scheduler', () => {
  it('completes a graph once when two of its nodes fail at the same time under continue', async () => {
    const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue(undefined as never);
    try {
      const scheduler = new InMemoryGraphScheduler();
      const graphId = `graph_twice_${Date.now()}`;
      await scheduler.initGraph(
        graphId,
        {
          failurePolicy: 'continue',
          nodes: {
            left: { op: 'import.upload', storageKey: 'uploads/graph-twice/left.csv' },
            right: { op: 'import.upload', storageKey: 'uploads/graph-twice/right.csv' },
            leftJson: { op: 'convert', input: 'left', targetFormat: 'json' },
            rightJson: { op: 'convert', input: 'right', targetFormat: 'json' },
          },
        },
        { webhookUrl: 'https://hooks.example.com/graph', webhookSecret: 'whsec_twice' }
      );

      await Promise.all([scheduler.onNodeFailed(graphId, 'left', 'left failed'), scheduler.onNodeFailed(graphId, 'right', 'right failed')]);

      expect((await scheduler.getGraphState(graphId))?.status).toBe('completed');
      expect(dispatched.mock.calls.map((call) => call[1])).toEqual(['graph.completed']);
    } finally {
      dispatched.mockRestore();
    }
  });
});
