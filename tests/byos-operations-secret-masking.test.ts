import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Agent, type Dispatcher } from 'undici';
import { executeExportTask, executeImportTask, localFsStorage } from '../src/lib/storage';
import { StorageSsrfError } from '../src/lib/storage/adapters/adapter-interface';

/**
 * The BYOS import/export operations take signed URLs from the caller. Errors and results they
 * produce are shown to the caller and logged, so they carry the URL with userinfo and query masked.
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

beforeEach(async () => {
  const stored = await localFsStorage.putBuffer(
    `byos-mask-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    Buffer.from('payload'),
    { contentType: 'text/plain' }
  );
  sourceKey = stored.key;
});

afterEach(() => {
  vi.restoreAllMocks();
  connection.current = null;
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
      executeExportTask({ operation: 'export/url', sourceKey, url: `http://deploy:${PASSWORD}@127.0.0.1:9/hook?X-Amz-Signature=${SIGNATURE}` })
    );
    expect(error).toBeInstanceOf(StorageSsrfError);
    expect(error.message).toBe('Blocked outbound connection to restricted host or IP: "http://***@127.0.0.1:9/hook?***"');
    expect(`${error.message}\n${error.stack}`).not.toContain(SIGNATURE);
    expect(`${error.message}\n${error.stack}`).not.toContain(PASSWORD);
  });

  it('are named without userinfo or query string by an import refusal', async () => {
    const error = await rejection(
      executeImportTask({ operation: 'import/url', url: `http://169.254.169.254/latest/meta-data?token=${SIGNATURE}` })
    );
    expect(error).toBeInstanceOf(StorageSsrfError);
    expect(error.message).toBe('Blocked outbound connection to restricted host or IP: "http://169.254.169.254/latest/meta-data?***"');
  });
});

describe('a completed URL export', () => {
  it('reports its destination without userinfo or query string', async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: PUBLIC_IP, family: 4 }]) as never);
    const received: { method: string; url: string }[] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '' });
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
      const result = await executeExportTask({
        operation: 'export/url',
        sourceKey,
        url: `http://files.example.org/out/result.bin?X-Amz-Signature=${SIGNATURE}`,
      });
      expect(result).toMatchObject({ destination: 'http://files.example.org/out/result.bin?***', size: 7, success: true });
      // The request itself still carried the real, signed URL.
      expect(received).toEqual([{ method: 'POST', url: `/out/result.bin?X-Amz-Signature=${SIGNATURE}` }]);
    } finally {
      await connection.current.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
