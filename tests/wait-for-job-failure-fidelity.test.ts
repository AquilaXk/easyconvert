import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { payloadLimitStatus } from '../src/lib/api/payload-limit';
import { typedFailureProblem } from '../src/lib/api/typed-failure-response';
import { DistributedBullMQAdapter, Worker, type Job } from '../src/lib/queue/bullmq-engine';
import { conversionQueue, resourceQueues } from '../src/lib/queue/conversion-queue';
import { subscribeToJobTelemetry, type JobTelemetryEvent } from '../src/lib/queue/job-telemetry';
import {
  dispatchSyncRouteConversion,
  dispatchSyncWebTool,
  rehydrateQueuedJobFailure,
} from '../src/lib/queue/wait-for-job';
import * as workerPresence from '../src/lib/queue/worker-presence';
import { storageProvider } from '../src/lib/storage';
import {
  ArchiveInputUnprocessableError,
  CpuTaskAbortedError,
  DecompressionLimitError,
  EncryptedOfficeDocumentError,
  EngineMissingError,
  isUnprocessableInputError,
  PayloadLimitError,
  WORKER_OUTPUT_MISSING_DETAIL,
  WorkerOutputMissingError,
  type ConversionJobData,
  type ConversionJobResult,
} from '../src/lib/types';

function createPubSubRedisPair() {
  const subscribers = new Map<string, Set<EventEmitter>>();

  const makeClient = () => {
    const subEmitter = new EventEmitter();
    const subscribed = new Set<string>();
    const subClient = Object.assign(subEmitter, {
      status: 'ready',
      subscribe: vi.fn(async (...channels: string[]) => {
        for (const channel of channels) {
          subscribed.add(channel);
          let set = subscribers.get(channel);
          if (!set) {
            set = new Set();
            subscribers.set(channel, set);
          }
          set.add(subEmitter);
        }
        return subscribed.size;
      }),
      unsubscribe: vi.fn(async (...channels: string[]) => {
        for (const channel of channels) {
          subscribed.delete(channel);
          subscribers.get(channel)?.delete(subEmitter);
        }
        return 0;
      }),
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    });

    const deliver = (channel: string, message: string) => {
      for (const listener of subscribers.get(channel) ?? []) {
        queueMicrotask(() => {
          listener.emit('message', channel, message);
        });
      }
    };

    const client = {
      status: 'ready',
      on: vi.fn(),
      duplicate: vi.fn(() => subClient),
      eval: vi.fn(async () => 1),
      pipeline: vi.fn(() => {
        const queued: Array<[string, string]> = [];
        return {
          publish(channel: string, message: string) {
            queued.push([channel, message]);
            return this;
          },
          async exec() {
            for (const [channel, message] of queued) {
              deliver(channel, message);
            }
            return queued.map(() => [null, 1]);
          },
        };
      }),
      publish: vi.fn(async (channel: string, message: string) => {
        deliver(channel, message);
        return 1;
      }),
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    };

    return client;
  };

  return { makeClient };
}

describe('wait-for-job failure fidelity, targetQueue polling, and abort settlement', () => {
  const openWorkers: Worker<ConversionJobData, ConversionJobResult>[] = [];
  const openAdapters: DistributedBullMQAdapter<ConversionJobData, ConversionJobResult>[] = [];

  beforeEach(() => {
    vi.stubEnv('WEB_EXECUTION_MODE', 'queue-only');
    vi.spyOn(workerPresence, 'hasLiveQueueWorker').mockResolvedValue(true);
    vi.spyOn(storageProvider, 'saveObject').mockImplementation(async (key, buf, mimeType, originalFilename) => ({
      key,
      filename: originalFilename ?? 'input.bin',
      mimeType: mimeType ?? 'application/octet-stream',
      buffer: Buffer.from(buf),
      size: buf.length,
      etag: '"test"',
      uploadedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));
    vi.spyOn(storageProvider, 'deleteObject').mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.useRealTimers();
    while (openWorkers.length > 0) {
      await openWorkers.pop()!.close();
    }
    while (openAdapters.length > 0) {
      await openAdapters.pop()!.close();
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    workerPresence.resetLocalLiveWorkersForTests();
  });

  it('preserves <500 typed worker failures (413, 422) and EngineMissingError (503) via DistributedBullMQAdapter Pub/Sub telemetry', async () => {
    const { makeClient } = createPubSubRedisPair();
    const apiAdapter = new DistributedBullMQAdapter<ConversionJobData, ConversionJobResult>('pubsub-fidelity', {
      redisClient: makeClient() as never,
      keyPrefix: 'fidelity:',
    });
    const workerAdapter = new DistributedBullMQAdapter<ConversionJobData, ConversionJobResult>('pubsub-fidelity', {
      redisClient: makeClient() as never,
      keyPrefix: 'fidelity:',
    });
    openAdapters.push(apiAdapter, workerAdapter);

    const cases = [
      {
        jobId: 'job_413',
        error: new DecompressionLimitError('ZIP entry decoded past limit'),
        expectedStatus: 413,
        expectedCode: 'input_over_limit',
        expectedName: 'DecompressionLimitError',
      },
      {
        jobId: 'job_422',
        error: new EncryptedOfficeDocumentError('Workbook is encrypted with a password'),
        expectedStatus: 422,
        expectedCode: 'encrypted_input',
        expectedName: 'EncryptedOfficeDocumentError',
      },
      {
        jobId: 'job_503',
        error: new EngineMissingError('soffice binary not installed at /usr/bin/soffice'),
        expectedStatus: 503,
        expectedCode: 'engine_unavailable',
        expectedName: 'EngineMissingError',
      },
    ];

    for (const c of cases) {
      const events: JobTelemetryEvent[] = [];
      const unsubscribe = subscribeToJobTelemetry(apiAdapter, c.jobId, (ev) => events.push(ev));

      const workerJob = {
        id: c.jobId,
        data: {},
        opts: { attempts: 1 },
        attemptsMade: 1,
        finishedOn: Date.now(),
        failedReason: c.error.message,
        failedCode: c.error.name,
        failedStatus: (c.error as { status?: number }).status ?? (c.error instanceof EngineMissingError ? 503 : 400),
        failedRefusalCode: c.error.refusalCode,
        stacktrace: [],
        _attemptToken: 'tok_1',
      } as unknown as Job<ConversionJobData, ConversionJobResult>;

      expect(await workerAdapter._onJobFailed(workerJob, c.error)).toBe(true);
      await vi.waitFor(() => {
        expect(events.some((ev) => ev.event === 'failed')).toBe(true);
      });
      unsubscribe();

      const failedEv = events.find((ev) => ev.event === 'failed')!;
      const payload = failedEv.data as {
        error?: string;
        failedCode?: string;
        failedStatus?: number;
        failedRefusalCode?: string;
      };
      const rehydrated = rehydrateQueuedJobFailure({
        message: payload.error,
        failedCode: payload.failedCode,
        failedStatus: payload.failedStatus,
        failedRefusalCode: payload.failedRefusalCode,
      });

      expect(rehydrated.name).toBe(c.expectedName);
      if (c.expectedStatus === 413) {
        expect(rehydrated).toBeInstanceOf(PayloadLimitError);
        expect(payloadLimitStatus(rehydrated)).toBe(413);
      } else if (c.expectedStatus === 422) {
        expect(rehydrated).toBeInstanceOf(EncryptedOfficeDocumentError);
        expect(isUnprocessableInputError(rehydrated)).toBe(true);
      }
      const res = typedFailureProblem(rehydrated, '/api/v1/convert');
      expect(res.status).toBe(c.expectedStatus);
      const body = (await res.json()) as { status: number; code: string; detail: string };
      expect(body.status).toBe(c.expectedStatus);
      expect(body.code).toBe(c.expectedCode);
      expect(body.detail).not.toContain('/usr/bin/soffice');
    }

    const other422 = rehydrateQueuedJobFailure({
      message: 'Page range outside document bounds',
      failedCode: 'InvalidPageRangeError',
      failedStatus: 422,
      failedRefusalCode: 'invalid_pages',
    });
    expect(other422).toBeInstanceOf(ArchiveInputUnprocessableError);
    expect(isUnprocessableInputError(other422)).toBe(true);
    expect(other422.name).toBe('InvalidPageRangeError');

    const missingOut = rehydrateQueuedJobFailure({
      failedCode: 'WorkerOutputMissingError',
      failedStatus: 500,
      failedRefusalCode: 'conversion_failed',
      message: 'missing /tmp/out.pdf',
    });
    expect(missingOut).toBeInstanceOf(WorkerOutputMissingError);
    expect(missingOut.message).toContain(WORKER_OUTPUT_MISSING_DETAIL);
    expect(missingOut.message).not.toContain('/tmp/out.pdf');

    // Null/empty/non-numeric failedStatus in Pub/Sub payloads must never coerce to 0 or leak internals
    const poisonedEvents: JobTelemetryEvent[] = [];
    const poisonedUnsub = subscribeToJobTelemetry(apiAdapter, 'job_poisoned', (ev) => poisonedEvents.push(ev));
    await (workerAdapter.getRedisClient() as unknown as { publish(c: string, m: string): Promise<number> }).publish(
      'fidelity:pubsub-fidelity:events',
      JSON.stringify({
        event: 'failed',
        jobId: 'job_poisoned',
        error: 'crash at /tmp/sandbox_99/file.docx',
        failedCode: 'ConversionFailedError',
        failedStatus: null,
        failedRefusalCode: 'malformed_input',
      })
    );
    await vi.waitFor(() => {
      expect(poisonedEvents.some((ev) => ev.event === 'failed')).toBe(true);
    });
    poisonedUnsub();
    const poisonedPayload = poisonedEvents.find((ev) => ev.event === 'failed')!.data as {
      error?: string;
      failedCode?: string;
      failedStatus?: number;
      failedRefusalCode?: string;
    };
    expect(poisonedPayload.failedStatus).toBeUndefined();
    const poisonedErr = rehydrateQueuedJobFailure({
      message: poisonedPayload.error,
      failedCode: poisonedPayload.failedCode,
      failedStatus: poisonedPayload.failedStatus,
      failedRefusalCode: poisonedPayload.failedRefusalCode,
    });
    const poisonedRes = typedFailureProblem(poisonedErr, '/api/v1/convert');
    expect(poisonedRes.status).toBe(500);
    const poisonedBody = (await poisonedRes.json()) as { detail: string };
    expect(poisonedBody.detail).toBe('Internal conversion error');
  });

  it('preserves 413, 422, and 503 worker failures through dispatchSyncRouteConversion via both telemetry Pub/Sub and pollOnce fallback', async () => {
    const scenarios = [
      {
        label: '413 DecompressionLimitError',
        createError: () => new DecompressionLimitError('Compressed stream exceeded budget'),
        expectedStatus: 413,
        expectedCode: 'input_over_limit',
        expectedDetail: 'Compressed stream exceeded budget',
      },
      {
        label: '422 EncryptedOfficeDocumentError',
        createError: () => new EncryptedOfficeDocumentError('Document requires an open password'),
        expectedStatus: 422,
        expectedCode: 'encrypted_input',
        expectedDetail: 'Document requires an open password',
      },
      {
        label: '503 EngineMissingError',
        createError: () => new EngineMissingError('Required converter missing at /opt/libreoffice/program/soffice'),
        expectedStatus: 503,
        expectedCode: 'engine_unavailable',
        expectedDetail: 'Required converter missing at ***',
      },
    ];

    for (const s of scenarios) {
      // Path A: telemetry Pub/Sub event on targetQueue (resourceQueues.cpu)
      let capturedJobId = '';
      const origAdd = resourceQueues.cpu.add.bind(resourceQueues.cpu);
      const addSpy = vi.spyOn(resourceQueues.cpu, 'add').mockImplementation(async (name, data, opts) => {
        const res = await origAdd(name, data, opts);
        capturedJobId = res.id;
        return res;
      });

      const onNewListener = (eventName: string | symbol) => {
        if (capturedJobId && eventName === `telemetry:${capturedJobId}`) {
          resourceQueues.cpu.off('newListener', onNewListener);
          const err = s.createError();
          const status = (err as { status?: number }).status ?? (err instanceof EngineMissingError ? 503 : 400);
          queueMicrotask(() => {
            resourceQueues.cpu.emit(`telemetry:${capturedJobId}`, {
              event: 'failed',
              data: {
                jobId: capturedJobId,
                state: 'failed',
                error: err.message,
                failedCode: err.name,
                failedStatus: status,
                failedRefusalCode: err.refusalCode,
              },
            });
          });
        }
      };
      resourceQueues.cpu.on('newListener', onNewListener);

      const telemetryCaught = await dispatchSyncRouteConversion({
        inputBuffer: Buffer.from('PK\x03\x04'),
        sourceFormat: 'docx',
        targetFormat: 'pdf',
        options: {},
        originalFilename: 'doc.docx',
        userId: 'user_fidelity',
        tier: 'paid',
      }).catch((e: unknown) => e);
      addSpy.mockRestore();

      const telemetryRes = typedFailureProblem(telemetryCaught, '/api/v1/convert');
      expect(telemetryRes.status, `${s.label} telemetry status`).toBe(s.expectedStatus);
      const telemetryBody = (await telemetryRes.json()) as { status: number; code: string; detail: string };
      expect(telemetryBody.code).toBe(s.expectedCode);
      expect(telemetryBody.detail).toBe(s.expectedDetail);

      // Path B: pollOnce fallback with a real Worker on resourceQueues.cpu
      const worker = new Worker<ConversionJobData, ConversionJobResult>(
        [resourceQueues.cpu],
        async () => {
          throw s.createError();
        },
        { concurrency: 1 }
      );
      openWorkers.push(worker);

      const pollCaught = await dispatchSyncRouteConversion({
        inputBuffer: Buffer.from('PK\x03\x04'),
        sourceFormat: 'docx',
        targetFormat: 'pdf',
        options: {},
        originalFilename: 'doc.docx',
        userId: 'user_fidelity',
        tier: 'paid',
      }).catch((e: unknown) => e);
      await openWorkers.pop()!.close();

      const pollRes = typedFailureProblem(pollCaught, '/api/v1/convert');
      expect(pollRes.status, `${s.label} pollOnce status`).toBe(s.expectedStatus);
      const pollBody = (await pollRes.json()) as { status: number; code: string; detail: string };
      expect(pollBody.code).toBe(s.expectedCode);
      expect(pollBody.detail).toBe(s.expectedDetail);
    }
  });

  it('masks untyped worker crashes and >=500 typed faults to HTTP 500 Internal conversion error without leaking paths or downgrading to 400', async () => {
    const crashes = [
      {
        label: 'untyped RangeError with sandbox path',
        throwErr: () => new RangeError('worker exploded at /tmp/sandbox_99/file.docx'),
      },
      {
        label: '500 typed CpuTaskAbortedError',
        throwErr: () => new CpuTaskAbortedError('pdf'),
      },
    ];

    for (const c of crashes) {
      const worker = new Worker<ConversionJobData, ConversionJobResult>(
        [resourceQueues.cpu],
        async () => {
          throw c.throwErr();
        },
        { concurrency: 1 }
      );
      openWorkers.push(worker);

      const pollErr = await dispatchSyncRouteConversion({
        inputBuffer: Buffer.from('docx-bytes'),
        sourceFormat: 'docx',
        targetFormat: 'pdf',
        options: {},
        originalFilename: 'secret.docx',
        userId: 'user_crash',
        tier: 'free',
      }).catch((e: unknown) => e);
      await openWorkers.pop()!.close();

      const res = typedFailureProblem(pollErr, '/api/v1/convert');
      expect(res.status, c.label).toBe(500);
      const body = (await res.json()) as { status: number; detail: string; error: string; code?: string };
      expect(body.status).toBe(500);
      expect(body.detail).toBe('Internal conversion error');
      expect(body.error).toBe('Internal conversion error');
      expect(JSON.stringify(body)).not.toContain('/tmp/sandbox_99');
      expect(JSON.stringify(body)).not.toContain('worker exploded');
    }

    // Also verify forged/unknown refusal codes and missing/sub-400 status never leak or downgrade to 400
    const forgedTelemetry = rehydrateQueuedJobFailure({
      message: 'secret path /tmp/sandbox_99/file.docx',
      failedCode: 'ArbitraryError',
      failedStatus: 400,
      failedRefusalCode: 'not_an_allowlisted_code',
    });
    const forgedRes = typedFailureProblem(forgedTelemetry, '/api/v1/convert');
    expect(forgedRes.status).toBe(500);
    const forgedBody = (await forgedRes.json()) as { status: number; detail: string };
    expect(forgedBody.detail).toBe('Internal conversion error');

    const missingStatus = rehydrateQueuedJobFailure({
      message: 'leak /tmp/sandbox_99/x.pdf',
      failedCode: 'SomeFailure',
      failedRefusalCode: 'malformed_input',
    });
    const missingStatusRes = typedFailureProblem(missingStatus, '/api/v1/convert');
    expect(missingStatusRes.status).toBe(500);
    const missingStatusBody = (await missingStatusRes.json()) as { detail: string };
    expect(missingStatusBody.detail).toBe('Internal conversion error');
  });

  it('pollOnce queries non-default targetQueue directly without scanning conversionQueue when targetQueue holds the job', async () => {
    const cpuGetJobSpy = vi.spyOn(resourceQueues.cpu, 'getJob');
    const defaultGetJobSpy = vi.spyOn(conversionQueue, 'getJob');

    const worker = new Worker<ConversionJobData, ConversionJobResult>(
      [resourceQueues.cpu],
      async () => {
        throw new EncryptedOfficeDocumentError('Encrypted workbook');
      },
      { concurrency: 1 }
    );
    openWorkers.push(worker);

    const err = await dispatchSyncRouteConversion({
      inputBuffer: Buffer.from('xlsx-bytes'),
      sourceFormat: 'xlsx',
      targetFormat: 'pdf',
      options: {},
      originalFilename: 'locked.xlsx',
      userId: 'user_poll_target',
      tier: 'paid',
    }).catch((e: unknown) => e);
    await openWorkers.pop()!.close();

    expect(typedFailureProblem(err, '/api/v1/convert').status).toBe(422);
    expect(cpuGetJobSpy).toHaveBeenCalled();
    expect(defaultGetJobSpy).not.toHaveBeenCalled();

    // Also verify dispatchSyncWebTool preserves 413 failure fidelity and removes via resourceQueues.cpu
    cpuGetJobSpy.mockClear();
    defaultGetJobSpy.mockClear();
    const cpuRemoveSpy = vi.spyOn(resourceQueues.cpu, 'remove');
    const defaultRemoveSpy = vi.spyOn(conversionQueue, 'remove');
    const toolWorker = new Worker<ConversionJobData, ConversionJobResult>(
      [resourceQueues.cpu],
      async () => {
        throw new DecompressionLimitError('Archive tool entry exceeded byte limit');
      },
      { concurrency: 1 }
    );
    openWorkers.push(toolWorker);

    const toolErr = await dispatchSyncWebTool({
      tool: 'merge',
      files: [
        { name: 'a.pdf', buffer: Buffer.from('%PDF-1.4\n') },
        { name: 'b.pdf', buffer: Buffer.from('%PDF-1.4\n') },
      ],
      options: {},
      userId: 'user_tool_413',
      tier: 'paid',
    }).catch((e: unknown) => e);
    await openWorkers.pop()!.close();

    const toolRes = typedFailureProblem(toolErr, '/api/tools/merge');
    expect(toolRes.status).toBe(413);
    const toolBody = (await toolRes.json()) as { code: string; detail: string };
    expect(toolBody.code).toBe('input_over_limit');
    expect(toolBody.detail).toBe('Archive tool entry exceeded byte limit');
    expect(cpuGetJobSpy).toHaveBeenCalled();
    expect(defaultGetJobSpy).not.toHaveBeenCalled();
    expect(cpuRemoveSpy).toHaveBeenCalledTimes(1);
    expect(defaultRemoveSpy).not.toHaveBeenCalled();
  });

  it('defers staged-input deletion on abort until active worker transitions out of active within 1s, and leaves input & job untouched if still active past 1s', async () => {
    vi.useFakeTimers();

    // Case 1: active job settles out of 'active' at 150ms -> tempInputKey deleted & targetQueue.remove called (never conversionQueue.remove)
    {
      const deleteSpy = vi.spyOn(storageProvider, 'deleteObject').mockResolvedValue(true);
      const cpuRemoveSpy = vi.spyOn(resourceQueues.cpu, 'remove').mockResolvedValue(true);
      const defaultRemoveSpy = vi.spyOn(conversionQueue, 'remove');

      let jobState: 'active' | 'cancelled' = 'active';
      const fakeJob = {
        id: 'sync_settle',
        state: 'active',
        getState: () => jobState,
      } as unknown as Job<ConversionJobData, ConversionJobResult>;

      const origAdd = resourceQueues.cpu.add.bind(resourceQueues.cpu);
      const addSpy = vi.spyOn(resourceQueues.cpu, 'add').mockImplementation(async (name, data, opts) => {
        const job = await origAdd(name, data, opts);
        fakeJob.id = job.id;
        return job;
      });
      const getJobSpy = vi.spyOn(resourceQueues.cpu, 'getJob').mockResolvedValue(fakeJob);
      const cancelSpy = vi.spyOn(conversionQueue, 'cancelJob').mockImplementation(async () => {
        setTimeout(() => {
          jobState = 'cancelled';
          fakeJob.state = 'cancelled';
        }, 150);
        return true;
      });

      let listenerReady!: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        listenerReady = resolve;
      });
      const onNewListener = (eventName: string | symbol) => {
        if (fakeJob.id && eventName === `telemetry:${fakeJob.id}`) {
          resourceQueues.cpu.off('newListener', onNewListener);
          listenerReady();
        }
      };
      resourceQueues.cpu.on('newListener', onNewListener);

      const ac = new AbortController();
      const promise = dispatchSyncRouteConversion({
        inputBuffer: Buffer.from('docx-bytes'),
        sourceFormat: 'docx',
        targetFormat: 'pdf',
        options: { signal: ac.signal },
        originalFilename: 'abort-settle.docx',
        userId: 'user_abort_1',
        tier: 'paid',
      });
      const settled = promise.catch((e: unknown) => e);

      await readyPromise;
      ac.abort(new Error('Client closed'));

      await vi.advanceTimersByTimeAsync(50);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(cpuRemoveSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(150);
      const err = await settled;
      expect((err as Error).message).toBe('Client closed');
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(cpuRemoveSpy).toHaveBeenCalledWith(fakeJob.id);
      expect(defaultRemoveSpy).not.toHaveBeenCalled();

      addSpy.mockRestore();
      getJobSpy.mockRestore();
      cancelSpy.mockRestore();
      cpuRemoveSpy.mockRestore();
      defaultRemoveSpy.mockRestore();
      deleteSpy.mockRestore();
    }

    // Case 2: active job ignores abort and stays 'active' past 1_000 ms -> tempInputKey NOT deleted, targetQueue.remove NOT called
    {
      const deleteSpy = vi.spyOn(storageProvider, 'deleteObject').mockResolvedValue(true);
      const cpuRemoveSpy = vi.spyOn(resourceQueues.cpu, 'remove').mockResolvedValue(true);

      const stuckJob = {
        id: 'sync_stuck',
        state: 'active',
        getState: () => 'active' as const,
      } as unknown as Job<ConversionJobData, ConversionJobResult>;

      const origAdd = resourceQueues.cpu.add.bind(resourceQueues.cpu);
      const addSpy = vi.spyOn(resourceQueues.cpu, 'add').mockImplementation(async (name, data, opts) => {
        const job = await origAdd(name, data, opts);
        stuckJob.id = job.id;
        return job;
      });
      const getJobSpy = vi.spyOn(resourceQueues.cpu, 'getJob').mockResolvedValue(stuckJob);
      const cancelSpy = vi.spyOn(conversionQueue, 'cancelJob').mockResolvedValue(true);

      let listenerReady!: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        listenerReady = resolve;
      });
      const onNewListener = (eventName: string | symbol) => {
        if (stuckJob.id && eventName === `telemetry:${stuckJob.id}`) {
          resourceQueues.cpu.off('newListener', onNewListener);
          listenerReady();
        }
      };
      resourceQueues.cpu.on('newListener', onNewListener);

      const ac = new AbortController();
      const promise = dispatchSyncWebTool({
        tool: 'merge',
        files: [
          { name: 'a.pdf', buffer: Buffer.from('%PDF-1.4\n') },
          { name: 'b.pdf', buffer: Buffer.from('%PDF-1.4\n') },
        ],
        options: {},
        userId: 'user_abort_2',
        tier: 'paid',
        signal: ac.signal,
      });
      const settled = promise.catch((e: unknown) => e);

      await readyPromise;
      ac.abort(new Error('Deadline reached'));
      await vi.advanceTimersByTimeAsync(1_100);

      const err = await settled;
      expect((err as Error).message).toBe('Deadline reached');
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(cpuRemoveSpy).not.toHaveBeenCalled();
      expect(getJobSpy.mock.calls.length).toBeLessThanOrEqual(22);

      addSpy.mockRestore();
      getJobSpy.mockRestore();
      cancelSpy.mockRestore();
      cpuRemoveSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });
});

// skip-ok: mode selection. Standard test shards run without REDIS_URL; Redis integration runs set REDIS_URL.
describe.runIf(Boolean(process.env.REDIS_URL))(
  'real Redis DistributedBullMQAdapter + Worker failure round-trip',
  () => {
    const REDIS_URL = process.env.REDIS_URL as string;
    const PUBSUB_SUBSCRIBERS = 2;
    let keyPrefix: string;
    let admin: Redis;
    const workers: Worker<ConversionJobData, ConversionJobResult>[] = [];
    const adapters: DistributedBullMQAdapter<ConversionJobData, ConversionJobResult>[] = [];

    function connect(queueName: string): DistributedBullMQAdapter<ConversionJobData, ConversionJobResult> {
      const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
      const adapter = new DistributedBullMQAdapter<ConversionJobData, ConversionJobResult>(queueName, {
        redisClient: client,
        keyPrefix,
      });
      adapters.push(adapter);
      return adapter;
    }

    beforeEach(() => {
      keyPrefix = `wait-fidelity-${crypto.randomBytes(6).toString('hex')}:`;
      admin = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    });

    afterEach(async () => {
      while (workers.length > 0) {
        await workers.pop()!.close();
      }
      while (adapters.length > 0) {
        await adapters.pop()!.close();
      }
      const keys = await admin.keys(`${keyPrefix}*`);
      if (keys.length > 0) {
        await admin.del(...keys);
      }
      await admin.quit();
    });

    it('propagates 422 EncryptedOfficeDocumentError and untyped crash -> 500 Internal conversion error across Redis Pub/Sub and stored job hash', async () => {
      const queueName = 'wait-fidelity-redis';
      const apiAdapter = connect(queueName);
      const workerAdapter = connect(queueName);
      await vi.waitFor(async () => {
        const [, count] = (await admin.pubsub('NUMSUB', `${keyPrefix}${queueName}:events`)) as [string, number];
        expect(count).toBe(PUBSUB_SUBSCRIBERS);
      });

      const job422 = await apiAdapter.add('convert', { originalFilename: 'locked.xlsx' } as ConversionJobData, { attempts: 1 });
      const jobCrash = await apiAdapter.add('convert', { originalFilename: 'crash.docx' } as ConversionJobData, { attempts: 1 });

      const events422: JobTelemetryEvent[] = [];
      const eventsCrash: JobTelemetryEvent[] = [];
      const unsub422 = subscribeToJobTelemetry(apiAdapter, job422.id, (ev) => events422.push(ev));
      const unsubCrash = subscribeToJobTelemetry(apiAdapter, jobCrash.id, (ev) => eventsCrash.push(ev));

      const worker = new Worker<ConversionJobData, ConversionJobResult>(
        workerAdapter,
        async (job) => {
          if (job.id === job422.id) {
            throw new EncryptedOfficeDocumentError('Workbook is encrypted');
          }
          throw new RangeError('boom at /tmp/sandbox_99/file.docx');
        },
        { concurrency: 1 }
      );
      workers.push(worker);

      try {
        await vi.waitFor(
          () => {
            expect(events422.some((ev) => ev.event === 'failed')).toBe(true);
            expect(eventsCrash.some((ev) => ev.event === 'failed')).toBe(true);
          },
          { timeout: 10_000 }
        );
      } finally {
        unsub422();
        unsubCrash();
      }

      const ev422 = events422.find((ev) => ev.event === 'failed')!.data as {
        error?: string;
        failedCode?: string;
        failedStatus?: number;
        failedRefusalCode?: string;
      };
      expect(ev422).toMatchObject({
        failedCode: 'EncryptedOfficeDocumentError',
        failedStatus: 422,
        failedRefusalCode: 'encrypted_input',
      });
      const rehydrated422 = rehydrateQueuedJobFailure({
        message: ev422.error,
        failedCode: ev422.failedCode,
        failedStatus: ev422.failedStatus,
        failedRefusalCode: ev422.failedRefusalCode,
      });
      expect(isUnprocessableInputError(rehydrated422)).toBe(true);
      const res422 = typedFailureProblem(rehydrated422, '/api/v1/convert');
      expect(res422.status).toBe(422);
      expect(await res422.json()).toMatchObject({ status: 422, code: 'encrypted_input', detail: 'Workbook is encrypted' });

      const evCrash = eventsCrash.find((ev) => ev.event === 'failed')!.data as {
        error?: string;
        failedCode?: string;
        failedStatus?: number;
        failedRefusalCode?: string;
      };
      expect(evCrash.failedCode).toBeUndefined();
      expect(evCrash.failedStatus).toBeUndefined();
      expect(evCrash.failedRefusalCode).toBeUndefined();
      const rehydratedCrash = rehydrateQueuedJobFailure({
        message: evCrash.error,
        failedCode: evCrash.failedCode,
        failedStatus: evCrash.failedStatus,
        failedRefusalCode: evCrash.failedRefusalCode,
      });
      const resCrash = typedFailureProblem(rehydratedCrash, '/api/v1/convert');
      expect(resCrash.status).toBe(500);
      const crashBody = (await resCrash.json()) as { status: number; detail: string; error: string };
      expect(crashBody.detail).toBe('Internal conversion error');
      expect(crashBody.error).toBe('Internal conversion error');
      expect(JSON.stringify(crashBody)).not.toContain('/tmp/sandbox_99');

      const stored422 = await apiAdapter.getJob(job422.id);
      expect(stored422).toMatchObject({
        state: 'failed',
        failedCode: 'EncryptedOfficeDocumentError',
        failedStatus: 422,
        failedRefusalCode: 'encrypted_input',
      });
    });
  }
);
