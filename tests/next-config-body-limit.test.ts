import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';
import { SINGLE_REQUEST_BODY_MAX_BYTES, UPLOAD_PART_MAX_BYTES } from '../src/lib/plan-limits';

describe('the body the framework hands a route', () => {
  it('is as large as the largest single request, so a file or a part past 10 MiB reaches its route whole', () => {
    expect(nextConfig.experimental?.middlewareClientMaxBodySize).toBe(SINGLE_REQUEST_BODY_MAX_BYTES);
    expect(UPLOAD_PART_MAX_BYTES).toBeLessThanOrEqual(SINGLE_REQUEST_BODY_MAX_BYTES);
  });
});
