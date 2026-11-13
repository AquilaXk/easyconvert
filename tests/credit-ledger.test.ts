import { afterAll, afterEach, describe, vi } from 'vitest';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { itKeepsCredits } from './helpers/credit-ledger-cases';

// The quota store picks Redis or this process when it is first imported; Redis is covered by tests/credit-ledger-redis.test.ts.
vi.hoisted(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('the credit ledger in this process', () => {
  let store = new RedisKeyStore({ isolated: true });
  itKeepsCredits({
    store: () => store,
    advance: async (ms) => {
      vi.setSystemTime(Date.now() + ms);
    },
  });
  afterEach(() => {
    store = new RedisKeyStore({ isolated: true });
  });
});
