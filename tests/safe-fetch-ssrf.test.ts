import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dns from 'node:dns';
import { MockAgent } from 'undici';
import { safeFetch, OutboundRequestBlockedError } from '../src/lib/security/safe-fetch';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import type { Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

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
});

afterEach(async () => {
  vi.restoreAllMocks();
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

  it('refuses an import.url node that targets the metadata service', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      processGraphNodeJob(nodeJob({ op: 'import.url', url: 'http://169.254.169.254/latest/meta-data/iam' }))
    ).rejects.toThrow(OutboundRequestBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
