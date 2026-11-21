import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_ERROR_GLOBAL_MAX,
  CLIENT_ERROR_MAX_PER_IP,
  consumeClientErrorRateLimit,
  resetLoginRateLimiterStore,
} from '../src/lib/auth/login-rate-limiter';

beforeEach(() => resetLoginRateLimiterStore());

describe('the limit of the reports of one client', () => {
  it('lets a client send its share and refuses the next, with the seconds to wait', async () => {
    for (let sent = 0; sent < CLIENT_ERROR_MAX_PER_IP; sent++) {
      expect((await consumeClientErrorRateLimit('203.0.113.5')).allowed).toBe(true);
    }
    const refused = await consumeClientErrorRateLimit('203.0.113.5');
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('ip');
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('counts each client on its own', async () => {
    for (let sent = 0; sent <= CLIENT_ERROR_MAX_PER_IP; sent++) await consumeClientErrorRateLimit('203.0.113.5');
    expect((await consumeClientErrorRateLimit('203.0.113.6')).allowed).toBe(true);
  });

  it('counts a client that cannot be attributed against one shared limit', async () => {
    for (let sent = 0; sent < CLIENT_ERROR_GLOBAL_MAX; sent++) await consumeClientErrorRateLimit(null);
    const refused = await consumeClientErrorRateLimit(null);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('global');
  });
});
