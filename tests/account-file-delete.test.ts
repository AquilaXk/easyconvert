import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as downloadRoute } from '../src/app/api/storage/file/[...key]/route';
import { GET as filesRoute } from '../src/app/api/account/files/route';
import { DELETE as deleteFileRoute } from '../src/app/api/account/files/[id]/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';
import { storageProvider } from '../src/lib/storage';
import { StorageServiceError } from '../src/lib/storage/adapters/adapter-interface';
import { FileRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import { registerResult, resultAvailability } from '../src/lib/storage/retention-service';
import { restoreIsolatedRetentionLedger } from './helpers/isolated-retention-ledger';

const BASE_URL = 'http://localhost:3000';
const BYTES = Buffer.from('0123456789', 'ascii');

let ledgerDir: string;
const storedKeys: string[] = [];

beforeEach(() => {
  ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-account-delete-'));
  setRetentionLedger(new FileRetentionLedger(ledgerDir));
});

afterEach(async () => {
  vi.restoreAllMocks();
  restoreIsolatedRetentionLedger();
  fs.rmSync(ledgerDir, { recursive: true, force: true });
  for (const key of storedKeys.splice(0)) await storageProvider.deleteObject(key);
});

async function createUser(label: string): Promise<User> {
  const email = `${label}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@delete.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

const asUser = (user: User) => ({ Cookie: `easyconvert_session=${createSessionToken(user)}` });

/** A stored conversion result of `user`, with the history record `/api/v1/convert` writes for it. */
async function convertedFile(user: User) {
  const key = `conversions/${user.id}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_result.bin`;
  await storageProvider.saveObject(key, BYTES, 'application/octet-stream', 'result.bin', 60 * 60 * 1000);
  await registerResult(key);
  storedKeys.push(key);
  const record = await redisKeyStore.recordUserFile({
    userId: user.id,
    fileName: 'result.bin',
    fromFormat: 'csv',
    toFormat: 'json',
    size: BYTES.length,
    downloadUrl: `/api/storage/file/${encodeURIComponent(key)}`,
    storageKey: key,
  });
  return { key, record };
}

function download(key: string, headers: Record<string, string>): Promise<Response> {
  const encoded = encodeURIComponent(key);
  return downloadRoute(new NextRequest(`${BASE_URL}/api/storage/file/${encoded}`, { headers }), { params: Promise.resolve({ key: [encoded] }) });
}

function remove(id: string, headers: Record<string, string>): Promise<Response> {
  return deleteFileRoute(new NextRequest(`${BASE_URL}/api/account/files/${id}`, { method: 'DELETE', headers }), { params: Promise.resolve({ id }) });
}

async function listedIds(user: User): Promise<string[]> {
  const res = await filesRoute(new NextRequest(`${BASE_URL}/api/account/files`, { headers: asUser(user) }));
  return (await res.json()).files.map((file: { id: string }) => file.id);
}

describe('deleting a converted file from the account', () => {
  it('removes the stored file too, so the download answers 404 and the file leaves the list', async () => {
    const user = await createUser('owner');
    const { key, record } = await convertedFile(user);
    expect((await download(key, asUser(user))).status).toBe(200);
    expect(await listedIds(user)).toContain(record.id);

    const res = await remove(record.id, asUser(user));

    expect(res.status).toBe(200);
    expect(await storageProvider.stat(key)).toBeNull();
    expect((await download(key, asUser(user))).status).toBe(404);
    expect(await resultAvailability(key)).toBeUndefined();
    expect(await listedIds(user)).not.toContain(record.id);
  });

  it('answers 404 to a repeat and to a file of another account, and leaves the owner\'s file in place', async () => {
    const owner = await createUser('owner');
    const stranger = await createUser('stranger');
    const { key, record } = await convertedFile(owner);

    expect((await remove(record.id, asUser(stranger))).status).toBe(404);
    expect((await download(key, asUser(owner))).status).toBe(200);

    expect((await remove(record.id, asUser(owner))).status).toBe(200);
    expect((await remove(record.id, asUser(owner))).status).toBe(404);
    expect((await download(key, asUser(owner))).status).toBe(404);
  });

  it('removes the record of a file the retention rule or the store already took away', async () => {
    const user = await createUser('already-gone');
    const { key, record } = await convertedFile(user);
    await storageProvider.deleteObject(key);

    const res = await remove(record.id, asUser(user));

    expect(res.status).toBe(200);
    expect(await listedIds(user)).not.toContain(record.id);
  });

  it('keeps the record when the store cannot delete the file, so the same request can be sent again', async () => {
    const user = await createUser('store-down');
    const { key, record } = await convertedFile(user);
    const deleteObject = vi.spyOn(storageProvider, 'deleteObject').mockImplementationOnce(() => {
      throw new StorageServiceError('storage down', 'test', { retryable: true });
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failed = await remove(record.id, asUser(user));
    expect(failed.status).toBe(503);
    expect(await listedIds(user)).toContain(record.id);
    expect((await download(key, asUser(user))).status).toBe(200);

    deleteObject.mockRestore();
    expect((await remove(record.id, asUser(user))).status).toBe(200);
    expect((await download(key, asUser(user))).status).toBe(404);
  });
});
