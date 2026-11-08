import fs from 'node:fs';
import type { ReadStream } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));

import { fetch as undiciFetch } from 'undici';
import { exportArtifactToUrl } from '../src/lib/queue/graph/node-executor';
import { OutboundRequestBlockedError } from '../src/lib/security/safe-fetch';
import { localFsStorage, storageProvider } from '../src/lib/storage';

/**
 * The `export.url` node of a graph streams a stored artifact to a customer's URL. The URL is checked before the artifact is
 * opened, so a refused destination holds no file descriptor, and a destination that answers with a redirect is refused with
 * the typed error instead of being sent a body that cannot be sent again.
 */

const CLOSE_TIMEOUT_MS = 1000;
const HTTP_TEMPORARY_REDIRECT = 307;
const HTTP_PERMANENT_REDIRECT = 308;

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

describe('exporting a graph artifact to a URL', () => {
  let sourceKey: string;
  let opened: ReadStream[];

  beforeEach(async () => {
    sourceKey = `intermediate/graph-export/${Date.now()}-${Math.random().toString(36).slice(2)}/0/payload.txt`;
    await storageProvider.saveObject(sourceKey, Buffer.from('payload'), 'text/plain', 'payload.txt');
    const sourcePath = localFsStorage.getPathsForKey(sourceKey).binPath;
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
    vi.mocked(undiciFetch).mockReset();
  });

  it('refuses a private destination before it opens the artifact', async () => {
    await expect(exportArtifactToUrl(storageProvider, sourceKey, 'http://127.0.0.1:9/upload', 'PUT', {}, new AbortController().signal)).rejects.toThrow(
      OutboundRequestBlockedError
    );

    expect(opened).toHaveLength(0);
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it.each([HTTP_TEMPORARY_REDIRECT, HTTP_PERMANENT_REDIRECT])('refuses a destination that redirects with %i, and releases the artifact', async (status) => {
    vi.mocked(undiciFetch).mockResolvedValue(new Response(null, { status, headers: { location: 'https://93.184.215.14/elsewhere' } }) as never);

    await expect(exportArtifactToUrl(storageProvider, sourceKey, 'https://93.184.215.14/upload', 'PUT', {}, new AbortController().signal)).rejects.toThrow(
      new RegExp(`refusing to follow a ${status} redirect for a PUT request`)
    );

    expect(undiciFetch).toHaveBeenCalledTimes(1);
    await Promise.all(opened.map(waitForClose));
    expect(opened.every((stream) => stream.closed)).toBe(true);
  });

  it('releases the artifact when the destination cannot be reached', async () => {
    vi.mocked(undiciFetch).mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(exportArtifactToUrl(storageProvider, sourceKey, 'https://93.184.215.14/upload', 'PUT', {}, new AbortController().signal)).rejects.toThrow(
      'ECONNREFUSED'
    );

    await Promise.all(opened.map(waitForClose));
    expect(opened.every((stream) => stream.closed)).toBe(true);
  });
});
