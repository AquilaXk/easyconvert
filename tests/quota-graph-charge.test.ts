import { afterAll, describe, vi } from 'vitest';
import { itChargesAGraphOnlyThroughItsScheduler } from './helpers/graph-charge-cases';

// The scheduler, the queues and the quota store pick Redis or this process when they are first imported.
vi.hoisted(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('what a queued graph is charged, with the in-memory scheduler and store', () => {
  itChargesAGraphOnlyThroughItsScheduler();
});
