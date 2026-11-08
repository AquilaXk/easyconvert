import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';

/**
 * A tus upload to an object store is finished from a staged file. The staged file stays until the upload is recorded, so
 * the client that is told to send its last chunk again appends to the whole file, and an upload whose staged size is not the
 * declared length is refused: a truncated object is never stored as complete.
 */

const BUCKET = 'internal-objects';
const REGION = 'ap-seoul-1';
const ACCESS_KEY = 'AKIAOCIEXAMPLE0000001';
const SECRET = 'oci/Secret+Key/EXAMPLEKEY000000000000000';
const BASE_URL = 'http://localhost:3000';
const FIRST = Buffer.from('FIRST_CHUNK_OF_THE_TUS_UPLOAD_');
const SECOND = Buffer.from('MIDDLE_CHUNK_OF_THE_TUS_UPLOAD_');
const LAST = Buffer.from('LAST_CHUNK_OF_THE_TUS_UPLOAD');
const WHOLE = Buffer.concat([FIRST, SECOND, LAST]);
const HTTP_UNAVAILABLE = 503;

describe('a tus upload to an object store whose record cannot be written', () => {
  let server: S3StubServer;
  let tusDir: string;
  let ledgerDir: string;

  beforeAll(async () => {
    server = await startS3StubServer({ bucket: BUCKET, credentials: { [ACCESS_KEY]: SECRET } });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.objects.clear();
    server.uploads.clear();
    tusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-remote-'));
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-ledger-'));
    vi.stubEnv('STORAGE_DRIVER', 'oci');
    vi.stubEnv('OCI_NAMESPACE', 'axyz123namespace');
    vi.stubEnv('OCI_REGION', REGION);
    vi.stubEnv('OCI_BUCKET', BUCKET);
    vi.stubEnv('OCI_ACCESS_KEY_ID', ACCESS_KEY);
    vi.stubEnv('OCI_SECRET_ACCESS_KEY', SECRET);
    vi.stubEnv('OCI_ENDPOINT', server.url);
    vi.stubEnv('STORAGE_SIGNING_SECRET', 'tus-remote-test-signing-secret-0001');
    vi.stubEnv('EASYCONVERT_STORAGE_DIR', tusDir);
    vi.stubEnv('APP_URL', BASE_URL);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tusDir, { recursive: true, force: true });
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  });

  async function start() {
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const { serializeTusMetadata } = await import('../src/lib/storage/tus-engine');
    const { POST, PATCH, HEAD } = await import('../src/app/api/v1/uploads/[[...id]]/route');
    const email = `tus_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@tus-remote.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'tus', tier: 'pro' }));
    const headers = { 'Tus-Resumable': '1.0.0', Cookie: `easyconvert_session=${createSessionToken(user)}` };
    const created = await POST(
      new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
        method: 'POST',
        headers: { ...headers, 'Upload-Length': String(WHOLE.length), 'Upload-Metadata': serializeTusMetadata({ filename: 'whole.txt', filetype: 'text/plain' }) },
      }),
      { params: Promise.resolve({}) }
    );
    expect(created.status).toBe(201);
    const id = created.headers.get('Location')!.split('/').pop()!;
    const patch = (offset: number, chunk: Buffer) =>
      PATCH(
        new NextRequest(`${BASE_URL}/api/v1/uploads/tus/${id}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.close();
            },
          }),
          duplex: 'half',
        } as never),
        { params: Promise.resolve({ id: [id] }) }
      );
    const offset = async () =>
      Number((await HEAD(new NextRequest(`${BASE_URL}/api/v1/uploads/tus/${id}`, { method: 'HEAD', headers }), { params: Promise.resolve({ id: [id] }) })).headers.get('Upload-Offset'));
    return { id, patch, offset };
  }

  /** A ledger that refuses its first `failures` writes, as a Redis that is down for a moment does. */
  async function failingLedger(failures: number) {
    const { FileRetentionLedger, setRetentionLedger } = await import('../src/lib/storage/retention-ledger');
    const real = new FileRetentionLedger(ledgerDir);
    let left = failures;
    setRetentionLedger({
      get: real.get.bind(real),
      forget: real.forget.bind(real),
      collectDue: real.collectDue.bind(real),
      liveRecords: real.liveRecords.bind(real),
      update: (async (...args: Parameters<typeof real.update>) => {
        if (left-- > 0) throw new Error('retention ledger unreachable');
        return real.update(...args);
      }) as typeof real.update,
    });
  }

  it('keeps the staged file, so the last chunk sent again completes the whole upload and not only that chunk', async () => {
    await failingLedger(1);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tus = await start();
    expect((await tus.patch(0, FIRST)).status).toBe(204);
    expect((await tus.patch(FIRST.length, SECOND)).status).toBe(204);
    const offsetBefore = FIRST.length + SECOND.length;

    const refused = await tus.patch(offsetBefore, LAST);
    expect(refused.status).toBe(HTTP_UNAVAILABLE);
    expect(server.objects.size).toBe(0);
    expect(await tus.offset()).toBe(offsetBefore);

    const resent = await tus.patch(offsetBefore, LAST);
    expect(resent.status).toBe(204);
    const key = resent.headers.get('X-Storage-Key')!;
    expect(server.objects.get(key)?.body.equals(WHOLE)).toBe(true);
    expect(fs.readdirSync(path.join(tusDir, 'tus')).some((name) => name.endsWith('.bin') && name.startsWith('tus_'))).toBe(false);
  });

  it('refuses a staged file whose size is not the declared length, and stores nothing', async () => {
    const tus = await start();
    expect((await tus.patch(0, FIRST)).status).toBe(204);
    const staged = fs.readdirSync(path.join(tusDir, 'tus')).find((name) => name.endsWith('.bin'))!;
    fs.rmSync(path.join(tusDir, 'tus', staged));

    const refused = await tus.patch(FIRST.length, Buffer.concat([SECOND, LAST]));

    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.headers.get('X-Storage-Key')).toBeNull();
    expect(server.objects.size).toBe(0);
  });
});
