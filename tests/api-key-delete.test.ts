import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE as deleteKeyRoute } from '../src/app/api/keys/[id]/route';
import { GET as listKeysRoute, POST as createKeyRoute } from '../src/app/api/keys/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { getWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { MAX_ACTIVE_API_KEYS } from '../src/lib/api-keys/types';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import { loadDashboardSnapshot } from '../src/lib/dashboard/snapshot';
import { TERMS_VERSION } from '../src/lib/legal/documents';

/**
 * Deleting an API key (QA 2026-11-27, replacing the revoked key that stayed in the list): the key stops working at once, its record
 * with the hash, the signing secret of its webhook and its rate bucket is removed, and neither the list nor the dashboard shows it.
 */

const ORIGIN = 'http://localhost:3000';

async function owner() {
  const user = await userStore.createUser({
    name: 'Key Owner',
    email: `key_delete_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
    tier: 'paid',
  });
  const cookie = `easyconvert_session=${createSessionToken(user)}`;
  return { user, cookie };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (path: string, cookie: string, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

/** Marks the stored record as an earlier version left it: revoked, with its hash kept. */
async function markRevoked(keyId: string): Promise<void> {
  const redis = redisKeyStore.getRedisClient();
  if (redis) await redis.hset(`${redisKeyStore.getPrefix()}apikeys:${keyId}`, 'status', 'revoked');
  else (redisKeyStore as unknown as { keys: Map<string, { status: string }> }).keys.get(keyId)!.status = 'revoked';
}

afterEach(() => vi.restoreAllMocks());

async function listedIds(cookie: string): Promise<string[]> {
  const res = await listKeysRoute(request('/api/keys', cookie));
  expect(res.status).toBe(200);
  return ((await res.json()) as { keys: Array<{ id: string }> }).keys.map((key) => key.id);
}

describe('deleting an API key', () => {
  it('answers that the key was deleted, refuses its secret at once and takes the key out of the list', async () => {
    const { user, cookie } = await owner();
    const kept = await redisKeyStore.generateApiKey(user.id, 'Kept');
    const gone = await redisKeyStore.generateApiKey(user.id, 'Gone');
    expect(await listedIds(cookie)).toEqual(expect.arrayContaining([kept.key.id, gone.key.id]));

    const res = await deleteKeyRoute(request(`/api/keys/${gone.key.id}`, cookie, { method: 'DELETE' }), params(gone.key.id));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: 'API key successfully deleted.' });
    expect((await redisKeyStore.verifyApiKey(gone.secretKey)).valid).toBe(false);
    expect((await redisKeyStore.verifyApiKey(kept.secretKey)).valid).toBe(true);
    expect(await listedIds(cookie)).toEqual([kept.key.id]);
    expect((await loadDashboardSnapshot(user as never)).keys?.map((key) => key.id)).toEqual([kept.key.id]);
  });

  it('removes the whole record of the key: its hash, its signing secret and the rotated secret of its webhook', async () => {
    const { user, cookie } = await owner();
    const { key } = await redisKeyStore.generateApiKey(user.id, 'Hooked', {
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'initial_secret',
    });
    await getWebhookSecretStore().setPrimarySecret(user.id, key.id, 'whsec_rotated_secret');

    await deleteKeyRoute(request(`/api/keys/${key.id}`, cookie, { method: 'DELETE' }), params(key.id));

    expect((await redisKeyStore.listApiKeys(user.id)).map((listed) => listed.id)).not.toContain(key.id);
    expect(await getWebhookSecretStore().getSecretRecord(user.id, key.id)).toBeNull();
  });

  it('answers 404 for a key that is already deleted and for the key of another account', async () => {
    const { user, cookie } = await owner();
    const other = await owner();
    const { key } = await redisKeyStore.generateApiKey(user.id, 'Twice');

    const foreign = await deleteKeyRoute(request(`/api/keys/${key.id}`, other.cookie, { method: 'DELETE' }), params(key.id));
    expect(foreign.status).toBe(404);
    expect(await listedIds(cookie)).toEqual([key.id]);

    expect((await deleteKeyRoute(request(`/api/keys/${key.id}`, cookie, { method: 'DELETE' }), params(key.id))).status).toBe(200);
    expect((await deleteKeyRoute(request(`/api/keys/${key.id}`, cookie, { method: 'DELETE' }), params(key.id))).status).toBe(404);
  });

  it('makes room under the limit of active keys: a deleted key does not count', async () => {
    const { user, cookie } = await owner();
    const made: string[] = [];
    for (let n = 0; n < MAX_ACTIVE_API_KEYS; n++) made.push((await redisKeyStore.generateApiKey(user.id, `Key ${n}`)).key.id);
    const create = () =>
      createKeyRoute(request('/api/keys', cookie, { method: 'POST', body: { name: 'One more', acceptedTermsVersion: TERMS_VERSION } }));
    expect((await create()).status).toBe(409);

    await deleteKeyRoute(request(`/api/keys/${made[0]}`, cookie, { method: 'DELETE' }), params(made[0]!));

    expect((await create()).status).toBe(200);
    expect(await listedIds(cookie)).toHaveLength(MAX_ACTIVE_API_KEYS);
  });

  it('removes a key that an earlier version only marked as revoked when the list is read', async () => {
    const { user, cookie } = await owner();
    const live = await redisKeyStore.generateApiKey(user.id, 'Live');
    const old = await redisKeyStore.generateApiKey(user.id, 'Marked revoked');
    await markRevoked(old.key.id);
    expect(await listedIds(cookie)).toEqual([live.key.id]);
    expect((await redisKeyStore.listApiKeys(user.id)).map((listed) => listed.id)).toEqual([live.key.id]);
    expect((await loadDashboardSnapshot(user as never)).keys?.map((key) => key.id)).toEqual([live.key.id]);
  });

  it('leaves the signing secrets of an endpoint alone when the id names an endpoint and not a key, and answers 404', async () => {
    const { user, cookie } = await owner();
    await getWebhookSecretStore().setPrimarySecret(user.id, 'ep_billing', 'whsec_endpoint_secret');

    const res = await deleteKeyRoute(request('/api/keys/ep_billing', cookie, { method: 'DELETE' }), params('ep_billing'));

    expect(res.status).toBe(404);
    expect((await getWebhookSecretStore().getSecretRecord(user.id, 'ep_billing'))?.primary).toBe('whsec_endpoint_secret');
  });

  it('lists the other keys when the purge of one legacy revoked record fails, and tries it again on the next read', async () => {
    const { user, cookie } = await owner();
    const live = await redisKeyStore.generateApiKey(user.id, 'Live');
    const stuck = await redisKeyStore.generateApiKey(user.id, 'Stuck legacy');
    const other = await redisKeyStore.generateApiKey(user.id, 'Other legacy');
    await markRevoked(stuck.key.id);
    await markRevoked(other.key.id);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const realDelete = redisKeyStore.deleteApiKey.bind(redisKeyStore);
    const failing = vi.spyOn(redisKeyStore, 'deleteApiKey').mockImplementation((userId, keyId) =>
      keyId === stuck.key.id ? Promise.reject(new Error('store down')) : realDelete(userId, keyId)
    );

    expect(await listedIds(cookie)).toEqual([live.key.id]);
    const stored = (await redisKeyStore.listApiKeys(user.id)).map((listed) => listed.id);
    expect(stored).toContain(stuck.key.id);
    expect(stored).not.toContain(other.key.id);

    failing.mockRestore();
    expect(await listedIds(cookie)).toEqual([live.key.id]);
    expect((await redisKeyStore.listApiKeys(user.id)).map((listed) => listed.id)).toEqual([live.key.id]);
  });

  it('keeps a key that a retry can delete when the first step of the deletion fails', async () => {
    const { user, cookie } = await owner();
    const { key, secretKey } = await redisKeyStore.generateApiKey(user.id, 'Retried');
    vi.spyOn(getWebhookSecretStore(), 'deleteSecretRecord').mockRejectedValueOnce(new Error('secret store down'));

    await expect(deleteKeyRoute(request(`/api/keys/${key.id}`, cookie, { method: 'DELETE' }), params(key.id))).rejects.toThrow('secret store down');
    expect(await listedIds(cookie)).toEqual([key.id]);
    expect((await redisKeyStore.verifyApiKey(secretKey)).valid).toBe(true);

    expect((await deleteKeyRoute(request(`/api/keys/${key.id}`, cookie, { method: 'DELETE' }), params(key.id))).status).toBe(200);
    expect(await listedIds(cookie)).toEqual([]);
    expect((await redisKeyStore.verifyApiKey(secretKey)).valid).toBe(false);
  });
});
