import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

/**
 * TUS 1.0.0 expiration extension: an upload past its `Upload-Expires` time is gone. The server answers
 * 404 to HEAD and PATCH and removes the staged parts (`<id>.bin` data and `<id>.info` session record).
 * The wall clock is advanced with fake timers (Date only), so the engine's own expiry check runs unmodified.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const MS_PER_SECOND = 1000;
/** The engine's default session lifetime: 24 hours. */
const DEFAULT_TTL_SECONDS = 86_400;
/** HTTP-date headers carry whole seconds; stay clear of the truncated second on either side. */
const CLOCK_MARGIN_MS = 2 * MS_PER_SECOND;
const FIRST_PART = Buffer.from('PART-ONE-0123456');
const SECOND_PART = Buffer.from('PART-TWO-0123456');
const UPLOAD_LENGTH = FIRST_PART.length + SECOND_PART.length;

describe('TUS expiration extension', () => {
  let storageDir: string;
  let tusDir: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-expiry-'));
    tusDir = path.join(storageDir, 'tus');
    vi.stubEnv('STORAGE_DRIVER', 'local');
    vi.stubEnv('EASYCONVERT_STORAGE_DIR', storageDir);
    vi.stubEnv('STORAGE_SIGNING_SECRET', 'tus-expiry-test-signing-secret-0001');
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function startUpload() {
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const { serializeTusMetadata } = await import('../src/lib/storage/tus-engine');
    const handlers = await import('../src/app/api/v1/uploads/[[...id]]/route');
    const user = userStore.sanitizeUser(
      await userStore.createUser({
        email: `tus_expiry_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@tus-expiry.local`,
        name: 'tus expiry',
        tier: 'pro',
      })
    );
    const auth = { Cookie: `easyconvert_session=${createSessionToken(user)}` };

    const created = await handlers.POST(
      new NextRequest(`${BASE_URL}/api/v1/uploads`, {
        method: 'POST',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(UPLOAD_LENGTH),
          'Upload-Metadata': serializeTusMetadata({ filename: 'expiring.txt', filetype: 'text/plain' }),
          ...auth,
        },
      }),
      { params: Promise.resolve({}) }
    );
    expect(created.status).toBe(HTTP_CREATED);
    const location = created.headers.get('Location');
    expect(location).toMatch(/^\/api\/v1\/uploads\/[a-zA-Z0-9_-]+$/);
    const id = (location as string).split('/').pop() as string;
    const expiresHeader = created.headers.get('Upload-Expires');
    expect(expiresHeader).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    const expiresAtMs = Date.parse(expiresHeader as string);

    const patch = (offset: number, body: Buffer) =>
      handlers.PATCH(
        new NextRequest(`${BASE_URL}${location}`, {
          method: 'PATCH',
          headers: {
            'Tus-Resumable': '1.0.0',
            'Content-Type': 'application/offset+octet-stream',
            'Upload-Offset': String(offset),
            ...auth,
          },
          body: new Uint8Array(body),
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }),
        { params: Promise.resolve({ id: [id] }) }
      );
    const head = () =>
      handlers.HEAD(
        new NextRequest(`${BASE_URL}${location}`, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0', ...auth } }),
        { params: Promise.resolve({ id: [id] }) }
      );
    return { id, expiresAtMs, patch, head };
  }

  const stagedParts = (id: string) => [path.join(tusDir, `${id}.bin`), path.join(tusDir, `${id}.info`)];

  it('advertises an Upload-Expires time exactly one default lifetime after creation', async () => {
    const before = Date.now();
    const { expiresAtMs } = await startUpload();
    const after = Date.now();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + DEFAULT_TTL_SECONDS * MS_PER_SECOND - MS_PER_SECOND);
    expect(expiresAtMs).toBeLessThanOrEqual(after + DEFAULT_TTL_SECONDS * MS_PER_SECOND);
  });

  it('keeps serving HEAD and PATCH until Upload-Expires and still holds the staged parts', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const upload = await startUpload();
    expect((await upload.patch(0, FIRST_PART)).status).toBe(HTTP_NO_CONTENT);

    vi.setSystemTime(upload.expiresAtMs - CLOCK_MARGIN_MS);
    const head = await upload.head();
    expect(head.status).toBe(HTTP_OK);
    expect(head.headers.get('Upload-Offset')).toBe(String(FIRST_PART.length));
    expect(fs.readFileSync(path.join(tusDir, `${upload.id}.bin`))).toEqual(FIRST_PART);

    const resumed = await upload.patch(FIRST_PART.length, SECOND_PART);
    expect(resumed.status).toBe(HTTP_NO_CONTENT);
    expect(resumed.headers.get('Upload-Offset')).toBe(String(UPLOAD_LENGTH));
  });

  it('answers HEAD with 404 after expiry and removes the staged parts', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const upload = await startUpload();
    expect((await upload.patch(0, FIRST_PART)).status).toBe(HTTP_NO_CONTENT);
    for (const part of stagedParts(upload.id)) expect(fs.existsSync(part), part).toBe(true);

    vi.setSystemTime(upload.expiresAtMs + CLOCK_MARGIN_MS);
    const head = await upload.head();
    expect(head.status).toBe(HTTP_NOT_FOUND);
    expect(head.headers.get('Upload-Offset')).toBeNull();
    for (const part of stagedParts(upload.id)) expect(fs.existsSync(part), part).toBe(false);
  });

  it('answers PATCH with 404 after expiry, accepts no bytes and removes the staged parts', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const upload = await startUpload();
    expect((await upload.patch(0, FIRST_PART)).status).toBe(HTTP_NO_CONTENT);

    vi.setSystemTime(upload.expiresAtMs + CLOCK_MARGIN_MS);
    const resumed = await upload.patch(FIRST_PART.length, SECOND_PART);
    expect(resumed.status).toBe(HTTP_NOT_FOUND);
    expect(resumed.headers.get('Upload-Offset')).toBeNull();
    for (const part of stagedParts(upload.id)) expect(fs.existsSync(part), part).toBe(false);

    // The upload stays gone: a later HEAD cannot resurrect it from a leftover record.
    expect((await upload.head()).status).toBe(HTTP_NOT_FOUND);
  });
});
