import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { createConfiguredRedisClient, hasConfiguredRedis } from '../../redis/client-factory';
import { readyGatedRedis } from '../../redis/when-ready';
import { StorageAdapterError, StorageAuthenticationError } from './adapter-interface';
import { sftpKnownHostsLine } from './sftp-protocol';

/**
 * Persistent trust-on-first-use (TOFU) host key store for BYOS SFTP endpoints.
 *
 * OpenSSH `ssh` writes accepted first-use host keys to `UserKnownHostsFile` inside
 * `verify_host_key` (`sshconnect.c`) before user authentication runs (`sshconnect2.c`),
 * and under `unshare -r` (UID 0 in userns) falls back to `getpwuid(0)->pw_dir` unless
 * `-F /dev/null` and explicit `UserKnownHostsFile` are passed. Callers only invoke
 * `persistSftpHostKeyFirstUse` after SSH authentication has succeeded.
 */

export const SFTP_TOFU_REDIS_PREFIX = 'sftp:tofu:hostkey:';
export const SFTP_TOFU_TTL_SECONDS = 31_536_000;
export const MAX_IN_MEMORY_TOFU_KEYS = 4096;
export const MAX_KNOWN_HOSTS_BYTES = 64 * 1024;

const CONCURRENT_MISMATCH_MESSAGE = 'Host key verification failed: concurrent TOFU host key mismatch';

const inMemoryTofuKeys = new Map<string, string>();
let redisClient: Redis | null = null;

function tofuStoreKey(host: string, port: number): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${host.trim().toLowerCase()}:${port}`)
    .digest('hex');
  return `${SFTP_TOFU_REDIS_PREFIX}${digest}`;
}

function getRedisClient(): Redis | null {
  if (!hasConfiguredRedis()) {
    return null;
  }
  if (!redisClient) {
    try {
      redisClient = readyGatedRedis(
        createConfiguredRedisClient({ maxRetriesPerRequest: 1, enableOfflineQueue: false })
      );
    } catch (err) {
      throw new StorageAdapterError(
        `Failed to initialize Redis client for SFTP host keys: ${err instanceof Error ? err.message : String(err)}`,
        'sftp',
        err
      );
    }
  }
  return redisClient;
}

function getFromMemory(key: string): string | undefined {
  const value = inMemoryTofuKeys.get(key);
  if (value === undefined) {
    return undefined;
  }
  inMemoryTofuKeys.delete(key);
  inMemoryTofuKeys.set(key, value);
  return value;
}

function setInMemory(key: string, value: string): void {
  inMemoryTofuKeys.delete(key);
  if (inMemoryTofuKeys.size >= MAX_IN_MEMORY_TOFU_KEYS) {
    const oldestKey = inMemoryTofuKeys.keys().next().value;
    if (oldestKey !== undefined) {
      inMemoryTofuKeys.delete(oldestKey);
    }
  }
  inMemoryTofuKeys.set(key, value);
}

function normalizeStoredEntry(raw: string): string {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_KNOWN_HOSTS_BYTES) {
    throw new StorageAdapterError('Persisted SFTP host key entry exceeds size limit', 'sftp');
  }
  try {
    return sftpKnownHostsLine(raw);
  } catch (err) {
    throw new StorageAdapterError(
      `Corrupt persisted SFTP host key entry: ${err instanceof Error ? err.message : String(err)}`,
      'sftp',
      err
    );
  }
}

function parseKnownHostsFirstKey(rawContent: string): string {
  if (typeof rawContent !== 'string' || Buffer.byteLength(rawContent, 'utf8') > MAX_KNOWN_HOSTS_BYTES) {
    throw new StorageAdapterError(`SFTP known_hosts content exceeds ${MAX_KNOWN_HOSTS_BYTES} bytes`, 'sftp');
  }
  let start = 0;
  while (start < rawContent.length) {
    const nl = rawContent.indexOf('\n', start);
    const end = nl === -1 ? rawContent.length : nl;
    const candidate = rawContent.slice(start, end).trim();
    start = end + 1;
    if (candidate.length === 0 || candidate.startsWith('#')) {
      continue;
    }
    try {
      return sftpKnownHostsLine(candidate);
    } catch (err) {
      throw new StorageAdapterError(
        `Invalid SFTP host key entry in known_hosts: ${err instanceof Error ? err.message : String(err)}`,
        'sftp',
        err
      );
    }
  }
  throw new StorageAdapterError('SFTP known_hosts content contains no host key entry', 'sftp');
}

async function readRedisEntry(client: Redis, key: string): Promise<string | null> {
  try {
    return await client.get(key);
  } catch (err) {
    throw new StorageAdapterError(
      `Failed to read persisted SFTP host key: ${err instanceof Error ? err.message : String(err)}`,
      'sftp',
      err
    );
  }
}

async function persistRedisFirstUse(client: Redis, key: string, normalized: string): Promise<string> {
  let setResult: 'OK' | null;
  try {
    setResult = await client.set(key, normalized, 'EX', SFTP_TOFU_TTL_SECONDS, 'NX');
  } catch (err) {
    throw new StorageAdapterError(
      `Failed to persist SFTP host key: ${err instanceof Error ? err.message : String(err)}`,
      'sftp',
      err
    );
  }
  if (setResult === 'OK') {
    return normalized;
  }

  let existingRaw = await readRedisEntry(client, key);
  if (existingRaw === null) {
    try {
      if ((await client.set(key, normalized, 'EX', SFTP_TOFU_TTL_SECONDS, 'NX')) === 'OK') {
        return normalized;
      }
    } catch (err) {
      throw new StorageAdapterError(
        `Failed to persist SFTP host key: ${err instanceof Error ? err.message : String(err)}`,
        'sftp',
        err
      );
    }
    existingRaw = await readRedisEntry(client, key);
    if (existingRaw === null) {
      throw new StorageAdapterError('Failed to persist SFTP host key after concurrent expiry', 'sftp');
    }
  }

  const existing = normalizeStoredEntry(existingRaw);
  if (existing === normalized) {
    return existing;
  }
  throw new StorageAuthenticationError(CONCURRENT_MISMATCH_MESSAGE, 'sftp');
}

/**
 * Looks up a previously TOFU-persisted host key for `host:port`, returning the
 * normalized `* <type> <base64>\n` line or `undefined` if none is stored.
 */
export async function getPersistedSftpHostKey(host: string, port: number): Promise<string | undefined> {
  const key = tofuStoreKey(host, port);
  const client = getRedisClient();
  if (client) {
    const raw = await readRedisEntry(client, key);
    return raw === null ? undefined : normalizeStoredEntry(raw);
  }
  const raw = getFromMemory(key);
  return raw === undefined ? undefined : normalizeStoredEntry(raw);
}

/**
 * Atomically persists the first-use host key learned in `known_hosts` (`SET ... EX 31536000 NX`).
 * Succeeds idempotently if another concurrent worker already stored the identical key, or throws
 * `StorageAuthenticationError` if a different key was stored concurrently.
 */
export async function persistSftpHostKeyFirstUse(host: string, port: number, rawContent: string): Promise<string> {
  const normalized = parseKnownHostsFirstKey(rawContent);
  const key = tofuStoreKey(host, port);
  const client = getRedisClient();
  if (client) {
    return persistRedisFirstUse(client, key, normalized);
  }
  const existingRaw = getFromMemory(key);
  if (existingRaw !== undefined) {
    const existing = normalizeStoredEntry(existingRaw);
    if (existing === normalized) {
      return existing;
    }
    throw new StorageAuthenticationError(CONCURRENT_MISMATCH_MESSAGE, 'sftp');
  }
  setInMemory(key, normalized);
  return normalized;
}

/** Clears in-memory TOFU entries and closes any cached Redis client. For tests. */
export async function resetSftpHostKeyStoreForTests(): Promise<void> {
  inMemoryTofuKeys.clear();
  const client = redisClient;
  redisClient = null;
  if (client) {
    if (client.status === 'ready') {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    } else {
      client.disconnect();
    }
  }
}
