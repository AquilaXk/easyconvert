import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { userStore } from '../src/lib/auth/user-store';
import { keyStore } from '../src/lib/api-keys/key-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { createSessionToken } from '../src/lib/auth/session';
import { GET as listKeys, POST as createKey } from '../src/app/api/keys/route';
import { DELETE as revokeKey, PATCH as updateKey } from '../src/app/api/keys/[id]/route';
import { POST as rotateKey } from '../src/app/api/keys/[id]/rotate/route';
import { GET as keyUsage } from '../src/app/api/keys/usage/route';
import { GET as listFiles } from '../src/app/api/account/files/route';
import { DELETE as deleteFile } from '../src/app/api/account/files/[id]/route';
import { DELETE as clearDlq, GET as listDlq } from '../src/app/api/webhooks/dlq/route';
import { DELETE as deleteDlq, GET as readDlq } from '../src/app/api/webhooks/dlq/[id]/route';
import { POST as replayDlq } from '../src/app/api/webhooks/dlq/[id]/replay/route';
import { useDashboardErrorWording } from '../src/components/i18n/error-wording';
import { DASHBOARD_REFUSAL_CODES } from '../src/lib/refusal-codes';
import { renderDom, visibleText } from './helpers/rendered-dom';
import { testMessages, type TestLocale } from './helpers/intl-messages';

/**
 * The dashboard routes name a refusal with a code of their closed list only where the status cannot say it (a key without
 * the `*` scope, settings or a grace period out of range, a key that could not be made), next to the English `error` API
 * callers read. Every other refusal is worded by its status, and the dashboard words neither with the server's text.
 */

const ORIGIN = 'http://localhost:3000';
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function owner() {
  return userStore.sanitizeUser(await userStore.createUser({ email: 'owner@example.com', name: 'Owner' }));
}

async function sessionCookie(): Promise<string> {
  return `easyconvert_session=${createSessionToken(await owner())}`;
}

/** The `Authorization` header of a key of the owner that has every scope but `*`. */
async function keyWithoutAdminScope(): Promise<string> {
  const { secretKey } = await redisKeyStore.generateApiKey((await owner()).id, 'Worker', {
    scopes: ['convert:read', 'convert:write', 'storage:download'],
  });
  return `Bearer ${secretKey}`;
}

function request(path: string, init: { method?: string; cookie?: string; authorization?: string; body?: unknown } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Origin: ORIGIN,
      ...(init.cookie ? { Cookie: init.cookie } : {}),
      ...(init.authorization ? { Authorization: init.authorization } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function answer(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function worded(locale: TestLocale, body: unknown, status: number): string {
  let sentence = '';
  function Wording() {
    sentence = useDashboardErrorWording()(body, status, 'fallback');
    return createElement('p', null, sentence);
  }
  visibleText(renderDom(createElement(Wording), locale));
  return sentence;
}

beforeEach(() => {
  userStore.resetStore();
  keyStore.resetStore();
});
afterEach(() => vi.restoreAllMocks());

type Caller = { cookie?: string; authorization?: string };
const ROUTES: ReadonlyArray<[string, (caller: Caller) => Promise<Response>]> = [
  ['GET /api/keys', (c) => listKeys(request('/api/keys', c))],
  ['POST /api/keys', (c) => createKey(request('/api/keys', { ...c, method: 'POST', body: {} }))],
  ['DELETE /api/keys/k', (c) => revokeKey(request('/api/keys/k', { ...c, method: 'DELETE' }), params('k'))],
  ['PATCH /api/keys/k', (c) => updateKey(request('/api/keys/k', { ...c, method: 'PATCH', body: {} }), params('k'))],
  ['POST /api/keys/k/rotate', (c) => rotateKey(request('/api/keys/k/rotate', { ...c, method: 'POST', body: {} }), params('k'))],
  ['GET /api/keys/usage', (c) => keyUsage(request('/api/keys/usage', c))],
  ['GET /api/account/files', (c) => listFiles(request('/api/account/files', c))],
  ['DELETE /api/account/files/f', (c) => deleteFile(request('/api/account/files/f', { ...c, method: 'DELETE' }), params('f'))],
  ['GET /api/webhooks/dlq', (c) => listDlq(request('/api/webhooks/dlq', c))],
  ['DELETE /api/webhooks/dlq', (c) => clearDlq(request('/api/webhooks/dlq', { ...c, method: 'DELETE' }))],
  ['GET /api/webhooks/dlq/d', (c) => readDlq(request('/api/webhooks/dlq/d', c), params('d'))],
  ['DELETE /api/webhooks/dlq/d', (c) => deleteDlq(request('/api/webhooks/dlq/d', { ...c, method: 'DELETE' }), params('d'))],
  ['POST /api/webhooks/dlq/d/replay', (c) => replayDlq(request('/api/webhooks/dlq/d/replay', { ...c, method: 'POST' }), params('d'))],
];
const ADMIN_ROUTES = new Set([
  'GET /api/keys', 'POST /api/keys', 'DELETE /api/keys/k', 'PATCH /api/keys/k', 'POST /api/keys/k/rotate',
  'DELETE /api/webhooks/dlq', 'DELETE /api/webhooks/dlq/d', 'POST /api/webhooks/dlq/d/replay',
]);

describe('a dashboard route', () => {
  it.each(ROUTES)('%s refuses a caller without a session or key with a 401 the status words', async (_route, call) => {
    const { status, body } = await answer(await call({}));
    expect(status).toBe(401);
    expect(body).toMatchObject({ success: false });
    expect(body).not.toHaveProperty('code');
    expect(typeof body.error).toBe('string');
  });

  it.each(ROUTES)('%s needs the * scope of a key only where it changes keys or failed webhooks', async (route, call) => {
    const { status, body } = await answer(await call({ authorization: await keyWithoutAdminScope() }));
    if (ADMIN_ROUTES.has(route)) {
      expect({ status, code: body.code }).toEqual({ status: 403, code: 'admin_scope_required' });
    } else {
      expect(status).not.toBe(403);
      expect(body).not.toHaveProperty('code');
    }
  });

  it.each([
    ['DELETE /api/keys/missing', (cookie: string) => revokeKey(request('/api/keys/missing', { method: 'DELETE', cookie }), params('missing'))],
    ['PATCH /api/keys/missing', (cookie: string) => updateKey(request('/api/keys/missing', { method: 'PATCH', cookie, body: { name: 'x' } }), params('missing'))],
    ['DELETE /api/account/files/missing', (cookie: string) => deleteFile(request('/api/account/files/missing', { method: 'DELETE', cookie }), params('missing'))],
    ['GET /api/webhooks/dlq/missing', (cookie: string) => readDlq(request('/api/webhooks/dlq/missing', { cookie }), params('missing'))],
    ['DELETE /api/webhooks/dlq/missing', (cookie: string) => deleteDlq(request('/api/webhooks/dlq/missing', { method: 'DELETE', cookie }), params('missing'))],
    ['POST /api/webhooks/dlq/missing/replay', (cookie: string) => replayDlq(request('/api/webhooks/dlq/missing/replay', { method: 'POST', cookie }), params('missing'))],
    ['POST /api/keys/missing/rotate', (cookie: string) => rotateKey(request('/api/keys/missing/rotate', { method: 'POST', cookie, body: {} }), params('missing'))],
  ])('%s answers an unknown id with a 404 the status words', async (_route, call) => {
    const { status, body } = await answer(await call(await sessionCookie()));
    expect(status).toBe(404);
    expect(body).toMatchObject({ success: false });
    expect(body).not.toHaveProperty('code');
  });

  it('refuses key settings it cannot take with 400 invalid_key_settings, and a grace period out of range with invalid_grace_period', async () => {
    const cookie = await sessionCookie();
    const settings = await answer(await createKey(request('/api/keys', { method: 'POST', cookie, body: { scopes: ['admin'] } })));
    expect(settings).toMatchObject({ status: 400, body: { code: 'invalid_key_settings' } });
    const update = await answer(await updateKey(request('/api/keys/k', { method: 'PATCH', cookie, body: { name: ' ' } }), params('k')));
    expect(update).toMatchObject({ status: 400, body: { code: 'invalid_key_settings' } });
    const grace = await answer(await rotateKey(request('/api/keys/k/rotate', { method: 'POST', cookie, body: { gracePeriodSeconds: -1 } }), params('k')));
    expect(grace).toMatchObject({ status: 400, body: { code: 'invalid_grace_period' } });
  });

  it('answers a key it could not make with 500 key_create_failed and a fixed sentence', async () => {
    vi.spyOn(redisKeyStore, 'generateApiKey').mockRejectedValueOnce(new Error('connect ECONNREFUSED /var/run/redis.sock'));
    const { status, body } = await answer(await createKey(request('/api/keys', { method: 'POST', cookie: await sessionCookie(), body: {} })));
    expect({ status, code: body.code }).toEqual({ status: 500, code: 'key_create_failed' });
    expect(String(body.error)).not.toContain('ECONNREFUSED');
  });

  it('keeps a code only where the status cannot say the cause', () => {
    expect([...DASHBOARD_REFUSAL_CODES].sort()).toEqual(['admin_scope_required', 'invalid_grace_period', 'invalid_key_settings', 'key_create_failed']);
  });

  it('words each refusal by its code in the page language, with none of the English the route sent', async () => {
    const cookie = await sessionCookie();
    const refusals = [
      await answer(await listKeys(request('/api/keys'))),
      await answer(await deleteFile(request('/api/account/files/missing', { method: 'DELETE', cookie }), params('missing'))),
      await answer(await createKey(request('/api/keys', { method: 'POST', cookie, body: { scopes: ['admin'] } }))),
    ];
    expect(refusals.map(({ body, status }) => worded('ko', body, status))).toEqual([
      '계속하려면 로그인해 주세요.',
      '찾는 항목이 더 이상 없어요.',
      'API 키 설정을 확인해 주세요. 이름, 권한 범위, 주소 목록, 만료일 중 맞지 않는 값이 있어요.',
    ]);
    for (const { body, status } of refusals) expect(worded('en', body, status)).not.toContain(String(body.error));
  });

  it('has a sentence in both languages for every code of its closed list', () => {
    for (const locale of ['en', 'ko'] as const) {
      const sentences = testMessages(locale).errors.dashboard as Record<string, string>;
      expect(Object.keys(sentences).sort(), locale).toEqual([...DASHBOARD_REFUSAL_CODES].sort());
    }
  });
});
