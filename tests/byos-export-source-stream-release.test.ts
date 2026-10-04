import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import type { ReadStream } from 'node:fs';
import { credentialsVault, executeExportTask, localFsStorage } from '../src/lib/storage';
import { StorageProviderUnavailableError, StorageSsrfError } from '../src/lib/storage/adapters/adapter-interface';

/**
 * executeExportTask opened the source file before the destination could be refused, so every
 * refused export leaked a file descriptor. Oracle: the real fs.createReadStream calls made for the
 * source object's file; each one must be closed once the export rejects.
 */

const CLOSE_TIMEOUT_MS = 1000;

async function waitForClose(stream: ReadStream): Promise<void> {
  if (stream.closed) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`source stream for ${String(stream.path)} left open`)), CLOSE_TIMEOUT_MS);
    stream.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('BYOS export releases the source stream on refusal', () => {
  let sourceKey: string;
  let sourcePath: string;
  let opened: ReadStream[];

  beforeEach(async () => {
    const stored = await localFsStorage.putBuffer(
      `byos-fd-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      Buffer.from('payload'),
      { contentType: 'text/plain' }
    );
    sourceKey = stored.key;
    sourcePath = localFsStorage.getPathsForKey(sourceKey).binPath;
    opened = [];
    const realCreateReadStream = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => {
      const stream = realCreateReadStream(...args);
      if (String(args[0]) === sourcePath) opened.push(stream);
      return stream;
    }) as typeof fs.createReadStream);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function expectAllSourceStreamsClosed(): Promise<void> {
    await Promise.all(opened.map(waitForClose));
    for (const stream of opened) {
      expect(stream.closed).toBe(true);
    }
  }

  it('does not leave the source open when the provider is unavailable', async () => {
    const credentialRef = await credentialsVault.store('fd-user', {
      type: 's3',
      bucket: 'customer-bucket',
      accessKeyId: 'AKIA_CUSTOMER',
      secretAccessKey: 'CUSTOMER_SECRET',
    });

    await expect(
      executeExportTask({ operation: 'export/s3', sourceKey, remotePath: 'out/p.txt', credentialRef, userId: 'fd-user' })
    ).rejects.toThrow(StorageProviderUnavailableError);
    await expectAllSourceStreamsClosed();
  });

  it('does not leave the source open when the export URL fails SSRF validation', async () => {
    await expect(
      executeExportTask({ operation: 'export/url', sourceKey, url: 'http://127.0.0.1:9/upload' })
    ).rejects.toThrow(StorageSsrfError);
    await expectAllSourceStreamsClosed();
  });

  it('closes the source when the adapter refuses the upload after it was opened', async () => {
    const credentialRef = await credentialsVault.store('fd-user', {
      type: 'webdav',
      url: 'http://127.0.0.1:9/dav',
    });

    await expect(
      executeExportTask({ operation: 'export/webdav', sourceKey, remotePath: 'out/p.txt', credentialRef, userId: 'fd-user' })
    ).rejects.toThrow(StorageSsrfError);
    expect(opened.length).toBe(1);
    await expectAllSourceStreamsClosed();
  });
});
