import { afterAll, afterEach, describe, vi } from 'vitest';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { itKeepsPromoCredits } from './helpers/promo-credit-cases';

// The quota store picks Redis or this process when it is first imported; Redis is covered by tests/promo-credits-redis.test.ts.
vi.hoisted(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('promotional credits in the ledger of this process', () => {
  let store = new RedisKeyStore({ isolated: true });
  itKeepsPromoCredits({
    store: () => store,
    advance: async (ms) => {
      vi.setSystemTime(Date.now() + ms);
    },
    now: async () => Date.now(),
  });
  afterEach(() => {
    store = new RedisKeyStore({ isolated: true });
  });
});
