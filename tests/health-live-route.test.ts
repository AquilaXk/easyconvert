import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * GET /api/health/live answers 200 while the process serves requests and touches no dependency: the readiness report and the
 * stores behind it are replaced by modules that fail the test when they are loaded or called.
 */

vi.mock('@/lib/health/probes', () => ({
  getHealthReport: vi.fn(() => {
    throw new Error('liveness must not run the readiness probes');
  }),
}));
vi.mock('@/lib/api-keys/guard', () => {
  throw new Error('liveness must not load the API key guard');
});

import { GET } from '../src/app/api/health/live/route';

const ROUTE_FILE = path.join(__dirname, '..', 'src', 'app', 'api', 'health', 'live', 'route.ts');

describe('GET /api/health/live', () => {
  it('answers 200 with an uncached body and no readiness check', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'alive' });
  });

  it('answers a request that carries no credentials the same way', async () => {
    const res = await (GET as unknown as (req: NextRequest) => Promise<Response>)(new NextRequest('http://127.0.0.1:3000/api/health/live'));
    expect(res.status).toBe(200);
  });

  it('imports nothing but the framework', () => {
    const imports = [...fs.readFileSync(ROUTE_FILE, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports).toEqual(['next/server']);
  });
});
