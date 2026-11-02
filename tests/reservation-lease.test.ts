import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { itLeasesHandedOffWork, itLeasesReservations } from './helpers/reservation-lease-cases';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { MemoryReservationLedger, RESERVATION_LEASE } from '../src/lib/api-keys/reservation-ledger';
import { withReservedUnit } from '../src/lib/api-keys/guard';
import type { ReservedUnit } from '../src/lib/api-keys/hand-off';
import { JOB_DEADLINE_CEILING_MS } from '../src/lib/config/schema';
import { JobDeadlineError, jobDeadlineSettings } from '../src/lib/queue/job-deadline';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { userStore } from '../src/lib/auth/user-store';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { Queue, Worker } from '../src/lib/queue/bullmq-engine';
import { attachJobLifecycleListeners, getJobAcrossQueues } from '../src/lib/queue/conversion-queue';
import { InMemoryGraphScheduler } from '../src/lib/queue/graph/in-memory-scheduler';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { QueueUnavailableError, type ConversionJobData, type ConversionJobResult } from '../src/lib/types';
import { storageProvider } from '../src/lib/storage';
import { FileRetentionLedger, getRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import { restoreIsolatedRetentionLedger } from './helpers/isolated-retention-ledger';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';

// The quota store picks Redis or this process when it is first imported.
vi.hoisted(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const HOUR_MS = 60 * 60 * 1000;

const freshOwner = () => anonymousUserId(`203.0.113.${crypto.randomInt(1, 255)}-${crypto.randomBytes(4).toString('hex')}`);

describe('a reservation in this process', () => {
  let store = new RedisKeyStore({ isolated: true });
  let owner = freshOwner();
  itLeasesReservations({
    store: () => store,
    owner: () => owner,
    advance: async (ms) => {
      vi.setSystemTime(Date.now() + ms);
    },
  });
  afterEach(() => {
    store = new RedisKeyStore({ isolated: true });
    owner = freshOwner();
  });
});

describe('a reservation handed to queued work in this process', () => {
  let owner = freshOwner();
  itLeasesHandedOffWork({
    owner: () => owner,
    advance: async (ms) => {
      vi.setSystemTime(Date.now() + ms);
    },
  });
  afterEach(() => {
    owner = freshOwner();
  });
});

describe('a reservation a request hands to queued work', () => {
  const used = async (owner: string) => (await redisKeyStore.getQuotaUsage(owner)).usedToday;

  async function reservedUnit(owner: string): Promise<string> {
    const unit = await redisKeyStore.reserveQuota(owner, 1);
    expect(unit.allowed).toBe(true);
    return unit.reservationId as string;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers the work its enqueue stored before it failed, and leaves the unit to that work', async () => {
    const owner = freshOwner();
    const reservationId = await reservedUnit(owner);
    let stored: { reservationId?: string } | undefined;

    const answered = await withReservedUnit(reservationId, (unit) =>
      unit.handOff({
        start: async (id) => {
          stored = { reservationId: id };
          throw new QueueUnavailableError('convert', 'the reply was lost');
        },
        recover: async () => (stored ? { status: 'started', work: stored } : { status: 'unknown' }),
      })
    );

    expect(answered).toEqual({ reservationId });
    expect(await used(owner)).toBe(1);
    expect(await redisKeyStore.commitQuota(reservationId)).toBe(true);
    expect(await used(owner)).toBe(1);
  });

  it('gives the unit back at once when the work certainly did not start', async () => {
    const owner = freshOwner();
    const reservationId = await reservedUnit(owner);

    await expect(
      withReservedUnit(reservationId, (unit) =>
        unit.handOff({
          start: async () => {
            throw new QueueUnavailableError('convert', 'refused');
          },
          recover: async () => ({ status: 'not-started' }),
        })
      )
    ).rejects.toBeInstanceOf(QueueUnavailableError);

    expect(await used(owner)).toBe(0);
  });

  it.each([
    ['finds nothing', async () => ({ status: 'unknown' as const })],
    [
      'fails',
      async () => {
        throw new QueueUnavailableError('convert', 'still down');
      },
    ],
  ])('keeps the unit on the provisional lease when the lookup after a failed start %s, and gives it back when that lease ends', async (_label, recover) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const owner = freshOwner();
    const reservationId = await reservedUnit(owner);

    await expect(
      withReservedUnit(reservationId, (unit) =>
        unit.handOff({
          start: async () => {
            throw new QueueUnavailableError('convert', 'the reply was lost');
          },
          recover,
        })
      )
    ).rejects.toBeInstanceOf(QueueUnavailableError);

    expect(await used(owner)).toBe(1);
    vi.setSystemTime(Date.now() + RESERVATION_LEASE.provisionalMs - 1000);
    expect(await used(owner)).toBe(1);
    vi.setSystemTime(Date.now() + 2000);
    expect(await used(owner)).toBe(0);
  });

  it('leaves the unit on the provisional lease after a start whose outcome is unknown, writing nothing to the store that failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const owner = freshOwner();
    const reservationId = await reservedUnit(owner);
    const renew = vi.spyOn(MemoryReservationLedger.prototype, 'renew');
    let renewalsBeforeStart = 0;

    await expect(
      withReservedUnit(reservationId, (unit) =>
        unit.handOff({
          start: async () => {
            renewalsBeforeStart = renew.mock.calls.length;
            renew.mockRejectedValue(new QueueUnavailableError('reservation', 'the store is down'));
            throw new QueueUnavailableError('convert', 'the reply was lost');
          },
          recover: async () => ({ status: 'unknown' }),
        })
      )
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    const renewalsAfterStart = renew.mock.calls.length - renewalsBeforeStart;
    renew.mockRestore();

    expect(renewalsAfterStart).toBe(0);
    vi.setSystemTime(Date.now() + RESERVATION_LEASE.provisionalMs + 1000);
    expect(await used(owner)).toBe(0);
  });

  it('starts no work and refuses with a retry when the renewal before the hand-off throws', async () => {
    const owner = freshOwner();
    const reservationId = await reservedUnit(owner);
    const start = vi.fn(async () => 'queued');
    vi.spyOn(redisKeyStore, 'renewReservation').mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(withReservedUnit(reservationId, (unit) => unit.handOff({ start, recover: async () => ({ status: 'unknown' }) }))).rejects.toBeInstanceOf(
      QueueUnavailableError
    );

    expect(start).not.toHaveBeenCalled();
    expect(await used(owner)).toBe(0);
    vi.restoreAllMocks();
  });

  it('starts no work and refuses with a retry when the lease ended before the hand-off', async () => {
    const owner = freshOwner();
    const reservationId = await reservedUnit(owner);
    const start = vi.fn(async () => 'queued');

    await expect(
      withReservedUnit(reservationId, async (unit) => {
        await redisKeyStore.rollbackQuota(reservationId);
        return unit.handOff({ start, recover: async () => ({ status: 'unknown' }) });
      })
    ).rejects.toBeInstanceOf(QueueUnavailableError);

    expect(start).not.toHaveBeenCalled();
    expect(await used(owner)).toBe(0);
  });

  it.each([
    ['commits', (unit: ReservedUnit) => unit.commit()],
    ['hands its unit off', (unit: ReservedUnit) => unit.handOff({ start: async () => 'queued', recover: async () => ({ status: 'unknown' }) })],
    [
      'throws',
      async () => {
        throw new Error('the conversion failed');
      },
    ],
    ['ends without a charge', async () => undefined],
  ])('stops renewing the lease once the request %s', async (_label, end) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const reservationId = await reservedUnit(freshOwner());
    let timersWhileRunning = 0;

    await withReservedUnit(reservationId, async (unit) => {
      timersWhileRunning = vi.getTimerCount();
      await end(unit);
    }).catch(() => undefined);

    expect(timersWhileRunning).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives handed-off work a lease of a day, at least an hour longer than the longest job deadline the settings accept', () => {
    expect(() => jobDeadlineSettings({ JOB_DEADLINE_MAX_MS_ENTERPRISE: String(JOB_DEADLINE_CEILING_MS + 1) })).toThrow(JobDeadlineError);
    expect(RESERVATION_LEASE.handedOffMs).toBe(24 * HOUR_MS);
    expect(JOB_DEADLINE_CEILING_MS).toBeLessThanOrEqual(23 * HOUR_MS);
  });

  it('renews the lease while the request runs, so a long conversion is still charged', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const owner = freshOwner();
    const reservationId = await reservedUnit(owner);

    await withReservedUnit(reservationId, async (unit) => {
      await vi.advanceTimersByTimeAsync(5 * RESERVATION_LEASE.provisionalMs);
      await unit.commit();
    });

    expect(await used(owner)).toBe(1);
  });
});

describe('queued work that takes a reservation', () => {
  const PAST_THE_PROVISIONAL_LEASE_MS = RESERVATION_LEASE.provisionalMs + 1000;
  const used = async (owner: string) => (await redisKeyStore.getQuotaUsage(owner)).usedToday;
  const workers: Worker<ConversionJobData, ConversionJobResult>[] = [];

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    vi.useRealTimers();
  });

  it('charges a job that a worker takes while its reservation is on the provisional lease, when it ends after that lease would have', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const owner = freshOwner();
    const unit = await redisKeyStore.reserveQuota(owner, 1);
    const reservationId = unit.reservationId as string;
    const queue = new Queue<ConversionJobData, ConversionJobResult>(`lease-pickup-${crypto.randomBytes(4).toString('hex')}`);
    const worker = new Worker<ConversionJobData, ConversionJobResult>(queue, async (job) => {
      await new Promise((resolve) => setImmediate(resolve));
      vi.setSystemTime(Date.now() + PAST_THE_PROVISIONAL_LEASE_MS);
      return { jobId: job.id, status: 'completed' } as ConversionJobResult;
    });
    workers.push(worker);
    attachJobLifecycleListeners(worker);

    await queue.add('convert', { jobId: '', originalFilename: 'a.csv', sourceFormat: 'csv', targetFormat: 'json', fileSize: 1, options: {}, userId: owner, reservationId }, {});

    await vi.waitFor(async () => expect(await redisKeyStore.renewReservation(reservationId, 1)).toBe(false), { timeout: 5_000, interval: 20 });
    expect(await used(owner)).toBe(1);
  });

  it('charges a graph that ends after the provisional lease of its reservation would have', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
    const owner = freshOwner();
    const unit = await redisKeyStore.reserveQuota(owner, 1);
    const scheduler = new InMemoryGraphScheduler();
    const graphId = `graph_lease_${crypto.randomBytes(6).toString('hex')}`;
    const key = `uploads/${graphId}/a.csv`;
    await scheduler.initGraph(graphId, sealGraph(graphId, { failurePolicy: 'fail_fast', nodes: { up: { op: 'import.upload', storageKey: key } } } as never), { ownerUserId: owner, reservationId: unit.reservationId });

    vi.setSystemTime(Date.now() + PAST_THE_PROVISIONAL_LEASE_MS);
    expect(await scheduler.onNodeCompleted(graphId, 'up', [key], 1)).toMatchObject({ graphCompleted: true });

    expect(await used(owner)).toBe(1);
    vi.restoreAllMocks();
  });
});

describe('POST /api/v1/jobs when the password of a job or a graph cannot be sealed', () => {
  const PDF = Buffer.from('%PDF-1.7\n').toString('base64');

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('REDIS_HOST', '');
  });

  it.each([
    ['a job', { filename: 'locked.pdf', targetFormat: 'docx', inputBufferBase64: PDF, options: { password: 'open-sesame' } }],
    ['a graph', { filename: 'locked.pdf', inputBufferBase64: PDF, tasks: [{ name: 'unlock', operation: 'convert', targetFormat: 'docx', options: { password: 'open-sesame' } }] }],
  ])('answers 503 for %s and gives the unit back at once, since nothing was handed off', async (_label, body) => {
    const user = await userStore.createUser({ email: `seal_${crypto.randomBytes(6).toString('hex')}@lease.test`, name: 'seal', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'seal', { scopes: ['convert:write'] });
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('KEY_HASH_PEPPER', 'pepper-for-this-test-0123456789abcdef');
    for (const name of ['JOB_SECRET_KEK', 'STORAGE_VAULT_KEY', 'KEY_ENCRYPTION_KEY', 'JWT_SECRET']) vi.stubEnv(name, '');

    const res = await createJob(
      new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify(body),
      })
    );

    expect(res.status).toBe(503);
    expect((await res.json()).detail).toBe('Job credentials cannot be stored securely right now. Try again later.');
    expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(0);
  });
});

describe('POST /api/v1/jobs when the queue stores the job and then fails', () => {
  const CSV = 'name,score\nAlice,100\n';
  let ledgerDir: string;

  beforeEach(() => {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-lease-holds-'));
    setRetentionLedger(new FileRetentionLedger(ledgerDir));
    const add = Queue.prototype.add;
    vi.spyOn(Queue.prototype, 'add').mockImplementation(async function (this: Queue, ...args) {
      await add.apply(this, args);
      throw new QueueUnavailableError(this.name, 'the reply was lost');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreIsolatedRetentionLedger();
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  });

  async function submit(body: Record<string, unknown>): Promise<{ res: Response; userId: string }> {
    const user = await userStore.createUser({ email: `lease_${crypto.randomBytes(6).toString('hex')}@lease.test`, name: 'lease', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'lease', { scopes: ['convert:write'] });
    const res = await createJob(
      new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({ targetFormat: 'json', ...body }),
      })
    );
    return { res, userId: user.id };
  }

  it('answers the stored job and leaves the unit to it, so the job is charged when it completes', async () => {
    const { res, userId } = await submit({ filename: 'scores.csv', inputBufferBase64: Buffer.from(CSV).toString('base64') });

    expect(res.status).toBe(202);
    const { jobId, reservationId } = await res.json();
    expect((await getJobAcrossQueues(jobId))?.data.reservationId).toBe(reservationId);
    expect((await redisKeyStore.getQuotaUsage(userId)).usedToday).toBe(1);
  });

  it('keeps the hold on the stored input of a job whose lookup failed too, for that job to end if it was stored', async () => {
    vi.spyOn(Queue.prototype, 'getJob').mockRejectedValue(new QueueUnavailableError('convert', 'still down'));
    const key = `uploads/lease-${crypto.randomBytes(6).toString('hex')}/scores.csv`;
    await storageProvider.saveObject(key, Buffer.from(CSV), 'text/csv', 'scores.csv');
    try {
      const { res } = await submit({ storageKey: key });

      expect(res.status).toBe(503);
      const jobId = vi.mocked(Queue.prototype.add).mock.calls[0][2]?.jobId as string;
      expect((await getRetentionLedger().get(key))?.holds?.[jobId]).toBeGreaterThan(Date.now());
    } finally {
      await storageProvider.deleteObject(key);
    }
  });

  it('keeps the hold the stored job took on the stored input it reads', async () => {
    const key = `uploads/lease-${crypto.randomBytes(6).toString('hex')}/scores.csv`;
    await storageProvider.saveObject(key, Buffer.from(CSV), 'text/csv', 'scores.csv');
    try {
      const { res } = await submit({ storageKey: key });

      expect(res.status).toBe(202);
      const { jobId } = await res.json();
      expect((await getRetentionLedger().get(key))?.holds?.[jobId]).toBeGreaterThan(Date.now());
    } finally {
      await storageProvider.deleteObject(key);
    }
  });
});
