import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { POST as jobsRoute } from '../src/app/api/v1/jobs/route';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { User } from '../src/lib/auth/types';

describe('Security: Error Path Disclosure Prevention', () => {
  let testUser: User;
  let secretKey: string;
  const createdKeys: string[] = [];

  beforeEach(async () => {
    testUser = await userStore.createUser({
      name: 'Path Leak Tester',
      email: `path_leak_${Date.now()}_${Math.random().toString(36).substring(7)}@test.com`,
      tier: 'pro',
    });
    const keyResult = await redisKeyStore.generateApiKey(testUser.id, 'Path Leak Key', {
      scopes: ['convert:write'],
    });
    secretKey = keyResult.secretKey;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of createdKeys.splice(0)) {
      s3Storage.deleteObject(key);
    }
  });

  it('does not leak disk path in error response when stored file is missing from disk', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 1. Create a multipart upload belonging to testUser
    const init = s3Storage.initiateMultipartUpload(
      'document.pdf',
      'application/pdf',
      1024,
      testUser.id
    );
    s3Storage.uploadPart(init.uploadId, 1, Buffer.from('%PDF-1.4 test content payload'));
    const complete = s3Storage.completeMultipartUpload(init.uploadId);
    createdKeys.push(complete.key);

    const stored = s3Storage.getObject(complete.key);
    expect(stored).toBeDefined();
    expect(stored?.filePath).toBeDefined();
    const diskPath = stored!.filePath!;
    expect(fs.existsSync(diskPath)).toBe(true);

    // 2. Delete the physical file from disk to simulate missing disk file
    fs.unlinkSync(diskPath);
    expect(fs.existsSync(diskPath)).toBe(false);

    // 3. Request a job with the storage key
    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secretKey}`,
      },
      body: JSON.stringify({
        storageKey: complete.key,
        targetFormat: 'docx',
      }),
    });

    const res = await jobsRoute(req);
    expect(res.status).toBe(400);

    const rawBody = await res.text();
    const json = JSON.parse(rawBody);

    // 4. Assert generic safe error message
    expect(json.detail).toBe('Stored object is unavailable.');

    // 5. Assert disk paths, tmpdir, and system directories are NOT disclosed
    expect(rawBody).not.toContain(diskPath);
    expect(rawBody).not.toContain(os.tmpdir());
    expect(rawBody).not.toMatch(/\/Volumes|\/Users|\/tmp\/|\/var\//);

    // 6. Assert the actual disk path was logged securely to server console.error
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Storage file missing on disk: "${diskPath}"`)
    );
  });

  it('does not leak disk path in error response when stored path is a directory instead of a regular file', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Create a stored object whose filePath points to a directory
    const init = s3Storage.initiateMultipartUpload(
      'directory_spoof.pdf',
      'application/pdf',
      1024,
      testUser.id
    );
    s3Storage.uploadPart(init.uploadId, 1, Buffer.from('%PDF-1.4 test content payload'));
    const complete = s3Storage.completeMultipartUpload(init.uploadId);
    createdKeys.push(complete.key);

    const stored = s3Storage.getObject(complete.key)!;
    const diskPath = stored.filePath!;
    fs.unlinkSync(diskPath);
    fs.mkdirSync(diskPath);

    try {
      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secretKey}`,
        },
        body: JSON.stringify({
          storageKey: complete.key,
          targetFormat: 'docx',
        }),
      });

      const res = await jobsRoute(req);
      expect(res.status).toBe(400);

      const rawBody = await res.text();
      const json = JSON.parse(rawBody);

      expect(json.detail).toBe('Stored object is unavailable.');
      expect(rawBody).not.toContain(diskPath);
      expect(rawBody).not.toContain(os.tmpdir());
      expect(rawBody).not.toMatch(/\/Volumes|\/Users|\/tmp\/|\/var\//);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Target path is not a regular file: "${diskPath}"`)
      );
    } finally {
      if (fs.existsSync(diskPath)) {
        fs.rmdirSync(diskPath);
      }
    }
  });

  it('does not leak disk path in multipart complete error when part file is missing on disk', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sessionToken = createSessionToken(testUser);

    // 1. Initiate multipart upload
    const initReq = new NextRequest('http://localhost:3000/api/storage/multipart?action=initiate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `easyconvert_session=${sessionToken}`,
      },
      body: JSON.stringify({ filename: 'assembly_leak.bin', totalSize: 2048 }),
    });
    const initRes = await multipartPost(initReq);
    expect(initRes.status).toBe(200);
    const { uploadId } = await initRes.json();

    // 2. Upload part 1
    const chunkReq = new NextRequest('http://localhost:3000/api/storage/multipart?action=chunk', {
      method: 'POST',
      headers: {
        Cookie: `easyconvert_session=${sessionToken}`,
        'x-upload-id': uploadId,
        'x-part-number': '1',
      },
      body: Buffer.from('chunk-data'),
    });
    const chunkRes = await multipartPost(chunkReq);
    expect(chunkRes.status).toBe(200);

    // 3. Delete part file from disk
    const session = s3Storage.getUploadSession(uploadId)!;
    const part1Info = session.parts.get(1)!;
    fs.unlinkSync(part1Info.filePath);

    // 4. Complete multipart upload
    const completeReq = new NextRequest('http://localhost:3000/api/storage/multipart?action=complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `easyconvert_session=${sessionToken}`,
      },
      body: JSON.stringify({ uploadId }),
    });
    const completeRes = await multipartPost(completeReq);
    expect(completeRes.status).toBe(500);

    const rawBody = await completeRes.text();
    expect(rawBody).not.toContain(part1Info.filePath);
    expect(rawBody).not.toContain(os.tmpdir());
    expect(rawBody).not.toMatch(/\/Volumes|\/Users|\/tmp\/|\/var\//);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Part file missing on disk: "${part1Info.filePath}"`)
    );

    s3Storage.abortMultipartUpload(uploadId);
  });
});
