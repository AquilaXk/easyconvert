import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { userStore } from '../src/lib/auth/user-store';
import { keyStore } from '../src/lib/api-keys/key-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { createSessionToken } from '../src/lib/auth/session';
import { POST as createKey } from '../src/app/api/keys/route';
import { DELETE as revokeKey } from '../src/app/api/keys/[id]/route';
import { TERMS_VERSION } from '../src/lib/legal/documents';

// Hand-written from the brief: an account holds at most 20 active keys.
const EXPECTED_LIMIT = 20;
const ORIGIN = 'http://localhost:3000';

async function accountCookie(email: string): Promise<{ cookie: string; id: string }> {
  const user = userStore.sanitizeUser((await userStore.findByEmail(email)) ?? (await userStore.createUser({ email, name: email })));
  return { cookie: `easyconvert_session=${createSessionToken(user)}`, id: user.id };
}

function request(path: string, cookie: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: { Origin: ORIGIN, Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const create = (cookie: string) => createKey(request('/api/keys', cookie, 'POST', { acceptedTermsVersion: TERMS_VERSION, name: 'k' }));
const activeKeys = async (id: string) => (await redisKeyStore.listApiKeys(id)).filter((key) => key.status === 'active');

beforeEach(() => {
  userStore.resetStore();
  keyStore.resetStore();
});
afterEach(() => vi.restoreAllMocks());

describe('the number of active API keys of an account', () => {
  it('stops at the limit with a coded 409, and the next key is not made', async () => {
    const { cookie, id } = await accountCookie('limit@example.com');
    for (let i = 0; i < EXPECTED_LIMIT; i++) expect((await create(cookie)).status).toBe(200);

    const refused = await create(cookie);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ success: false, code: 'key_limit_reached' });
    expect(await activeKeys(id)).toHaveLength(EXPECTED_LIMIT);
  });

  it('does not count a revoked key, so revoking one makes room for one', async () => {
    const { cookie, id } = await accountCookie('revoke@example.com');
    for (let i = 0; i < EXPECTED_LIMIT; i++) await create(cookie);
    const [first] = await activeKeys(id);
    expect((await revokeKey(request(`/api/keys/${first.id}`, cookie, 'DELETE'), { params: Promise.resolve({ id: first.id }) })).status).toBe(200);

    expect((await create(cookie)).status).toBe(200);
    expect((await create(cookie)).status).toBe(409);
  });

  it('counts the keys of one account only', async () => {
    const full = await accountCookie('full@example.com');
    for (let i = 0; i < EXPECTED_LIMIT; i++) await create(full.cookie);
    const other = await accountCookie('other@example.com');
    expect((await create(other.cookie)).status).toBe(200);
  });

  it('never lets requests sent at once pass the limit', async () => {
    const { cookie, id } = await accountCookie('burst@example.com');
    await Promise.all(Array.from({ length: EXPECTED_LIMIT * 2 }, () => create(cookie)));
    expect((await activeKeys(id)).length).toBeLessThanOrEqual(EXPECTED_LIMIT);
  });
});
