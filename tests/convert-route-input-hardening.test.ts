import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';

const BASE_URL = 'http://localhost:3000';
const CSV = 'name,score\nAlice,100\nBob,95\n';

async function sessionCookie(): Promise<Record<string, string>> {
  const email = `harden_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@convert-hardening.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'Hardening', tier: 'paid', emailVerified: true }));
  return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
}

function csvFile(name: string): File {
  return new File([CSV], name, { type: 'text/csv' });
}

async function batch(targetFormats: string | undefined): Promise<Response> {
  const form = new FormData();
  form.append('files', csvFile('scores.csv'));
  if (targetFormats !== undefined) form.append('targetFormats', targetFormats);
  return batchPost(new NextRequest(`${BASE_URL}/api/convert/batch`, { method: 'POST', headers: await sessionCookie(), body: form }));
}

describe('the targetFormats field of a batch conversion', () => {
  it.each(['null', '[]', '["json"]', '5', '"json"', 'true', '{"scores.csv":5}', '{"default":null}', '{"scores.csv":["json"]}'])(
    'answers 400 for %s, which is not an object of strings',
    async (raw) => {
      const res = await batch(raw);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('targetFormats');
    }
  );

  it('answers 400 for text that is not JSON, as before', async () => {
    const res = await batch('{not json');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON for targetFormats map.');
  });

  it('takes the target of a file by its own name only, never from the prototype of the map', async () => {
    const form = new FormData();
    form.append('files', csvFile('constructor'));
    form.append('files', csvFile('scores.csv'));
    form.append('targetFormats', '{"scores.csv":"json"}');
    const res = await batchPost(new NextRequest(`${BASE_URL}/api/convert/batch`, { method: 'POST', headers: await sessionCookie(), body: form }));
    expect(res.status).not.toBe(500);
  });

  it('still converts with a map of strings, with none and with the default entry', async () => {
    for (const raw of ['{"scores.csv":"json"}', '{"default":"json"}', undefined]) {
      expect((await batch(raw)).status).toBe(200);
    }
  });
});

describe('the name that /api/v1/convert gives a stored result', () => {
  it('keeps one path leaf of the name the caller sent', async () => {
    const form = new FormData();
    form.append('file', csvFile('../../other-user/dir\\scores.csv'));
    form.append('targetFormat', 'json');
    const res = await v1ConvertPost(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers: await sessionCookie(), body: form }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fileName).toBe('scores.json');
    expect(decodeURIComponent(body.downloadUrl)).toMatch(/^\/api\/storage\/file\/conversions\/[^/]+\/\d+_scores\.json$/);
  });
});
