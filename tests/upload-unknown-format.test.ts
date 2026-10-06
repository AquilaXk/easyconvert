import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST as directPostHandler } from '../src/app/api/v1/uploads/direct/route';
import { PUT as directPartPutHandler } from '../src/app/api/v1/uploads/direct/part/route';
import { POST as directCompletePostHandler } from '../src/app/api/v1/uploads/direct/complete/route';
import {
  POST as tusPostHandler,
  PATCH as tusPatchHandler,
} from '../src/app/api/v1/uploads/[[...id]]/route';
import { serializeTusMetadata } from '../src/lib/storage/tus-engine';
import { UnknownDeclaredFormatError, resolveDeclaredFormat } from '../src/lib/storage/declared-format';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import type { User } from '../src/lib/auth/types';

/**
 * Regression tests for issue #483: tus and direct-complete declared the format "bin" for an
 * upload whose name and content type name no format, so any bytes passed the magic-byte check.
 */

const BASE_URL = 'http://localhost:3000';

describe('Unknown upload format is a typed 400 (#483)', () => {
  let user: User;

  beforeEach(async () => {
    const email = `regress_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@storage-regression.local`;
    user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'regress', tier: 'pro' }));
  });

  function cookie(): Record<string, string> {
    return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
  }

  it('rejects direct-complete with a typed 400 when neither the name nor the MIME type names a format', async () => {
    const payload = Buffer.from('plain bytes without any declared format');
    const initRes = await directPostHandler(
      new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie() },
        body: JSON.stringify({ filename: 'no-extension-here', totalSize: payload.length, partSize: payload.length }),
      })
    );
    expect(initRes.status).toBe(200);
    const init = await initRes.json();

    const partRes = await directPartPutHandler(
      new NextRequest(init.parts[0].uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: payload,
        duplex: 'half',
      } as never)
    );
    expect(partRes.status).toBe(200);
    const part = await partRes.json();

    const completeRes = await directCompletePostHandler(
      new NextRequest(`${BASE_URL}/api/v1/uploads/direct/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie() },
        body: JSON.stringify({ uploadId: init.uploadId, parts: [{ partNumber: 1, etag: part.etag }] }),
      })
    );
    expect(completeRes.status).toBe(400);
    const problem = await completeRes.json();
    expect(problem.type).toBe('https://api.easyconvert.io/problems/unknown-format');
    expect(problem.detail).toContain('no-extension-here');
  });

  it('rejects the final TUS chunk with a typed 400 when neither the name nor the MIME type names a format', async () => {
    const payload = Buffer.from('plain bytes without any declared format');
    const createRes = await tusPostHandler(
      new NextRequest(`${BASE_URL}/api/v1/uploads`, {
        method: 'POST',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(payload.length),
          'Upload-Metadata': serializeTusMetadata({ filename: 'no-extension-here' }),
          ...cookie(),
        },
      }),
      { params: Promise.resolve({}) }
    );
    expect(createRes.status).toBe(201);
    const sessionId = createRes.headers.get('Location')!.split('/').pop()!;

    const patchRes = await tusPatchHandler(
      new NextRequest(`${BASE_URL}/api/v1/uploads/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': '0',
          ...cookie(),
        },
        body: payload,
        duplex: 'half',
      } as never),
      { params: { id: [sessionId] } }
    );
    expect(patchRes.status).toBe(400);
    const problem = await patchRes.json();
    expect(problem.type).toBe('https://api.easyconvert.io/problems/unknown-format');
    expect(patchRes.headers.get('EasyConvert-Storage-Key')).toBeNull();
  });
});

describe('resolveDeclaredFormat', () => {
  it.each([
    ['report.pdf', undefined, 'pdf'],
    ['Photo.JPG', 'application/octet-stream', 'jpg'],
    ['archive.v2.zip', '', 'zip'],
    ['avatar-image', 'image/png', 'png'],
    ['no-extension', 'application/pdf; charset=binary', 'pdf'],
    ['weird.ext', 'application/pdf', 'pdf'],
    [undefined, 'image/png', 'png'],
  ])('resolves %s with content type %s to the registered format %s', (filename, mimeType, expected) => {
    expect(resolveDeclaredFormat(filename, mimeType)).toBe(expected);
  });

  it.each([
    ['no-extension', undefined],
    ['no-extension', ''],
    ['no-extension', 'application/octet-stream'],
    ['weird.ext', 'application/octet-stream'],
    ['weird.ext', 'application/x-not-a-registered-type'],
    [undefined, undefined],
    ['.hidden', 'text/'],
  ])('refuses %s with content type %s instead of declaring "bin"', (filename, mimeType) => {
    const error = (() => {
      try {
        return resolveDeclaredFormat(filename, mimeType);
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(UnknownDeclaredFormatError);
    expect((error as UnknownDeclaredFormatError).statusCode).toBe(400);
    expect((error as UnknownDeclaredFormatError).code).toBe('UNKNOWN_DECLARED_FORMAT');
  });
});
