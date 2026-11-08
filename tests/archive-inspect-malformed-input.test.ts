import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as inspectArchiveRoute } from '../src/app/api/v1/archives/inspect/route';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';

const URL_OF_ROUTE = 'http://localhost:3000/api/v1/archives/inspect';

async function post(contentType: string, body: string): Promise<Response> {
  const email = `inspect_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@malformed.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'Inspector', tier: 'pro' }));
  return inspectArchiveRoute(
    new NextRequest(URL_OF_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Cookie: `easyconvert_session=${createSessionToken(user)}` },
      body,
    })
  );
}

describe('archive inspection of a body that cannot be read', () => {
  it('answers 400 for a multipart form that is not well formed, without the parser message', async () => {
    const res = await post('multipart/form-data; boundary=x', 'this is not a multipart body');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toBe('Invalid or malformed multipart/form-data body.');
  });

  it.each(['{not json', '', '[1, 2]', 'null'])('answers 400 for the JSON body %j', async (text) => {
    const res = await post('application/json', text);
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe('Invalid JSON request payload.');
  });
});
