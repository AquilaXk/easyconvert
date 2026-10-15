import dns from 'node:dns';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import { Queue, Worker, type Job } from '../src/lib/queue/bullmq-engine';
import { graphScheduler, InMemoryGraphScheduler, type JobGraph } from '../src/lib/queue/graph';
import { graphNodeJobId } from '../src/lib/queue/graph/node-jobs';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { sealGraphNode } from '../src/lib/queue/graph/sealed-nodes';
import type { GraphNode } from '../src/lib/queue/graph/types';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import type { IStorageBackend } from '../src/lib/storage/oci-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { signCustomerRequest, startCustomerStorage, EMPTY_PAYLOAD_SHA256, type CustomerStorage } from './helpers/byos-customer-storage';

/**
 * Logs, error messages, failure reasons, stack traces and dead-letter entries are all places a
 * secret can be printed by accident (a remote that echoes a URL, an SDK that quotes a request).
 * Each surface must show the masked form. Goldens are hand-written from the masking contract.
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

const PUBLIC_IP = '93.184.215.14';
const PASSWORD = 'pw-4e8a1c7d93b2';
const SIGNATURE = 'sig-b91f0a6d3c85e247';
const BEARER = 'bt-77c20e5b1a94d6f3';
const WEBHOOK_SECRET = 'whsec-2d61f9b08e3a47c5';
const SECRETS = [PASSWORD, SIGNATURE, BEARER, WEBHOOK_SECRET];
const LEAKY = `upstream rejected https://deploy:${PASSWORD}@h.example/obj?X-Amz-Signature=${SIGNATURE} with Authorization: Bearer ${BEARER}`;
const MASKED = 'upstream rejected https://***@h.example/obj?*** with Authorization: ***';
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const WAIT_MS = 5_000;

const consoleOutput: string[] = [];

function expectNoSecrets(label: string, text: string): void {
  for (const secret of SECRETS) {
    expect(text.includes(secret), `${label} leaks "${secret}"`).toBe(false);
  }
}

function uniqueId(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(() => {
  consoleOutput.length = 0;
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
    });
  }
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: PUBLIC_IP, family: 4 }]) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  connection.current = null;
});

describe('job logs', () => {
  it('mask URL userinfo, query strings and bearer tokens in a log row', async () => {
    const queue = new Queue<{ n: number }, string>(uniqueId('mask-log'));
    const job = await queue.add('t', { n: 1 });
    await job.log(`calling ${LEAKY}`);
    expect(job.logs).toHaveLength(1);
    expect(job.logs[0]).toMatch(new RegExp(`^\\[\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\\] calling ${escapeRegExp(MASKED)}$`));
  });
});

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

describe('failed jobs', () => {
  it('mask the failure reason, stack trace, failed event, dead-letter entry and console output', async () => {
    const queue = new Queue<Record<string, unknown>, string>(uniqueId('mask-fail'));
    const worker = new Worker<Record<string, unknown>, string>(
      [queue],
      async () => {
        throw new Error(LEAKY);
      },
      { concurrency: 1 }
    );
    const failedError = new Promise<Error>((resolve) => worker.once('failed', (_job, err: Error) => resolve(err)));
    const job = await queue.add(
      'convert',
      { webhookSecret: WEBHOOK_SECRET, graphNode: { op: 'import.url', headers: { Authorization: `Bearer ${BEARER}` } } },
      { attempts: 1 }
    );

    const err = await Promise.race([
      failedError,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('job did not fail')), WAIT_MS)),
    ]);
    await worker.close();

    expect(job.failedReason).toBe(MASKED);
    expect(err.message).toBe(MASKED);
    expectNoSecrets('stack trace', job.stacktrace.join('\n'));
    expectNoSecrets('error stack', err.stack ?? '');
    expectNoSecrets('job logs', job.logs.join('\n'));

    const entries = await queue.getDlqEntries!();
    expect(entries).toHaveLength(1);
    expect(entries[0].failedReason).toBe(MASKED);
    expect(entries[0].data).toEqual({
      webhookSecret: '***',
      graphNode: { op: 'import.url', headers: '***' },
    });
    expectNoSecrets('dead-letter entry', JSON.stringify(entries[0]));
    expectNoSecrets('console output', consoleOutput.join('\n'));
  });
});

describe('graph scheduler failures', () => {
  it('mask the node error, the graph failure reason and the failed webhook payload', async () => {
    const graphId = uniqueId('mask-sched');
    const scheduler = new InMemoryGraphScheduler();
    const graph: JobGraph = {
      failurePolicy: 'fail_fast',
      nodes: {
        in: { op: 'import.upload', storageKey: 'uploads/x/in.csv' },
        out: { op: 'export.internal', input: 'in' },
      },
    };
    const dispatch = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({} as never);
    await scheduler.initGraph(graphId, graph, {
      ownerUserId: 'user-mask',
      webhookUrl: 'https://hooks.example/h',
      webhookSecret: WEBHOOK_SECRET,
    });

    await scheduler.onNodeFailed(graphId, 'in', LEAKY);

    const state = await scheduler.getGraphState(graphId);
    expect(state?.failedReason).toBe(MASKED);
    expect(state?.nodes.in.error).toBe(MASKED);
    // The state keeps the webhook signing secret to dispatch with; the API view masks it (see the route tests).
    expectNoSecrets('graph state', JSON.stringify({ failedReason: state?.failedReason, nodes: state?.nodes }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][1]).toBe('graph.failed');
    expect(dispatch.mock.calls[0][2]).toMatchObject({ jobId: graphId, status: 'failed', error: MASKED });
    expectNoSecrets('webhook payload', JSON.stringify(dispatch.mock.calls[0][2]));
  });
});

describe('graph node worker', () => {
  let customer: CustomerStorage;

  beforeEach(async () => {
    customer = await startCustomerStorage();
    connection.current = customer.agent;
  });

  afterEach(async () => {
    await customer.close();
  });

  it('rethrows a masked error and reports a masked failure to the scheduler', async () => {
    customer.stub.objects.set('in/a.csv', { body: Buffer.from('a,b\n1,2\n'), contentType: 'text/csv', etag: '"x"' });
    const auth = signCustomerRequest('GET', 'in/a.csv', EMPTY_PAYLOAD_SHA256);
    const jobId = graphNodeJobId('g_mask_worker', 'in');
    const node = sealGraphNode({ op: 'import.url', url: auth.url, headers: auth.headers } as GraphNode, jobId);
    const job = {
      id: jobId,
      data: { graphId: 'g_mask_worker', graphNodeId: 'in', graphNode: node, inputArtifacts: [], options: {} },
      opts: { attempts: 1 },
      attemptsMade: 1,
      signal: new AbortController().signal,
      log: async () => {},
      updateProgress: async () => {},
    } as unknown as Job<ConversionJobData, ConversionJobResult>;
    // The storage backend fails the way an SDK would: quoting the request it was asked to make.
    const storage = {
      providerName: 'test-failing',
      saveObjectFromStream: async (_key: string, stream: NodeJS.ReadableStream) => {
        stream.resume();
        throw new Error(LEAKY);
      },
    } as unknown as IStorageBackend;
    const onNodeFailed = vi.spyOn(graphScheduler, 'onNodeFailed').mockResolvedValue({} as never);

    let thrown: Error | undefined;
    try {
      await processGraphNodeJob(job, undefined, storage);
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown?.message).toBe(MASKED);
    expectNoSecrets('thrown stack', thrown?.stack ?? '');
    expect(onNodeFailed).toHaveBeenCalledWith('g_mask_worker', 'in', MASKED);
  });
});
