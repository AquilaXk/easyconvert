import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Agent, type Dispatcher } from 'undici';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { exportArtifactToUrl } from '../src/lib/queue/graph/node-executor';
import { importUrlWithinBudget } from '../src/lib/queue/graph/node-url-import';
import { OutboundRequestBlockedError } from '../src/lib/security/safe-fetch';
import { storageProvider } from '../src/lib/storage';
import { StorageSsrfError } from '../src/lib/storage/adapters/adapter-interface';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * URL import/export nodes and storage SSRF errors take signed URLs from the caller.
 * Errors they produce mask userinfo and query strings while the outbound request still sends the signed URL.
 */
const connection = vi.hoisted(() => ({ current: null as Dispatcher | null }));
vi.mock('../src/lib/security/ssrf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/security/ssrf')>();
  const { Dispatcher: BaseDispatcher } = await import('undici');
  class ForwardingDispatcher extends BaseDispatcher {
    dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
      if (!connection.current) {
        throw new Error('test did not install a dispatcher');
      }
      return connection.current.dispatch(opts, handler);
    }
  }
  return { ...actual, createSsrfSafeAgent: vi.fn(() => new ForwardingDispatcher()) };
});

const SIGNATURE = 'sig-6a0d93e1c47b25f8';
const PASSWORD = 'pw-1f84c2a7e9b03d56';
const PUBLIC_IP = '93.184.215.14';

let sourceKey: string;

function fakeImportJob(): Job<ConversionJobData, ConversionJobResult> {
  return {
    id: 'g-mask:in',
    data: {
      jobId: 'g-mask:in',
      graphId: 'g-mask',
      graphNodeId: 'in',
      userId: 'user-url-mask',
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

beforeEach(async () => {
  sourceKey = `intermediate/byos-mask/${Date.now()}-${Math.random().toString(36).slice(2)}/0/payload.txt`;
  await storageProvider.saveObject(sourceKey, Buffer.from('payload'), 'text/plain', 'payload.txt');
});

afterEach(async () => {
  vi.restoreAllMocks();
  connection.current = null;
  await storageProvider.deleteObject(sourceKey);
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the operation to be refused');
}

describe('refused URLs', () => {
  it('are named without userinfo or query string by an export refusal', async () => {
    const error = await rejection(
      exportArtifactToUrl(
        storageProvider,
        sourceKey,
        `http://deploy:${PASSWORD}@127.0.0.1:9/hook?X-Amz-Signature=${SIGNATURE}`,
        'POST',
        undefined,
        new AbortController().signal
      )
    );
    expect(error).toBeInstanceOf(OutboundRequestBlockedError);
    expect(error.message).toContain('http://127.0.0.1:9/hook');
    expect(`${error.message}\n${error.stack}`).not.toContain(SIGNATURE);
    expect(`${error.message}\n${error.stack}`).not.toContain(PASSWORD);
  });

  it('are named without userinfo or query string by an import refusal', async () => {
    const error = await rejection(
      importUrlWithinBudget(
        fakeImportJob(),
        storageProvider,
        `http://deploy:${PASSWORD}@169.254.169.254/latest/meta-data?token=${SIGNATURE}`,
        undefined
      )
    );
    expect(error).toBeInstanceOf(OutboundRequestBlockedError);
    expect(error.message).toContain('http://169.254.169.254/latest/meta-data');
    expect(`${error.message}\n${error.stack}`).not.toContain(SIGNATURE);
    expect(`${error.message}\n${error.stack}`).not.toContain(PASSWORD);
  });

  it('StorageSsrfError masks userinfo and query strings in its message', () => {
    const ssrfErr = new StorageSsrfError(
      `http://deploy:${PASSWORD}@127.0.0.1:9/hook?X-Amz-Signature=${SIGNATURE}`,
      'http'
    );
    expect(ssrfErr.message).toBe('Blocked outbound connection to restricted host or IP: "http://***@127.0.0.1:9/hook?***"');
    expect(ssrfErr.message).not.toContain(SIGNATURE);
    expect(ssrfErr.message).not.toContain(PASSWORD);
  });
});

describe('completed and failed remote URL requests', () => {
  it('sends the real signed URL while masking secrets in HTTP failure errors', async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: PUBLIC_IP, family: 4 }]) as never);
    const received: { method: string; url: string }[] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '' });
        if (req.method === 'GET') {
          res.writeHead(403).end('forbidden');
          return;
        }
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    connection.current = new Agent({
      connect: ((_options: unknown, callback: (err: Error | null, socket?: net.Socket) => void) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => callback(null, socket));
        socket.once('error', (err) => callback(err));
      }) as never,
    });

    try {
      await exportArtifactToUrl(
        storageProvider,
        sourceKey,
        `http://files.example.org/out/result.bin?X-Amz-Signature=${SIGNATURE}`,
        'POST',
        undefined,
        new AbortController().signal
      );

      const importError = await rejection(
        importUrlWithinBudget(
          fakeImportJob(),
          storageProvider,
          `http://files.example.org/in/data.bin?X-Amz-Signature=${SIGNATURE}`,
          undefined
        )
      );
      expect(importError.message).toContain(`http://files.example.org/in/data.bin?***: HTTP 403`);
      expect(`${importError.message}\n${importError.stack}`).not.toContain(SIGNATURE);

      expect(received).toEqual([
        { method: 'POST', url: `/out/result.bin?X-Amz-Signature=${SIGNATURE}` },
        { method: 'GET', url: `/in/data.bin?X-Amz-Signature=${SIGNATURE}` },
      ]);
    } finally {
      await connection.current.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
