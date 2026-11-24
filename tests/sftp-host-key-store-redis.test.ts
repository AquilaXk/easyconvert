import crypto from 'node:crypto';
import dns from 'node:dns';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SFTP_DEV_ENDPOINT_ALLOWLIST_ENV, SftpStorageAdapter } from '../src/lib/storage/adapters/sftp';
import {
  SFTP_TOFU_REDIS_PREFIX,
  SFTP_TOFU_TTL_SECONDS,
  getPersistedSftpHostKey,
  persistSftpHostKeyFirstUse,
  resetSftpHostKeyStoreForTests,
} from '../src/lib/storage/adapters/sftp-host-key-store';
import { StorageAdapterError, StorageAuthenticationError } from '../src/lib/storage/adapters/adapter-interface';
import { startSftpStub, type SftpStub } from './helpers/sftp-stub-server';

/**
 * Verifies real Redis-backed SFTP TOFU host key persistence (`SET ... EX 31536000 NX`),
 * concurrent first-use conflict refusal, and fail-closed rejection of corrupt entries.
 */

const REDIS_URL = process.env.REDIS_URL;
const BASE_PATH = '/data';

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// skip-ok: mode selection. Standard shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('Redis-backed SFTP TOFU host key persistence', () => {
  let probe: Redis;
  let stub: SftpStub;
  const keysToDelete: string[] = [];

  beforeAll(async () => {
    probe = new Redis(REDIS_URL as string);
    stub = await startSftpStub();
  });

  beforeEach(async () => {
    await resetSftpHostKeyStoreForTests();
    stub.files.clear();
    stub.directories.clear();
    stub.directories.add(BASE_PATH);
    stub.directories.add(`${BASE_PATH}/reports`);
    vi.stubEnv('NODE_ENV', 'development');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await resetSftpHostKeyStoreForTests();
    if (keysToDelete.length > 0) {
      await probe.del(...keysToDelete.splice(0));
    }
  });

  afterAll(async () => {
    await stub.close();
    await probe.quit();
  });

  it('stores TOFU host key atomically in Redis with 1-year TTL, rejects concurrent mismatch, and fails closed on corrupt entries', async () => {
    const tofuHost = 'redis-tofu.example.com';
    const expectedKey = `${SFTP_TOFU_REDIS_PREFIX}${crypto.createHash('sha256').update(`${tofuHost}:${stub.port}`).digest('hex')}`;
    keysToDelete.push(expectedKey);

    vi.stubEnv(SFTP_DEV_ENDPOINT_ALLOWLIST_ENV, `${tofuHost}:${stub.port}`);
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    stub.files.set(`${BASE_PATH}/reports/redis.txt`, Buffer.from('redis-tofu-ok'));

    const first = new SftpStorageAdapter({
      type: 'sftp',
      host: tofuHost,
      port: stub.port,
      username: 'tester',
      privateKey: stub.clientPrivateKey,
      basePath: BASE_PATH,
    });
    expect((await readAll(await first.downloadStream('reports/redis.txt'))).toString()).toBe('redis-tofu-ok');

    const stored = await probe.get(expectedKey);
    const ttl = await probe.ttl(expectedKey);
    expect(stored).toBe(`* ${stub.hostPublicKey}\n`);
    expect(ttl).toBeGreaterThan(SFTP_TOFU_TTL_SECONDS - 60);
    expect(ttl).toBeLessThanOrEqual(SFTP_TOFU_TTL_SECONDS);

    await expect(persistSftpHostKeyFirstUse(tofuHost, stub.port, stub.hostPublicKey)).resolves.toBe(`* ${stub.hostPublicKey}\n`);
    const other = await startSftpStub();
    try {
      await expect(persistSftpHostKeyFirstUse(tofuHost, stub.port, other.hostPublicKey)).rejects.toMatchObject({
        name: StorageAuthenticationError.name,
        message: 'Storage authentication failed: Host key verification failed: concurrent TOFU host key mismatch',
      });
    } finally {
      await other.close();
    }

    await probe.set(expectedKey, 'corrupt-host-key-entry');
    await expect(getPersistedSftpHostKey(tofuHost, stub.port)).rejects.toThrow(StorageAdapterError);
  });
});
