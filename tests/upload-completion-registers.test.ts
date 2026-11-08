import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { restoreIsolatedRetentionLedger } from './helpers/isolated-retention-ledger';
import { GET as downloadRoute } from '../src/app/api/storage/file/[...key]/route';
import { POST as uploadsPost } from '../src/app/api/v1/uploads/[[...id]]/route';
import { POST as tusPost, PATCH as tusPatch } from '../src/app/api/v1/uploads/[[...id]]/route';
import { PUT as directPartPut } from '../src/app/api/v1/uploads/direct/part/route';
import { POST as directPost } from '../src/app/api/v1/uploads/direct/route';
import { POST as directCompletePost } from '../src/app/api/v1/uploads/direct/complete/route';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';
import { storageProvider } from '../src/lib/storage';
import { getRetentionLedger, setRetentionLedger, type RetentionLedger } from '../src/lib/storage/retention-ledger';
import { holdResultForJob } from '../src/lib/storage/retention-service';
import { serializeTusMetadata } from '../src/lib/storage/tus-engine';

/**
 * A file an account uploaded is the account's own: a completion of any kind records it as an upload, so that the first
 * download does not register it as a one-time result (deleted a minute after it was sent) and a job that reads it holds it.
 */

const BASE_URL = 'http://localhost:3000';
const TEXT = Buffer.from('FIRST_PART_OF_THE_UPLOAD_SECOND_PART_OF_THE_UPLOAD');
const storedKeys: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  restoreIsolatedRetentionLedger();
  for (const key of storedKeys.splice(0)) await storageProvider.deleteObject(key);
});

async function createUser(label: string): Promise<User> {
  const email = `${label}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@completion.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

const asUser = (user: User) => ({ Cookie: `easyconvert_session=${createSessionToken(user)}` });

function stream(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function json(url: string, user: User, body: unknown): NextRequest {
  return new NextRequest(`${BASE_URL}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...asUser(user) }, body: JSON.stringify(body) });
}

async function download(key: string, user: User): Promise<Buffer> {
  const encoded = encodeURIComponent(key);
  const res = await downloadRoute(new NextRequest(`${BASE_URL}/api/storage/file/${encoded}`, { headers: asUser(user) }), { params: Promise.resolve({ key: [encoded] }) });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * What the record of a completed upload must be: an upload of the account (a key under `conversions/<userId>/`) or an
 * unclaimed upload (`uploads/`), never a result that a download delivers and deletes.
 */
async function expectRegisteredAsUpload(key: string, user: User, kind: 'account-upload' | 'upload'): Promise<void> {
  storedKeys.push(key);
  const ledger = getRetentionLedger();
  expect(await ledger.get(key)).toMatchObject({ key, kind });

  expect(await download(key, user)).toEqual(TEXT);
  const afterDownload = await ledger.get(key);
  expect(afterDownload?.kind).toBe(kind);
  expect(afterDownload?.deliveredAt).toBeUndefined();

  const holder = `job_${crypto.randomBytes(4).toString('hex')}`;
  expect(await holdResultForJob(key, holder)).toBe(true);
  expect(Object.keys((await ledger.get(key))?.holds ?? {})).toEqual([holder]);
}

describe('every completion of an upload records it', () => {
  it('registers a direct upload completed with POST /api/v1/uploads/direct/complete', async () => {
    const user = await createUser('direct');
    const init = await (await directPost(json('/api/v1/uploads/direct', user, { filename: 'direct.txt', mimeType: 'text/plain', totalSize: TEXT.length }))).json();
    const part = await directPartPut(new NextRequest(init.parts[0].uploadUrl, { method: 'PUT', body: stream(TEXT), duplex: 'half' } as never));
    expect(part.status).toBe(200);

    const done = await directCompletePost(json('/api/v1/uploads/direct/complete', user, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: (await part.json()).etag }] }));

    expect(done.status).toBe(200);
    await expectRegisteredAsUpload((await done.json()).key, user, 'account-upload');
  });

  it('registers a multipart upload completed with POST /api/v1/uploads?action=complete', async () => {
    const user = await createUser('action');
    const init = await (await uploadsPost(json('/api/v1/uploads?action=initiate', user, { filename: 'action.txt', mimeType: 'text/plain', totalSize: TEXT.length }), { params: Promise.resolve({}) })).json();
    const partRes = await uploadsPost(
      new NextRequest(`${BASE_URL}/api/v1/uploads?action=part&uploadId=${init.uploadId}&partNumber=1`, { method: 'POST', headers: asUser(user), body: stream(TEXT), duplex: 'half' } as never),
      { params: Promise.resolve({}) }
    );
    expect(partRes.status).toBe(200);
    const part = (await partRes.json()).part;

    const done = await uploadsPost(json('/api/v1/uploads?action=complete', user, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: part.etag }] }), { params: Promise.resolve({}) });

    expect(done.status).toBe(200);
    await expectRegisteredAsUpload((await done.json()).key, user, 'upload');
  });

  it('registers a tus upload completed by its last PATCH', async () => {
    const user = await createUser('tus-patch');
    const created = await tusPost(
      new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
        method: 'POST',
        headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(TEXT.length), 'Upload-Metadata': serializeTusMetadata({ filename: 'tus.txt', filetype: 'text/plain' }), ...asUser(user) },
      }),
      { params: Promise.resolve({}) }
    );
    expect(created.status).toBe(201);
    const id = created.headers.get('Location')!.split('/').pop()!;

    const done = await tusPatch(
      new NextRequest(`${BASE_URL}/api/v1/uploads/tus/${id}`, {
        method: 'PATCH',
        headers: { 'Tus-Resumable': '1.0.0', 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0', ...asUser(user) },
        body: stream(TEXT),
        duplex: 'half',
      } as never),
      { params: Promise.resolve({ id: [id] }) }
    );

    expect(done.status).toBe(204);
    await expectRegisteredAsUpload(done.headers.get('X-Storage-Key')!, user, 'account-upload');
  });

  it('registers a tus upload completed by the body of its creation', async () => {
    const user = await createUser('tus-create');
    const created = await tusPost(
      new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
        method: 'POST',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Length': String(TEXT.length),
          'Upload-Metadata': serializeTusMetadata({ filename: 'tus-create.txt', filetype: 'text/plain' }),
          ...asUser(user),
        },
        body: stream(TEXT),
        duplex: 'half',
      } as never),
      { params: Promise.resolve({}) }
    );

    expect(created.status).toBe(201);
    await expectRegisteredAsUpload(created.headers.get('X-Storage-Key')!, user, 'account-upload');
  });
});

describe('an upload whose record cannot be written', () => {
  function unreachableLedger(): RetentionLedger {
    const unreachable = async (): Promise<never> => {
      throw new Error('retention ledger unreachable');
    };
    return { get: unreachable, update: unreachable, forget: unreachable, collectDue: unreachable, liveRecords: unreachable };
  }

  it('is removed and refused with a 500 that names no internal error, as a direct completion', async () => {
    const user = await createUser('direct-unrecorded');
    const init = await (await directPost(json('/api/v1/uploads/direct', user, { filename: 'unrecorded.txt', mimeType: 'text/plain', totalSize: TEXT.length }))).json();
    const part = await directPartPut(new NextRequest(init.parts[0].uploadUrl, { method: 'PUT', body: stream(TEXT), duplex: 'half' } as never));
    const etag = (await part.json()).etag;
    setRetentionLedger(unreachableLedger());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const done = await directCompletePost(json('/api/v1/uploads/direct/complete', user, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag }] }));

    expect(done.status).toBe(500);
    const body = await done.json();
    expect(body.detail).toBe('The upload could not be recorded, so it cannot be converted. Upload the file again.');
    expect(JSON.stringify(body)).not.toContain('unreachable');
  });

  it('is removed and refused with a 503 when the last tus chunk completes it, and the client may send that chunk again', async () => {
    const user = await createUser('tus-unrecorded');
    const created = await tusPost(
      new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
        method: 'POST',
        headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(TEXT.length), 'Upload-Metadata': serializeTusMetadata({ filename: 'tus-unrecorded.txt', filetype: 'text/plain' }), ...asUser(user) },
      }),
      { params: Promise.resolve({}) }
    );
    const id = created.headers.get('Location')!.split('/').pop()!;
    const patch = () =>
      tusPatch(
        new NextRequest(`${BASE_URL}/api/v1/uploads/tus/${id}`, {
          method: 'PATCH',
          headers: { 'Tus-Resumable': '1.0.0', 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0', ...asUser(user) },
          body: stream(TEXT),
          duplex: 'half',
        } as never),
        { params: Promise.resolve({ id: [id] }) }
      );
    setRetentionLedger(unreachableLedger());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const refused = await patch();
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).not.toBeNull();
    expect(JSON.stringify(await refused.json())).not.toContain('unreachable');

    restoreIsolatedRetentionLedger();
    const retried = await patch();
    expect(retried.status).toBe(204);
    await expectRegisteredAsUpload(retried.headers.get('X-Storage-Key')!, user, 'account-upload');
  });

  it('refuses a staged tus file that is shorter than the upload declared, and stores and records nothing', async () => {
    const user = await createUser('tus-short');
    const head = TEXT.subarray(0, 10);
    const created = await tusPost(
      new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
        method: 'POST',
        headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(TEXT.length), 'Upload-Metadata': serializeTusMetadata({ filename: 'tus-short.txt', filetype: 'text/plain' }), ...asUser(user) },
      }),
      { params: Promise.resolve({}) }
    );
    const id = created.headers.get('Location')!.split('/').pop()!;
    const patch = (offset: number, bytes: Buffer) =>
      tusPatch(
        new NextRequest(`${BASE_URL}/api/v1/uploads/tus/${id}`, {
          method: 'PATCH',
          headers: { 'Tus-Resumable': '1.0.0', 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset), ...asUser(user) },
          body: stream(bytes),
          duplex: 'half',
        } as never),
        { params: Promise.resolve({ id: [id] }) }
      );
    expect((await patch(0, head)).status).toBe(204);
    const staged = path.resolve(process.env.EASYCONVERT_STORAGE_DIR || path.resolve(process.cwd(), '.easyconvert/storage'), 'tus', `${id}.bin`);
    fs.rmSync(staged);

    const refused = await patch(head.length, TEXT.subarray(head.length));

    expect(refused.status).toBe(400);
    expect(refused.headers.get('X-Storage-Key')).toBeNull();
    const key = `conversions/${user.id}/${id}_tus-short.txt`;
    expect(await storageProvider.stat(key)).toBeNull();
    expect(await getRetentionLedger().get(key)).toBeUndefined();
  });
});
