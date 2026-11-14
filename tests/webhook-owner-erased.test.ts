import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { webhookDispatcher, type WebhookDispatchResult, type WebhookJobData } from '../src/lib/api-keys/webhook-dispatcher';
import { TERMS_VERSION } from '../src/lib/legal/documents';

const TARGET = 'https://93.184.215.14/hook';
const failedDelivery: WebhookDispatchResult = {
  id: 'wh_x',
  url: TARGET,
  event: 'job.failed',
  success: false,
  totalAttempts: 1,
  finalStatusCode: 500,
  durationMs: 1,
  attempts: [{ attempt: 1, statusCode: 500, durationMs: 1, timestamp: 0 } as never],
};

function queuedDelivery(ownerUserId: string): WebhookJobData {
  return {
    deliveryId: `wh_${crypto.randomBytes(4).toString('hex')}`,
    targetUrl: TARGET,
    event: 'job.failed',
    data: { jobId: 'j' },
    secret: '',
    // One attempt is the last: the delivery that fails now goes to the dead letters.
    options: { ownerUserId, maxRetries: 1 },
    attemptNumber: 1,
    attempts: [],
    createdAt: Date.now(),
  };
}

/** Runs the worker's step for one queued delivery. */
function process(data: WebhookJobData) {
  return (webhookDispatcher as unknown as { processQueuedJob(job: { data: WebhookJobData }): Promise<WebhookDispatchResult> }).processQueuedJob({ data });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a queued webhook delivery of an account', () => {
  it('is dropped when the account no longer exists: nothing is sent and no dead letter names it', async () => {
    const dispatch = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue(failedDelivery);
    const saveToDlq = vi.spyOn(webhookDispatcher, 'saveToDlq').mockResolvedValue(undefined as never);

    const result = await process(queuedDelivery(`erased_${crypto.randomUUID()}`));

    expect(dispatch).not.toHaveBeenCalled();
    expect(saveToDlq).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
  });

  it('is not written to the dead letters when the account was erased while the attempt ran', async () => {
    const user = await redisUserStore.createUser({ email: `hook_${crypto.randomUUID()}@owner.test`, name: 'hook', acceptedTermsVersion: TERMS_VERSION });
    const saveToDlq = vi.spyOn(webhookDispatcher, 'saveToDlq').mockResolvedValue(undefined as never);
    vi.spyOn(webhookDispatcher, 'dispatch').mockImplementation(async () => {
      await redisUserStore.deleteUser(user.id);
      return failedDelivery;
    });

    await process(queuedDelivery(user.id));

    expect(saveToDlq).not.toHaveBeenCalled();
  });

  it('still reaches the dead letters when the account exists and the last attempt fails', async () => {
    const user = await redisUserStore.createUser({ email: `hook_${crypto.randomUUID()}@owner.test`, name: 'hook', acceptedTermsVersion: TERMS_VERSION });
    try {
      const saveToDlq = vi.spyOn(webhookDispatcher, 'saveToDlq').mockResolvedValue(undefined as never);
      vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue(failedDelivery);

      await process(queuedDelivery(user.id));

      expect(saveToDlq).toHaveBeenCalledTimes(1);
      expect(saveToDlq.mock.calls[0][0].ownerUserId).toBe(user.id);
    } finally {
      await redisUserStore.deleteUser(user.id);
    }
  });
});
