import { expect } from 'vitest';

/** The RateLimit-Policy window of a daily quota, in seconds (draft-ietf-httpapi-ratelimit-headers, `w`). */
export const DAILY_WINDOW_SECONDS = 86_400;

export interface ExpectedRateLimit {
  /** Daily quota of the caller's tier. */
  limit: number;
  /** Units left after the request under test. */
  remaining: number;
  tier: string;
}

/** Reads a header that must be present: `Headers.get` answers null for an absent one. */
export function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) throw new Error(`response has no ${name} header`);
  return value;
}

/**
 * Checks the IETF RateLimit header family of a response against the quota the caller is known to have: exact
 * limit and remaining values, a reset within the daily window, the combined `RateLimit` field and the
 * `RateLimit-Policy` field spelled as the draft defines them, and the legacy X-RateLimit-* copies.
 */
export function expectRateLimitHeaders(headers: Headers, expected: ExpectedRateLimit): void {
  expect(requiredHeader(headers, 'RateLimit-Limit')).toBe(String(expected.limit));
  expect(requiredHeader(headers, 'RateLimit-Remaining')).toBe(String(expected.remaining));
  const reset = requiredHeader(headers, 'RateLimit-Reset');
  expect(reset).toMatch(/^\d+$/);
  expect(Number(reset)).toBeGreaterThan(0);
  expect(Number(reset)).toBeLessThanOrEqual(DAILY_WINDOW_SECONDS);
  expect(requiredHeader(headers, 'RateLimit')).toBe(`limit=${expected.limit}, remaining=${expected.remaining}, reset=${reset}`);
  expect(requiredHeader(headers, 'RateLimit-Policy')).toBe(
    `${expected.limit};w=${DAILY_WINDOW_SECONDS};comment="${expected.tier} daily quota"`
  );
  expect(requiredHeader(headers, 'X-RateLimit-Limit')).toBe(String(expected.limit));
  expect(requiredHeader(headers, 'X-RateLimit-Remaining')).toBe(String(expected.remaining));
  expect(requiredHeader(headers, 'X-RateLimit-Reset')).toBe(reset);
}
