import crypto from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { itLeasesReservations } from './helpers/reservation-lease-cases';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { RESERVATION_LEASE } from '../src/lib/api-keys/reservation-ledger';
import { withReservedUnit } from '../src/lib/api-keys/guard';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { userStore } from '../src/lib/auth/user-store';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { Queue } from '../src/lib/queue/bullmq-engine';
import { getJobAcrossQueues } from '../src/lib/queue/conversion-queue';
import { QueueUnavailableError } from '../src/lib/types';

// The quota store picks Redis or this process when it is first imported.
vi.hoisted(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

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
        recover: async () => stored,
      })
    );

    expect(answered).toEqual({ reservationId });
    expect(await used(owner)).toBe(1);
    expect(await redisKeyStore.commitQuota(reservationId)).toBe(true);
    expect(await used(owner)).toBe(1);
  });

  it('gives the unit back when the enqueue failed before it stored the work', async () => {
    const owner = freshOwner();
    const reservationId = await reservedUnit(owner);

    await expect(
      withReservedUnit(reservationId, (unit) =>
        unit.handOff({
          start: async () => {
            throw new QueueUnavailableError('convert', 'refused');
          },
          recover: async () => undefined,
        })
      )
    ).rejects.toBeInstanceOf(QueueUnavailableError);

    expect(await used(owner)).toBe(0);
  });

  it('leaves the unit to the work and its lease when the work cannot be looked up after a failed enqueue', async () => {
    const owner = freshOwner();
    const reservationId = await reservedUnit(owner);

    await expect(
      withReservedUnit(reservationId, (unit) =>
        unit.handOff({
          start: async () => {
            throw new QueueUnavailableError('convert', 'the reply was lost');
          },
          recover: async () => {
            throw new QueueUnavailableError('convert', 'still down');
          },
        })
      )
    ).rejects.toBeInstanceOf(QueueUnavailableError);

    expect(await used(owner)).toBe(1);
    expect(await redisKeyStore.commitQuota(reservationId)).toBe(true);
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
  it('answers the stored job and leaves the unit to it, so the job is charged when it completes', async () => {
    const user = await userStore.createUser({ email: `lease_${crypto.randomBytes(6).toString('hex')}@lease.test`, name: 'lease', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'lease', { scopes: ['convert:write'] });
    const add = Queue.prototype.add;
    vi.spyOn(Queue.prototype, 'add').mockImplementation(async function (this: Queue, ...args) {
      await add.apply(this, args);
      throw new QueueUnavailableError(this.name, 'the reply was lost');
    });
    try {
      const res = await createJob(
        new NextRequest('https://easyconvert.app/api/v1/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
          body: JSON.stringify({ filename: 'scores.csv', targetFormat: 'json', inputBufferBase64: Buffer.from('name,score\nAlice,100\n').toString('base64') }),
        })
      );

      expect(res.status).toBe(202);
      const { jobId, reservationId } = await res.json();
      expect((await getJobAcrossQueues(jobId))?.data.reservationId).toBe(reservationId);
      expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
