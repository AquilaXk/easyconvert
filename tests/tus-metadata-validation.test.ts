import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

/**
 * A tus upload's declared content type becomes the stored object's Content-Type header, so it is
 * checked when the session is created: a value that is not printable ASCII (or is empty, or longer
 * than a header value may reasonably be) is refused with a 400 before any byte is accepted.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const MAX_MIME_TYPE_LENGTH = 255;
const OVERLONG_MIME_TYPE_LENGTH = 300_000;
const PNG_LENGTH = 67;

describe('tus session creation validates the declared content type', () => {
  let tusDir: string;

  beforeEach(() => {
    tusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-metadata-'));
    vi.stubEnv('STORAGE_DRIVER', 'local');
    vi.stubEnv('EASYCONVERT_STORAGE_DIR', tusDir);
    vi.stubEnv('STORAGE_SIGNING_SECRET', 'tus-metadata-test-signing-secret-0001');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tusDir, { recursive: true, force: true });
  });

  async function createSession(metadata: Record<string, string>) {
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const { serializeTusMetadata } = await import('../src/lib/storage/tus-engine');
    const { POST } = await import('../src/app/api/v1/uploads/[[...id]]/route');
    const user = userStore.sanitizeUser(
      await userStore.createUser({ email: `tus_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@tus-metadata.local`, name: 'tus', tier: 'pro' })
    );
    return POST(
      new NextRequest(`${BASE_URL}/api/v1/uploads`, {
        method: 'POST',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(PNG_LENGTH),
          'Upload-Metadata': serializeTusMetadata(metadata),
          Cookie: `easyconvert_session=${createSessionToken(user)}`,
        },
      }),
      { params: Promise.resolve({}) }
    );
  }

  const refused: Array<[string, string]> = [
    ['a non-ASCII character', 'image/pngé'],
    ['a header-injecting line break', 'image/png\r\nX-Evil: 1'],
    ['a control character', 'image/png\u0000'],
    ['more characters than a header value may hold', 'x'.repeat(OVERLONG_MIME_TYPE_LENGTH)],
    ['one character too many', 'a'.repeat(MAX_MIME_TYPE_LENGTH + 1)],
  ];

  for (const [label, filetype] of refused) {
    it(`refuses a filetype with ${label}`, async () => {
      const res = await createSession({ filename: 'pic.png', filetype });
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      expect(res.headers.get('Content-Type')).toBe('application/problem+json');
      expect(res.headers.get('Tus-Resumable')).toBe('1.0.0');
      expect(res.headers.get('Location')).toBeNull();
      expect((await res.json()).detail).toContain('printable ASCII content type');
    });
  }

  it('treats an empty filetype entry as absent', async () => {
    const res = await createSession({ filename: 'pic.png', filetype: '' });
    expect(res.status).toBe(HTTP_CREATED);
  });

  it('accepts a printable ASCII filetype of the longest allowed length and a missing one', async () => {
    const longest = await createSession({ filename: 'pic.png', filetype: `application/${'a'.repeat(MAX_MIME_TYPE_LENGTH - 'application/'.length)}` });
    expect(longest.status).toBe(HTTP_CREATED);
    const plain = await createSession({ filename: 'pic.png', filetype: 'image/png' });
    expect(plain.status).toBe(HTTP_CREATED);
    const missing = await createSession({ filename: 'pic.png' });
    expect(missing.status).toBe(HTTP_CREATED);
  });
});
