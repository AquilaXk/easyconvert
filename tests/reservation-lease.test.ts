import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { itLeasesReservations } from './helpers/reservation-lease-cases';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { RESERVATION_LEASE } from '../src/lib/api-keys/reservation-ledger';
import { withReservedUnit, type ReservedUnit } from '../src/lib/api-keys/guard';
import { JOB_DEADLINE_CEILING_MS } from '../src/lib/config/schema';
import { JobDeadlineError, jobDeadlineSettings } from '../src/lib/queue/job-deadline';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { userStore } from '../src/lib/auth/user-store';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { Queue } from '../src/lib/queue/bullmq-engine';
import { getJobAcrossQueues } from '../src/lib/queue/conversion-queue';
import { QueueUnavailableError } from '../src/lib/types';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { FileRetentionLedger, getRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import { restoreIsolatedRetentionLedger } from './helpers/isolated-retention-ledger';

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

    await withReservedUnit(reservationId, async (unit) => {
      expect(vi.getTimerCount()).toBe(1);
      await end(unit);
    }).catch(() => undefined);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives handed-off work a lease longer than the longest job deadline the settings accept, by an hour', () => {
    expect(() => jobDeadlineSettings({ JOB_DEADLINE_MAX_MS_ENTERPRISE: String(25 * HOUR_MS) })).toThrow(JobDeadlineError);
    expect(RESERVATION_LEASE.handedOffMs).toBeGreaterThanOrEqual(Math.max(24 * HOUR_MS, JOB_DEADLINE_CEILING_MS + HOUR_MS));
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

  it('keeps the hold the stored job took on the stored input it reads', async () => {
    const key = `uploads/lease-${crypto.randomBytes(6).toString('hex')}/scores.csv`;
    s3Storage.saveObject(key, Buffer.from(CSV), 'text/csv', 'scores.csv');
    try {
      const { res } = await submit({ storageKey: key });

      expect(res.status).toBe(202);
      const { jobId } = await res.json();
      expect((await getRetentionLedger().get(key))?.holds?.[jobId]).toBeGreaterThan(Date.now());
    } finally {
      s3Storage.deleteObject(key);
    }
  });
});
