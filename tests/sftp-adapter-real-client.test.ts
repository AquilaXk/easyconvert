import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { SFTP_DEV_ENDPOINT_ALLOWLIST_ENV, SftpStorageAdapter } from '../src/lib/storage/adapters/sftp';
import {
  StorageAuthenticationError,
  StorageListingLimitError,
  StorageNotFoundError,
  StorageSizeLimitError,
  StorageSsrfError,
} from '../src/lib/storage/adapters/adapter-interface';
import type { SftpCredentials } from '../src/lib/storage/credentials-vault';
import { startSftpStub, type SftpStub } from './helpers/sftp-stub-server';

/**
 * `SftpStorageAdapter` against a real SFTP server (the `ssh2` server in tests/helpers/sftp-stub-server.ts) through the real OpenSSH
 * `sftp` client: what the other SFTP tests, which stub the child process, cannot show: the listing of a directory in the
 * format a server writes, a pinned host key, a key the server refuses, and the connection made to the checked address.
 */

const CLIENT_AVAILABLE = fs.existsSync('/usr/bin/sftp');
const BASE_PATH = '/data';

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// skip-ok: environment probe; a host without the OpenSSH client has no real client to drive (CI images carry it).
describe.skipIf(!CLIENT_AVAILABLE)('SftpStorageAdapter with the OpenSSH client against an SFTP server', () => {
  let stub: SftpStub;

  beforeAll(async () => {
    stub = await startSftpStub();
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(SFTP_DEV_ENDPOINT_ALLOWLIST_ENV, `${stub.host}:${stub.port}`);
    stub.files.clear();
    stub.directories.clear();
    stub.directories.add(BASE_PATH);
    stub.directories.add(`${BASE_PATH}/reports`);
    stub.statedSizes.clear();
    stub.dropConnections = 0;
    stub.log.reads.length = 0;
    stub.log.writes.length = 0;
    stub.log.removes.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function credentials(overrides: Partial<SftpCredentials> = {}): SftpCredentials {
    return { type: 'sftp', host: stub.host, port: stub.port, username: 'tester', privateKey: stub.clientPrivateKey, hostKey: stub.hostPublicKey, basePath: BASE_PATH, ...overrides };
  }

  it('uploads a stream, reads it back and sees its size', async () => {
    const adapter = new SftpStorageAdapter(credentials());
    const body = Buffer.from('id,total\n1,99.50\n');

    const written = await adapter.uploadStream('reports/q3.csv', Readable.from([body]), { size: body.length });

    expect(written.size).toBe(body.length);
    expect(stub.files.get(`${BASE_PATH}/reports/q3.csv`)?.equals(body)).toBe(true);
    expect((await adapter.head('reports/q3.csv'))?.size).toBe(body.length);
    expect((await readAll(await adapter.downloadStream('reports/q3.csv'))).equals(body)).toBe(true);
    expect(await adapter.delete('reports/q3.csv')).toBe(true);
    expect(stub.files.has(`${BASE_PATH}/reports/q3.csv`)).toBe(false);
  });

  it('lists the regular files of a directory with their sizes, and leaves folders out', async () => {
    stub.files.set(`${BASE_PATH}/reports/a.csv`, Buffer.from('aaaa'));
    stub.files.set(`${BASE_PATH}/reports/b name.csv`, Buffer.from('bb'));
    stub.directories.add(`${BASE_PATH}/reports/archive`);

    const listed = await new SftpStorageAdapter(credentials()).listDirectory('reports', 10);

    expect(listed).toEqual([
      { name: 'a.csv', size: 4 },
      { name: 'b name.csv', size: 2 },
    ]);
  });

  it('stops a download at the byte limit and keeps nothing, whatever size the listing stated', async () => {
    const adapter = new SftpStorageAdapter(credentials());
    stub.files.set(`${BASE_PATH}/reports/big.bin`, Buffer.alloc(3 * 1024 * 1024, 7));
    stub.statedSizes.set(`${BASE_PATH}/reports/big.bin`, 100);
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-scratch-'));
    vi.stubEnv('TMPDIR', scratchRoot);

    expect((await adapter.head('reports/big.bin'))?.size).toBe(100);
    await expect(adapter.downloadStream('reports/big.bin', { maxBytes: 1024 })).rejects.toMatchObject({ name: StorageSizeLimitError.name, maxBytes: 1024 });

    expect(fs.readdirSync(scratchRoot)).toEqual([]);
    const whole = await readAll(await adapter.downloadStream('reports/big.bin', { maxBytes: 4 * 1024 * 1024 }));
    expect(whole.length).toBe(3 * 1024 * 1024);
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    // Two OpenSSH transfers of 3 MiB each: about 1 s on a laptop, several on a shared runner.
  }, 30_000);

  it('refuses a directory with more files than the limit instead of listing it short', async () => {
    for (let i = 0; i < 4; i++) stub.files.set(`${BASE_PATH}/reports/f${i}.csv`, Buffer.from('x'));

    await expect(new SftpStorageAdapter(credentials()).listDirectory('reports', 3)).rejects.toMatchObject({ name: StorageListingLimitError.name, maxObjects: 3 });
  });

  it('reports a directory that is not there as not found', async () => {
    await expect(new SftpStorageAdapter(credentials()).listDirectory('nowhere', 3)).rejects.toMatchObject({ name: StorageNotFoundError.name });
  });

  it('trusts the pinned host key and refuses a server that shows another', async () => {
    stub.files.set(`${BASE_PATH}/reports/a.csv`, Buffer.from('aaaa'));
    expect(await new SftpStorageAdapter(credentials()).listDirectory('reports', 3)).toHaveLength(1);

    const other = await startSftpStub();
    try {
      vi.stubEnv(SFTP_DEV_ENDPOINT_ALLOWLIST_ENV, `${other.host}:${other.port}`);
      const wrongHost = new SftpStorageAdapter(credentials({ host: other.host, port: other.port, privateKey: other.clientPrivateKey }));
      await expect(wrongHost.listDirectory('reports', 3)).rejects.toBeInstanceOf(StorageAuthenticationError);
      expect(other.log.signedIn).toBe(0);
    } finally {
      await other.close();
    }
  });

  it('fails authentication when the server does not know the key', async () => {
    const other = await startSftpStub();
    try {
      const adapter = new SftpStorageAdapter(credentials({ privateKey: other.clientPrivateKey }));
      await expect(adapter.head('reports/a.csv')).rejects.toMatchObject({ name: StorageAuthenticationError.name });
      expect(stub.log.refusedKeys).toBe(1);
    } finally {
      await other.close();
    }
  });

  it('refuses the server it is not allowed to reach before it connects', async () => {
    vi.stubEnv(SFTP_DEV_ENDPOINT_ALLOWLIST_ENV, '');
    const before = stub.log.connections;

    await expect(new SftpStorageAdapter(credentials()).head('reports/a.csv')).rejects.toBeInstanceOf(StorageSsrfError);

    expect(stub.log.connections).toBe(before);
  });
});
