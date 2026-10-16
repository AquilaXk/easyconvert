import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { UnsupportedDwgVersionError } from '../src/lib/types';

/**
 * A DWG release the reader does not decode is refused before the reader runs, with a 422 that names the release and the way
 * out; bytes that are no DWG at all are a 400. The routes, the batch route and a failed job answer with the typed error's status.
 * The inputs are file headers only: the refusal reads six bytes and never starts a program, so these tests need no reader.
 */

const HTTP_UNPROCESSABLE = 422;
const HTTP_BAD_REQUEST = 400;
const BASE_URL = 'http://localhost:3000';

/** A header as AutoCAD R12 writes it: the code `AC1009`, then zero bytes. */
const R12_DWG = Buffer.concat([Buffer.from('AC1009'), Buffer.alloc(300)]);
const NOT_A_DWG = Buffer.from('  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n');

function form(file: Buffer, name: string, fieldName = 'file'): FormData {
  const data = new FormData();
  data.append(fieldName, new Blob([new Uint8Array(file)]), name);
  data.append('targetFormat', 'svg');
  return data;
}

async function apiKeyHeaders(): Promise<Record<string, string>> {
  const user = await userStore.createUser({
    name: 'Dwg Route Tester',
    email: `dwg_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'Dwg key', { scopes: ['convert:write', 'convert:read'] });
  return { Authorization: `Bearer ${key.secretKey}` };
}

describe('a DWG release the reader does not decode answers 422', () => {
  it('POST /api/convert answers 422 with the release and the way out, and 400 for a file that is no DWG', async () => {
    const res = await convertPost(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: form(R12_DWG, 'old.dwg') }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    const problem = await res.json();
    expect(problem.title).toBe('Unprocessable Entity');
    expect(problem.detail).toMatch(/R11\/R12 \(AC1009\)/);
    expect(problem.detail).toMatch(/AutoCAD 2000 or newer/);

    const text = await convertPost(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: form(NOT_A_DWG, 'text.dwg') }));
    expect(text.status).toBe(HTTP_BAD_REQUEST);
    expect((await text.json()).error).toMatch(/not a DWG/i);
  });

  it('POST /api/v1/convert answers a 422 problem document', async () => {
    const headers = await apiKeyHeaders();
    const res = await v1ConvertPost(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers, body: form(R12_DWG, 'old.dwg') }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ status: HTTP_UNPROCESSABLE, title: 'Unprocessable Entity' });
  });

  it('POST /api/convert/batch answers 422', async () => {
    const body = form(R12_DWG, 'old.dwg', 'files');
    body.append('targetFormats', JSON.stringify({ default: 'svg' }));
    const res = await batchPost(new NextRequest(`${BASE_URL}/api/convert/batch`, { method: 'POST', body }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect((await res.json()).detail).toMatch(/AC1009/);
  });

  it('fails a queued job once, as a non-retryable 422', () => {
    expect(classifyJobFailure(new UnsupportedDwgVersionError('old', 'AC1009'))).toEqual({
      code: 'UnsupportedDwgVersionError',
      status: HTTP_UNPROCESSABLE,
      retryable: false,
    });
  });
});
