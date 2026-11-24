import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import type { ReadStream } from 'node:fs';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { exportArtifactToUrl } from '../src/lib/queue/graph/node-executor';
import { exportToCustomerStorage } from '../src/lib/queue/graph/node-storage-io';
import { InvalidCustomHeaderError } from '../src/lib/security/http-headers';
import { OutboundRequestBlockedError } from '../src/lib/security/safe-fetch';
import { credentialsVault, localFsStorage, storageProvider } from '../src/lib/storage';
import { StorageEndpointBlockedError } from '../src/lib/storage/customer-storage-errors';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * Refused BYOS and URL exports must validate their destination and custom headers before opening
 * the source file, or close the opened source stream on failure so no file descriptor leaks.
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

function fakeExportJob(graphId: string, nodeId: string, userId: string): Job<ConversionJobData, ConversionJobResult> {
  return {
    id: `${graphId}:${nodeId}`,
    data: {
      jobId: `${graphId}:${nodeId}`,
      graphId,
      graphNodeId: nodeId,
      userId,
      originalFilename: '',
      sourceFormat: '',
      targetFormat: '',
      fileSize: 0,
      options: {},
    },
    opts: { attempts: 1, timeout: 10_000 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

describe('BYOS export releases the source stream on refusal', () => {
  let sourceKey: string;
  let sourcePath: string;
  let opened: ReadStream[];

  beforeEach(async () => {
    sourceKey = `intermediate/byos-fd/${Date.now()}-${Math.random().toString(36).slice(2)}/0/payload.txt`;
    await storageProvider.saveObject(sourceKey, Buffer.from('payload'), 'text/plain', 'payload.txt');
    sourcePath = localFsStorage.getPathsForKey(sourceKey).binPath;
    opened = [];
    const realCreateReadStream = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => {
      const stream = realCreateReadStream(...args);
      if (String(args[0]) === sourcePath) opened.push(stream);
      return stream;
    }) as typeof fs.createReadStream);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await storageProvider.deleteObject(sourceKey);
  });

  async function expectAllSourceStreamsClosed(): Promise<void> {
    await Promise.all(opened.map(waitForClose));
    for (const stream of opened) {
      expect(stream.closed).toBe(true);
    }
  }

  it('does not open the source when the s3 endpoint is a restricted host', async () => {
    const credentialRef = await credentialsVault.store('fd-user', {
      type: 's3',
      bucket: 'customer-bucket',
      accessKeyId: 'AKIA_CUSTOMER',
      secretAccessKey: 'CUSTOMER_SECRET',
      endpoint: 'https://169.254.169.254',
    });

    await expect(
      exportToCustomerStorage(
        fakeExportJob('g-s3-fd', 'out', 'fd-user'),
        storageProvider,
        { op: 'export.s3', input: 'conv', credentialRef },
        [sourceKey],
        'g-s3-fd:out'
      )
    ).rejects.toThrow(StorageEndpointBlockedError);
    expect(opened).toHaveLength(0);
    await expectAllSourceStreamsClosed();
  });

  it('does not open the source when the export URL fails SSRF validation', async () => {
    await expect(
      exportArtifactToUrl(storageProvider, sourceKey, 'http://127.0.0.1:9/upload', 'PUT', {}, new AbortController().signal)
    ).rejects.toThrow(OutboundRequestBlockedError);
    expect(opened).toHaveLength(0);
    await expectAllSourceStreamsClosed();
  });

  it('does not open the source when export.url carries a forbidden custom header', async () => {
    await expect(
      exportArtifactToUrl(
        storageProvider,
        sourceKey,
        'https://93.184.215.14/upload',
        'PUT',
        { Host: 'evil.example' },
        new AbortController().signal
      )
    ).rejects.toThrow(InvalidCustomHeaderError);
    expect(opened).toHaveLength(0);
    await expectAllSourceStreamsClosed();
  });

  it('closes the source when the webdav adapter refuses the upload after it was opened', async () => {
    const credentialRef = await credentialsVault.store('fd-user', {
      type: 'webdav',
      url: 'http://127.0.0.1:9/dav',
    });

    await expect(
      exportToCustomerStorage(
        fakeExportJob('g-dav-fd', 'out', 'fd-user'),
        storageProvider,
        { op: 'export.webdav', input: 'conv', credentialRef },
        [sourceKey],
        'g-dav-fd:out'
      )
    ).rejects.toThrow(StorageEndpointBlockedError);
    expect(opened.length).toBe(1);
    await expectAllSourceStreamsClosed();
  });
});
