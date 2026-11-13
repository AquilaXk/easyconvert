import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import { freshClientIp, googleAccount, passwordAccount, stubMailConfig } from './helpers/auth-mail-fixtures';

/**
 * An account of the old kind, whose address nobody confirmed, has no daily allowance of its own: it counts as an anonymous
 * visitor of its address bucket for conversions until a code confirms the address. docs/policy-decisions.md, entry 288.
 */

beforeEach(() => {
  redisUserStore.resetStore();
  redisKeyStore.resetStore();
  stubMailConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('an account whose address was never confirmed counts as anonymous for conversions', () => {
  async function accessOf(record: Awaited<ReturnType<typeof passwordAccount>>, options: { allowAnonymous?: boolean; requiredUnits?: number }, ip = freshClientIp()) {
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(redisUserStore.sanitizeUser(record))}`;
    return validateApiAccess(new Request('http://localhost:3000/api/convert', { headers: { cookie, 'x-forwarded-for': ip } }), options);
  }

  it('answers as the visitor of its address bucket on a route open to visitors, and as itself once confirmed', async () => {
    const ip = '198.51.100.20';
    const unconfirmed = await accessOf(await passwordAccount('old.timer'), { allowAnonymous: true }, ip);
    expect(unconfirmed.authorized).toBe(true);
    expect(unconfirmed.user?.id).toBe(`anon:${ip}`);

    const confirmed = await passwordAccount('confirmed', { emailVerified: true });
    expect((await accessOf(confirmed, { allowAnonymous: true }, ip)).user?.id).toBe(confirmed.id);
    const google = await googleAccount('googler');
    expect((await accessOf(google, { allowAnonymous: true }, ip)).user?.id).toBe(google.id);
  });

  it('shares the allowance of its address bucket with the visitors there, so another account of the address adds nothing', async () => {
    const ip = '198.51.100.21';
    const first = await accessOf(await passwordAccount('one'), { allowAnonymous: true, requiredUnits: 1 }, ip);
    const second = await accessOf(await passwordAccount('two'), { allowAnonymous: true, requiredUnits: 1 }, ip);
    expect(second.remaining).toBe((first.remaining ?? 0) - 1);
  });

  it('keeps its own identity when it has paid, and on a route that only reads', async () => {
    const paid = await passwordAccount('payer');
    await redisUserStore.updateUser(paid.id, { tier: 'paid' });
    const record = (await redisUserStore.findById(paid.id))!;
    expect((await accessOf(record, { allowAnonymous: true })).user?.id).toBe(paid.id);
    const reader = await passwordAccount('reader');
    expect((await accessOf(reader, { requiredUnits: 0 })).user?.id).toBe(reader.id);
  });

  it('is refused, with a way out, on a route that is not open to visitors and needs a conversion', async () => {
    const refused = await accessOf(await passwordAccount('old.timer'), { requiredUnits: 1 });
    expect(refused).toMatchObject({ authorized: false, status: 403 });
    expect(refused.error).toContain('Sign in again');
  });

  it('applies to the API key of such an account too', async () => {
    const record = await passwordAccount('keyed');
    const { secretKey } = await redisKeyStore.generateApiKey(record.id, 'Key', { scopes: ['*'] });
    const ip = '198.51.100.22';
    const keyed = (options: { allowAnonymous?: boolean; requiredUnits?: number }) =>
      validateApiAccess(new Request('http://localhost:3000/api/v1/convert', { headers: { 'x-api-key': secretKey, 'x-forwarded-for': ip } }), options);
    expect((await keyed({ allowAnonymous: true })).user?.id).toBe(`anon:${ip}`);
    expect(await keyed({ requiredUnits: 1 })).toMatchObject({ authorized: false, status: 403 });
    await redisUserStore.updateUser(record.id, { emailVerified: true });
    expect((await keyed({ requiredUnits: 1 })).user?.id).toBe(record.id);
  });
});
