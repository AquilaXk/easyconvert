import { createElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { userStore } from '../src/lib/auth/user-store';
import { keyStore } from '../src/lib/api-keys/key-store';
import { createSessionToken } from '../src/lib/auth/session';
import { GET as listKeys, POST as createKey } from '../src/app/api/keys/route';
import { DELETE as revokeKey } from '../src/app/api/keys/[id]/route';
import { POST as rotateKey } from '../src/app/api/keys/[id]/rotate/route';
import { GET as keyUsage } from '../src/app/api/keys/usage/route';
import { GET as listFiles } from '../src/app/api/account/files/route';
import { DELETE as deleteFile } from '../src/app/api/account/files/[id]/route';
import { DELETE as clearDlq } from '../src/app/api/webhooks/dlq/route';
import { DELETE as deleteDlq } from '../src/app/api/webhooks/dlq/[id]/route';
import { POST as replayDlq } from '../src/app/api/webhooks/dlq/[id]/replay/route';
import { useDashboardErrorWording } from '../src/components/i18n/error-wording';
import { DASHBOARD_REFUSAL_CODES } from '../src/lib/refusal-codes';
import { renderDom, visibleText } from './helpers/rendered-dom';
import { testMessages, type TestLocale } from './helpers/intl-messages';

/**
 * The dashboard routes name each refusal with a code of their closed list, next to the English `error` API callers read, and
 * the dashboard words the code in the page's language without the server's text.
 */

const ORIGIN = 'http://localhost:3000';
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function sessionCookie(): Promise<string> {
  const user = userStore.sanitizeUser(await userStore.createUser({ email: 'owner@example.com', name: 'Owner' }));
  return `easyconvert_session=${createSessionToken(user)}`;
}

function request(path: string, init: { method?: string; cookie?: string; body?: unknown } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers: init.cookie ? { Cookie: init.cookie, Origin: ORIGIN } : { Origin: ORIGIN },
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

describe('a dashboard route', () => {
  it.each([
    ['GET /api/keys', () => listKeys(request('/api/keys'))],
    ['POST /api/keys', () => createKey(request('/api/keys', { method: 'POST', body: {} }))],
    ['DELETE /api/keys/k', () => revokeKey(request('/api/keys/k', { method: 'DELETE' }), params('k'))],
    ['POST /api/keys/k/rotate', () => rotateKey(request('/api/keys/k/rotate', { method: 'POST', body: {} }), params('k'))],
    ['GET /api/keys/usage', () => keyUsage(request('/api/keys/usage'))],
    ['GET /api/account/files', () => listFiles(request('/api/account/files'))],
    ['DELETE /api/account/files/f', () => deleteFile(request('/api/account/files/f', { method: 'DELETE' }), params('f'))],
    ['DELETE /api/webhooks/dlq', () => clearDlq(request('/api/webhooks/dlq', { method: 'DELETE' }))],
    ['DELETE /api/webhooks/dlq/d', () => deleteDlq(request('/api/webhooks/dlq/d', { method: 'DELETE' }), params('d'))],
    ['POST /api/webhooks/dlq/d/replay', () => replayDlq(request('/api/webhooks/dlq/d/replay', { method: 'POST' }), params('d'))],
  ])('%s refuses a caller without a session or key with 401 sign_in_required', async (_route, call) => {
    const { status, body } = await answer(await call());
    expect(status).toBe(401);
    expect(body).toMatchObject({ success: false, code: 'sign_in_required' });
    expect(typeof body.error).toBe('string');
  });

  it.each([
    ['DELETE /api/keys/missing', (cookie: string) => revokeKey(request('/api/keys/missing', { method: 'DELETE', cookie }), params('missing'))],
    ['DELETE /api/account/files/missing', (cookie: string) => deleteFile(request('/api/account/files/missing', { method: 'DELETE', cookie }), params('missing'))],
    ['DELETE /api/webhooks/dlq/missing', (cookie: string) => deleteDlq(request('/api/webhooks/dlq/missing', { method: 'DELETE', cookie }), params('missing'))],
    ['POST /api/keys/missing/rotate', (cookie: string) => rotateKey(request('/api/keys/missing/rotate', { method: 'POST', cookie, body: {} }), params('missing'))],
  ])('%s answers an unknown id with 404 not_found', async (_route, call) => {
    const { status, body } = await answer(await call(await sessionCookie()));
    expect(status).toBe(404);
    expect(body).toMatchObject({ success: false, code: 'not_found' });
  });

  it('refuses key settings it cannot take with 400 invalid_key_settings, and a grace period out of range with invalid_grace_period', async () => {
    const cookie = await sessionCookie();
    const settings = await answer(await createKey(request('/api/keys', { method: 'POST', cookie, body: { scopes: ['admin'] } })));
    expect(settings).toMatchObject({ status: 400, body: { code: 'invalid_key_settings' } });
    const grace = await answer(await rotateKey(request('/api/keys/k/rotate', { method: 'POST', cookie, body: { gracePeriodSeconds: -1 } }), params('k')));
    expect(grace).toMatchObject({ status: 400, body: { code: 'invalid_grace_period' } });
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
