import { describe, expect, it } from 'vitest';
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants.js';
import config from '../next.config.mjs';
import { SINGLE_REQUEST_BODY_MAX_BYTES, UPLOAD_PART_MAX_BYTES } from '../src/lib/plan-limits';

describe('the body the framework hands a route', () => {
  it.each([PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER])('is as large as the largest single request in the %s phase, so a file or a part past 10 MiB reaches its route whole', async (phase) => {
    const nextConfig = await config(phase);
    expect(nextConfig.experimental?.middlewareClientMaxBodySize).toBe(SINGLE_REQUEST_BODY_MAX_BYTES);
    expect(UPLOAD_PART_MAX_BYTES).toBeLessThanOrEqual(SINGLE_REQUEST_BODY_MAX_BYTES);
  });
});
