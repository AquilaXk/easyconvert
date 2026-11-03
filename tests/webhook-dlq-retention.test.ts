import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WEBHOOK_DLQ_RETENTION_MS, webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';

// Public IPv4 literal: passes the SSRF pre-flight without a DNS round trip; fetch itself is mocked.
const PUBLIC_WEBHOOK_URL = 'https://93.184.215.14/hooks/easyconvert';
const SECRET = 'whsec_dead_letter_plain';

function entry(ownerUserId: string, failedAt: number): WebhookDlqEntry {
  const id = `dlq_retention_${crypto.randomBytes(6).toString('hex')}`;
  return {
    id,
    originalDeliveryId: `wh_${id}`,
    targetUrl: PUBLIC_WEBHOOK_URL,
    event: 'job.failed',
    payload: { jobId: id },
    secret: SECRET,
    failedAt,
    finalStatusCode: 500,
    retryCount: 3,
    status: 'failed',
    ownerUserId,
  };
}

/** The legacy signature header of a delivery, recomputed from the body and timestamp it carried. */
function expectedLegacySignature(init: RequestInit): string {
  const headers = init.headers as Record<string, string>;
  const timestamp = headers['X-EasyConvert-Timestamp'];
  return crypto.createHmac('sha256', SECRET).update(`${timestamp}.${String(init.body)}`).digest('hex');
}

describe('Webhook dead letters: the signing secret at rest and the retention', () => {
  const owner = `dlq_retention_owner_${crypto.randomBytes(4).toString('hex')}`;

  beforeEach(() => vi.useRealTimers());
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await webhookDispatcher.clearDlq(owner);
  });

  it('keeps the signing secret only in sealed form, and a replay still signs with it', async () => {
    const saved = entry(owner, Date.now());
    await webhookDispatcher.saveToDlq(saved);

    const stored = await webhookDispatcher.getDlqEntry(saved.id, owner);
    expect(stored?.secret).not.toContain(SECRET);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));
    expect((await webhookDispatcher.replayDlq(saved.id, owner))?.success).toBe(true);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Signature-SHA256']).toBe(expectedLegacySignature(init));
    expect((await webhookDispatcher.getDlqEntry(saved.id, owner))?.secret).not.toContain(SECRET);
  });

  it('removes a dead letter once the retention has passed since it failed, and keeps a younger one', async () => {
    const now = Date.now();
    const expired = entry(owner, now - WEBHOOK_DLQ_RETENTION_MS - 1);
    const kept = entry(owner, now - WEBHOOK_DLQ_RETENTION_MS + 60_000);
    await webhookDispatcher.saveToDlq(expired);
    await webhookDispatcher.saveToDlq(kept);

    expect(await webhookDispatcher.purgeExpiredDlqEntries()).toBe(1);
    expect(await webhookDispatcher.getDlqEntry(expired.id, owner)).toBeNull();
    expect((await webhookDispatcher.getDlqEntries(owner)).map((letter) => letter.id)).toEqual([kept.id]);
  });

  it('does not list or replay an expired dead letter that no purge has removed yet', async () => {
    const expired = entry(owner, Date.now() - WEBHOOK_DLQ_RETENTION_MS - 1);
    await webhookDispatcher.saveToDlq(expired);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));

    expect(await webhookDispatcher.getDlqEntries(owner)).toEqual([]);
    expect(await webhookDispatcher.replayDlq(expired.id, owner)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
