import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dns from 'node:dns';
import { Dispatcher, MockAgent } from 'undici';
import { safeFetch, OutboundRequestBlockedError } from '../src/lib/security/safe-fetch';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import type { Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import type { IStorageBackend } from '../src/lib/storage/oci-storage';

/**
 * Graph nodes call safeFetch without a dispatcher, so it uses the shared agent built by
 * createSsrfSafeAgent. Replace only that factory with a dispatcher that forwards to whatever the
 * current test installs; URL validation (validateUrlForSsrf) stays the real implementation.
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
  return { ...actual, createSsrfSafeAgent: () => new ForwardingDispatcher() };
});

/**
 * Outbound requests driven by user input (graph import.url / export.url) must never reach
 * private, loopback, or link-local addresses, neither directly nor through a redirect, and
 * must never replay a request body to a redirect target.
 */

const PUBLIC_IP = '93.184.215.14';
const ORIGIN = 'https://files.example.org';

let agent: MockAgent;

beforeEach(() => {
  // Test hosts resolve to a public address, so only the URL itself decides whether it is blocked.
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: PUBLIC_IP, family: 4 }]) as never);
  agent = new MockAgent();
  agent.disableNetConnect();
  connection.current = agent;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  connection.current = null;
  await agent.close();
});

describe('safeFetch', () => {
  it('blocks a link-local metadata address before sending any request', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data', {}, { dispatcher: agent })).rejects.toThrow(
      OutboundRequestBlockedError
    );
    agent.assertNoPendingInterceptors();
  });

  it('blocks a redirect that points at a loopback address', async () => {
    agent.get(ORIGIN).intercept({ path: '/report.csv', method: 'GET' }).reply(302, '', {
      headers: { location: 'http://127.0.0.1:6379/' },
    });
    await expect(safeFetch(`${ORIGIN}/report.csv`, {}, { dispatcher: agent })).rejects.toThrow(OutboundRequestBlockedError);
  });

  it('follows a redirect to another public URL and returns its body', async () => {
    agent.get(ORIGIN).intercept({ path: '/old.csv', method: 'GET' }).reply(301, '', { headers: { location: '/new.csv' } });
    agent.get(ORIGIN).intercept({ path: '/new.csv', method: 'GET' }).reply(200, 'a,b\n1,2\n');
    const res = await safeFetch(`${ORIGIN}/old.csv`, {}, { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('a,b\n1,2\n');
  });

  it('gives up after the redirect limit', async () => {
    for (let i = 0; i < 5; i++) {
      agent.get(ORIGIN).intercept({ path: `/hop${i}`, method: 'GET' }).reply(302, '', { headers: { location: `/hop${i + 1}` } });
    }
    await expect(safeFetch(`${ORIGIN}/hop0`, {}, { dispatcher: agent })).rejects.toThrow(/redirect/i);
  });

  it('never replays an upload body to a redirect target', async () => {
    agent.get(ORIGIN).intercept({ path: '/upload', method: 'PUT' }).reply(307, '', { headers: { location: '/elsewhere' } });
    await expect(
      safeFetch(`${ORIGIN}/upload`, { method: 'PUT', body: 'payload' }, { dispatcher: agent })
    ).rejects.toThrow(/redirect/i);
  });

  it('rejects non-HTTP schemes', async () => {
    await expect(safeFetch('file:///etc/passwd', {}, { dispatcher: agent })).rejects.toThrow(OutboundRequestBlockedError);
  });
});

describe('graph URL nodes', () => {
  function nodeJob(graphNode: Record<string, unknown>): Job<ConversionJobData, ConversionJobResult> {
    return {
      id: 'g_ssrf:n1',
      data: {
        jobId: 'g_ssrf:n1',
        sourceFormat: 'bin',
        targetFormat: 'bin',
        fileSize: 0,
        options: {},
        graphId: 'g_ssrf',
        graphNodeId: 'n1',
        graphNode,
        inputArtifacts: [],
      },
      opts: { attempts: 1 },
      attemptsMade: 1,
      signal: new AbortController().signal,
      log: async () => {},
      updateProgress: async () => {},
    } as unknown as Job<ConversionJobData, ConversionJobResult>;
  }

  /** Minimal storage that consumes the stream the way the real backends do (data/end/error). */
  function recordingStorage() {
    const saved = new Map<string, Buffer>();
    const storage = {
      providerName: 'test-recording',
      saveObjectFromStream(key: string, stream: NodeJS.ReadableStream) {
        return new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          stream.on('end', () => {
            saved.set(key, Buffer.concat(chunks));
            resolve({ key });
          });
          stream.on('error', reject);
        });
      },
    } as unknown as IStorageBackend;
    return { storage, saved };
  }

  /**
   * Answers every request with a 200 and then hands control to `script`, which drives the body.
   * Records whether the client aborted the connection (what cancelling the response body does).
   */
  class ScriptedDispatcher extends Dispatcher {
    dispatches = 0;
    abortReason: unknown = null;
    constructor(private readonly script: (handler: Dispatcher.DispatchHandlers) => void) {
      super();
    }
    dispatch(_opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
      this.dispatches++;
      setImmediate(() => {
        handler.onConnect?.((reason?: unknown) => {
          this.abortReason = reason ?? new Error('aborted');
        });
        handler.onHeaders?.(200, [Buffer.from('content-type'), Buffer.from('application/octet-stream')], () => {}, 'OK');
        this.script(handler);
      });
      return true;
    }
  }

  const STREAM_TEST_TIMEOUT_MS = 2000;
  const CHUNK = Buffer.alloc(64, 0x61);

  it('refuses an import.url node that targets the metadata service without dispatching', async () => {
    const dispatchSpy = vi.spyOn(agent, 'dispatch');
    const { storage, saved } = recordingStorage();
    await expect(
      processGraphNodeJob(nodeJob({ op: 'import.url', url: 'http://169.254.169.254/latest/meta-data/iam' }), undefined, storage)
    ).rejects.toThrow(OutboundRequestBlockedError);
    expect(dispatchSpy).toHaveBeenCalledTimes(0);
    agent.assertNoPendingInterceptors();
    expect(saved.size).toBe(0);
  });

  it('imports a public URL through the shared connection agent', async () => {
    const dispatchSpy = vi.spyOn(agent, 'dispatch');
    agent.get(ORIGIN).intercept({ path: '/data.csv', method: 'GET' }).reply(200, 'a,b\n1,2\n');
    const { storage, saved } = recordingStorage();
    await processGraphNodeJob(nodeJob({ op: 'import.url', url: `${ORIGIN}/data.csv` }), undefined, storage);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(saved.get('intermediate/g_ssrf/n1/data.csv')?.toString()).toBe('a,b\n1,2\n');
  });

  it(
    'rejects the job when the remote resets the connection mid-body',
    async () => {
      const reset = Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' });
      connection.current = new ScriptedDispatcher((handler) => {
        handler.onData?.(CHUNK);
        setImmediate(() => handler.onError?.(reset));
      });
      const { storage, saved } = recordingStorage();
      await expect(
        processGraphNodeJob(nodeJob({ op: 'import.url', url: `${ORIGIN}/big.bin` }), undefined, storage)
      ).rejects.toThrow(/terminated|socket reset by peer/);
      expect(saved.size).toBe(0);
    },
    STREAM_TEST_TIMEOUT_MS
  );

  it(
    'rejects the job and aborts the download when the body exceeds the import limit',
    async () => {
      vi.stubEnv('GRAPH_URL_IMPORT_MAX_BYTES', String(CHUNK.length));
      // Sends two chunks and never completes: only the size limit can end this download.
      const remote = new ScriptedDispatcher((handler) => {
        handler.onData?.(CHUNK);
        handler.onData?.(CHUNK);
      });
      connection.current = remote;
      const { storage, saved } = recordingStorage();
      await expect(
        processGraphNodeJob(nodeJob({ op: 'import.url', url: `${ORIGIN}/big.bin` }), undefined, storage)
      ).rejects.toThrow(/exceeds the 64-byte import limit/);
      expect(saved.size).toBe(0);
      await vi.waitFor(() => expect(remote.abortReason).not.toBeNull(), { timeout: STREAM_TEST_TIMEOUT_MS / 2 });
    },
    STREAM_TEST_TIMEOUT_MS
  );
});
