import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as googleState } from '../src/app/api/auth/google/route';
import { GET as googleUrl } from '../src/app/api/auth/google/url/route';
import { NextRequest } from 'next/server';

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/auth/google', () => {
  it('says Google sign-in is off in production without a client id, as the url route refuses it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    expect(await (await googleState()).json()).toEqual({ success: true, enabled: false });
    const refused = await googleUrl(new NextRequest('http://localhost:3000/api/auth/google/url'));
    expect(refused.status).toBe(503);
  });

  it('says it is on in production with a client id', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    expect(await (await googleState()).json()).toEqual({ success: true, enabled: true });
  });

  it('says it is on outside production, where a local sandbox answers', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    expect(await (await googleState()).json()).toEqual({ success: true, enabled: true });
  });
});
