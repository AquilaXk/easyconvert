import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { validateApiAccess } from '../../src/lib/api-keys/guard';
import { redisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { anonymousUserId } from '../../src/lib/auth/anonymous-identity';
import { createSessionToken } from '../../src/lib/auth/session';
import { userStore } from '../../src/lib/auth/user-store';
import type { User } from '../../src/lib/auth/types';

/**
 * A request that costs no conversion and needs none left (a link import, QA 2026-11-02), checked for each kind of
 * caller the guard knows: a signed-in session, an API key, an anonymous visitor a declared proxy attributes, and the
 * shared identity of visitors no proxy attributes, which has no daily count. The same cases run against the in-memory
 * store and a real Redis server.
 */

const IMPORT_URL = 'http://localhost/api/fetch-url';

interface Caller {
  userId: string;
  request: () => NextRequest;
}

async function account(): Promise<User> {
  const email = `unit-left-${crypto.randomBytes(6).toString('hex')}@quota.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: 'Unit Left', tier: 'free' }));
}

const CALLERS: Record<'session' | 'API key' | 'anonymous visitor', () => Promise<Caller>> = {
  session: async () => {
    const user = await account();
    const cookie = `easyconvert_session=${createSessionToken(user)}`;
    return { userId: user.id, request: () => new NextRequest(IMPORT_URL, { method: 'POST', headers: { cookie } }) };
  },
  'API key': async () => {
    const user = await account();
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'unit left', { scopes: ['convert:write'] });
    return { userId: user.id, request: () => new NextRequest(IMPORT_URL, { method: 'POST', headers: { authorization: `Bearer ${secretKey}` } }) };
  },
  'anonymous visitor': async () => {
    const ip = `198.18.${crypto.randomInt(0, 256)}.${crypto.randomInt(1, 255)}`;
    return { userId: anonymousUserId(ip), request: () => new NextRequest(IMPORT_URL, { method: 'POST', headers: { 'x-forwarded-for': ip } }) };
  },
};

const importAccess = (caller: Caller) =>
  validateApiAccess(caller.request(), { requiredUnits: 0, requiredScope: 'convert:write', allowAnonymous: true });

const remainingOf = async (caller: Caller) => (await redisKeyStore.getQuotaUsage(caller.userId)).remaining;

/**
 * Registers the cases. The suite stubs `TRUSTED_PROXIES` so that an anonymous visitor is attributed; `onCaller` gets the
 * id of each caller made, for a suite that removes what it wrote.
 */
export function itFetchesWithNoUnitLeftForEveryCaller(onCaller: (userId: string) => void = () => undefined): void {
  it.each(Object.keys(CALLERS) as Array<keyof typeof CALLERS>)(
    'lets a %s through without reserving a conversion, with one left and with none',
    async (kind) => {
      const caller = await CALLERS[kind]();
      onCaller(caller.userId);
      await redisKeyStore.recordUsage(caller.userId, (await remainingOf(caller)) - 1);

      const withOneLeft = await importAccess(caller);
      expect([withOneLeft.authorized, withOneLeft.reservationId]).toEqual([true, undefined]);
      expect(await remainingOf(caller)).toBe(1);

      await redisKeyStore.recordUsage(caller.userId, 1);
      const withNoneLeft = await importAccess(caller);
      expect([withNoneLeft.authorized, withNoneLeft.reservationId]).toEqual([true, undefined]);
      expect(await remainingOf(caller)).toBe(0);
    }
  );

  it('lets the shared identity of unattributed visitors through, since it has no daily count', async () => {
    vi.stubEnv('TRUSTED_PROXIES', 'none');
    const auth = await importAccess({ userId: 'anon:unattributed', request: () => new NextRequest(IMPORT_URL, { method: 'POST' }) });
    expect([auth.authorized, auth.user?.id, auth.reservationId]).toEqual([true, 'anon:unattributed', undefined]);
  });
}
