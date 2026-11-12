import { describe, it, expect } from 'vitest';
import { buildRateLimitHeaders } from '@/lib/api/rate-limit';

describe('Standard IETF RateLimit headers', () => {
  it('emits RateLimit-Policy and combined RateLimit header field matching IETF draft syntax', () => {
    const quota = {
      tier: 'pro' as const,
      dailyLimit: 500,
      usedToday: 120,
      remaining: 380,
      resetAt: Date.now() + 3600 * 1000, // 1 hour left
    };

    const headers = buildRateLimitHeaders(quota);

    // Verify standard IETF RateLimit combined header
    expect(headers['RateLimit']).toBeDefined();
    expect(headers['RateLimit']).toMatch(/^limit=500, remaining=380, reset=\d+$/);

    // Verify RateLimit-Policy header
    expect(headers['RateLimit-Policy']).toBeDefined();
    expect(headers['RateLimit-Policy']).toContain('500;w=86400');

    // Verify backward-compatibility headers
    expect(headers['X-RateLimit-Limit']).toBe('500');
    expect(headers['X-RateLimit-Remaining']).toBe('380');
    expect(headers['RateLimit-Limit']).toBe('500');
    expect(headers['RateLimit-Remaining']).toBe('380');
  });
});
