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
  return { ...actual, createSsrfSafeAgent: vi.fn(() => new ForwardingDispatcher()) };
});

/**
 * Outbound requests driven by user input (graph import.url / export.url) must never reach
 * private, loopback, or link-local addresses, neither directly nor through a redirect, and
 * must never replay a request body to a redirect target.
 */

const PUBLIC_IP = '93.184.215.14';
const ORIGIN = 'https://files.example.org';
const OTHER_ORIGIN = 'https://cdn.example.net';
const SECRET_QUERY = 'token=s3cr3t';

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

describe('safeFetch redirect hardening', () => {
  /** Lower-cased request headers as the dispatcher received them. */
  function headerMap(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i]).toLowerCase()] = String(raw[i + 1]);
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k.toLowerCase()] = String(v);
    }
    return out;
  }

  const CREDENTIAL_HEADERS = {
    AUTHORIZATION: 'Bearer abc',
    cookie: 'sid=1',
    'Proxy-Authorization': 'Basic xyz',
    'X-Trace': 'keep-me',
  };

  it('drops credential headers when a redirect crosses origins', async () => {
    let received: Record<string, string> = {};
    agent.get(ORIGIN).intercept({ path: '/a', method: 'GET' }).reply(302, '', { headers: { location: `${OTHER_ORIGIN}/b` } });
    agent.get(OTHER_ORIGIN).intercept({ path: '/b', method: 'GET' }).reply((opts) => {
      received = headerMap(opts.headers);
      return { statusCode: 200, data: 'ok' };
    });
    const res = await safeFetch(`${ORIGIN}/a`, { headers: CREDENTIAL_HEADERS }, { dispatcher: agent });
    expect(await res.text()).toBe('ok');
    expect(received['authorization']).toBeUndefined();
    expect(received['cookie']).toBeUndefined();
    expect(received['proxy-authorization']).toBeUndefined();
    expect(received['x-trace']).toBe('keep-me');
  });

  it('keeps credential headers on a same-origin redirect', async () => {
    let received: Record<string, string> = {};
    agent.get(ORIGIN).intercept({ path: '/a', method: 'GET' }).reply(302, '', { headers: { location: '/b' } });
    agent.get(ORIGIN).intercept({ path: '/b', method: 'GET' }).reply((opts) => {
      received = headerMap(opts.headers);
      return { statusCode: 200, data: 'ok' };
    });
    await (await safeFetch(`${ORIGIN}/a`, { headers: CREDENTIAL_HEADERS }, { dispatcher: agent })).text();
    expect(received['authorization']).toBe('Bearer abc');
    expect(received['cookie']).toBe('sid=1');
    expect(received['proxy-authorization']).toBe('Basic xyz');
  });

  it('throws a typed error without the query string when a redirect has no Location', async () => {
    agent.get(ORIGIN).intercept({ path: `/a?${SECRET_QUERY}`, method: 'GET' }).reply(302, '');
    const err = await safeFetch(`${ORIGIN}/a?${SECRET_QUERY}`, {}, { dispatcher: agent }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundRequestBlockedError);
    expect((err as Error).message).toContain(`${ORIGIN}/a`);
    expect((err as Error).message).not.toContain(SECRET_QUERY);
  });

  it('throws a typed error without the query string for a redirected upload', async () => {
    agent.get(ORIGIN).intercept({ path: `/up?${SECRET_QUERY}`, method: 'PUT' }).reply(307, '', { headers: { location: '/x' } });
    const err = await safeFetch(`${ORIGIN}/up?${SECRET_QUERY}`, { method: 'PUT', body: 'p' }, { dispatcher: agent }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OutboundRequestBlockedError);
    expect((err as Error).message).not.toContain(SECRET_QUERY);
  });

  it('throws a typed error without the query string after too many redirects', async () => {
    for (let i = 0; i < 5; i++) {
      agent.get(ORIGIN).intercept({ path: `/h${i}?${SECRET_QUERY}`, method: 'GET' }).reply(302, '', {
        headers: { location: `/h${i + 1}?${SECRET_QUERY}` },
      });
    }
    const err = await safeFetch(`${ORIGIN}/h0?${SECRET_QUERY}`, {}, { dispatcher: agent }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundRequestBlockedError);
    expect((err as Error).message).toMatch(/redirect/i);
    expect((err as Error).message).not.toContain(SECRET_QUERY);
  });

  it('keeps the query string out of a blocked-host error', async () => {
    const err = await safeFetch(`http://127.0.0.1/a?${SECRET_QUERY}`, {}, { dispatcher: agent }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundRequestBlockedError);
    expect((err as Error).message).toContain('http://127.0.0.1/a');
    expect((err as Error).message).not.toContain(SECRET_QUERY);
  });

  it('reuses one connection agent across calls without a dispatcher', async () => {
    vi.resetModules();
    const ssrf = await import('../src/lib/security/ssrf');
    const fresh = await import('../src/lib/security/safe-fetch');
    vi.mocked(ssrf.createSsrfSafeAgent).mockClear();
    agent.get(ORIGIN).intercept({ path: '/one', method: 'GET' }).reply(200, '1');
    agent.get(ORIGIN).intercept({ path: '/two', method: 'GET' }).reply(200, '2');
    expect(await (await fresh.safeFetch(`${ORIGIN}/one`)).text()).toBe('1');
    expect(await (await fresh.safeFetch(`${ORIGIN}/two`)).text()).toBe('2');
    expect(ssrf.createSsrfSafeAgent).toHaveBeenCalledTimes(1);
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
