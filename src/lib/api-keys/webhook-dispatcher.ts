import crypto from 'node:crypto';
import type { WebhookDlqEntry } from './types';
import { redisKeyStore } from './redis-key-store';

export type WebhookEvent =
  | 'conversion.completed'
  | 'conversion.failed'
  | 'job.created'
  | 'job.active'
  | 'job.completed'
  | 'job.failed'
  | 'quota.warning'
  | 'key.expiring_soon';

export interface WebhookPayload<T = Record<string, unknown>> {
  id: string;
  event: WebhookEvent;
  timestamp: number;
  data: T;
}

export interface WebhookDispatchOptions {
  maxRetries?: number;
  timeoutMs?: number;
  initialDelayMs?: number;
}

export interface WebhookDeliveryAttempt {
  attemptNumber: number;
  timestamp: number;
  statusCode?: number;
  error?: string;
  durationMs: number;
}

export interface WebhookDispatchResult {
  id: string;
  url: string;
  event: WebhookEvent;
  success: boolean;
  totalAttempts: number;
  finalStatusCode?: number;
  durationMs: number;
  attempts: WebhookDeliveryAttempt[];
}

/**
 * Enterprise Asynchronous Webhook Dispatcher with HMAC-SHA256 Signature Verification,
 * Exponential Retries, and Redis/In-Memory Dead Letter Queue (DLQ) with Manual Replay.
 */
export class WebhookDispatcher {
  private readonly deliveryHistory: WebhookDispatchResult[] = [];
  private readonly maxHistorySize = 100;
  private readonly inMemoryDlq = new Map<string, WebhookDlqEntry>();
  private readonly dlqKey = 'easyconvert:webhook:dlq';

  /**
   * Generates standard HMAC-SHA256 signature for the given payload string and secret.
   */
  public generateSignature(bodyString: string, secret: string, timestamp: number): string {
    const stringToSign = `${timestamp}.${bodyString}`;
    return crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
  }

  /**
   * Verifies an incoming HMAC-SHA256 webhook signature against expected payload and secret.
   */
  public verifySignature(
    bodyString: string,
    signatureHeader: string,
    timestamp: number,
    secret: string,
    toleranceSeconds: number = 300
  ): boolean {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      return false; // Replay attack prevention
    }

    const expectedSig = this.generateSignature(bodyString, secret, timestamp);
    const cleanHeader = signatureHeader.replace(/^sha256=/, '').trim();

    try {
      const sigBuf = Buffer.from(cleanHeader, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Asynchronously dispatches a signed webhook payload to the destination URL.
   * If delivery fails after retries are exhausted, saves to Dead Letter Queue (DLQ).
   */
  public async dispatch<T = Record<string, unknown>>(
    targetUrl: string,
    event: WebhookEvent,
    data: T,
    secret: string,
    options: WebhookDispatchOptions = {}
  ): Promise<WebhookDispatchResult> {
    const { maxRetries = 3, timeoutMs = 5000, initialDelayMs = 200 } = options;
    const deliveryId = `wh_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const timestamp = Math.floor(Date.now() / 1000);

    const payload: WebhookPayload<T> = {
      id: deliveryId,
      event,
      timestamp,
      data,
    };

    const bodyString = JSON.stringify(payload);
    const signature = this.generateSignature(bodyString, secret, timestamp);
    const startTime = Date.now();
    const attempts: WebhookDeliveryAttempt[] = [];

    let success = false;
    let finalStatusCode: number | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const attemptStart = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'EasyConvert-Webhook/1.0',
            'X-EasyConvert-Delivery': deliveryId,
            'X-EasyConvert-Event': event,
            'X-EasyConvert-Timestamp': timestamp.toString(),
            'X-EasyConvert-Signature': `sha256=${signature}`,
          },
          body: bodyString,
          signal: controller.signal,
        });

        finalStatusCode = response.status;
        const attemptDuration = Date.now() - attemptStart;

        attempts.push({
          attemptNumber: attempt,
          timestamp: Date.now(),
          statusCode: response.status,
          durationMs: attemptDuration,
        });

        if (response.ok) {
          success = true;
          break;
        }

        // Retry only on server errors (5xx)
        if (response.status < 500) {
          break;
        }
      } catch (err: unknown) {
        const attemptDuration = Date.now() - attemptStart;
        const errMsg = err instanceof Error ? err.message : String(err);
        attempts.push({
          attemptNumber: attempt,
          timestamp: Date.now(),
          error: errMsg,
          durationMs: attemptDuration,
        });
      } finally {
        clearTimeout(timer);
      }

      if (attempt < maxRetries) {
        const backoffMs = initialDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    const result: WebhookDispatchResult = {
      id: deliveryId,
      url: targetUrl,
      event,
      success,
      totalAttempts: attempts.length,
      finalStatusCode,
      durationMs: Date.now() - startTime,
      attempts,
    };

    this.deliveryHistory.push(result);
    if (this.deliveryHistory.length > this.maxHistorySize) {
      this.deliveryHistory.shift();
    }

    // Preserve failed webhooks in Dead Letter Queue (DLQ)
    if (!success) {
      const lastError = attempts.at(-1)?.error;
      const dlqEntry: WebhookDlqEntry = {
        id: `dlq_${deliveryId}`,
        originalDeliveryId: deliveryId,
        targetUrl,
        event,
        payload: payload as unknown as Record<string, unknown>,
        secret,
        failedAt: Date.now(),
        finalStatusCode,
        errorMessage: lastError,
        retryCount: attempts.length,
        status: 'failed',
      };
      await this.saveToDlq(dlqEntry).catch(() => {});
    }

    return result;
  }

  public async saveToDlq(entry: WebhookDlqEntry): Promise<void> {
    const client = redisKeyStore.getRedisClient();
    if (client) {
      try {
        await client.hset(this.dlqKey, entry.id, JSON.stringify(entry));
        return;
      } catch {
        // Fallback to in-memory
      }
    }
    this.inMemoryDlq.set(entry.id, entry);
  }

  public async getDlqEntries(): Promise<WebhookDlqEntry[]> {
    const client = redisKeyStore.getRedisClient();
    if (client) {
      try {
        const rawMap = await client.hgetall(this.dlqKey);
        const entries: WebhookDlqEntry[] = [];
        for (const str of Object.values(rawMap)) {
          try {
            entries.push(JSON.parse(str));
          } catch {}
        }
        return entries.sort((a, b) => b.failedAt - a.failedAt);
      } catch {
        // Fallback to in-memory
      }
    }
    return Array.from(this.inMemoryDlq.values()).sort((a, b) => b.failedAt - a.failedAt);
  }

  public async getDlqEntry(id: string): Promise<WebhookDlqEntry | null> {
    const client = redisKeyStore.getRedisClient();
    if (client) {
      try {
        const raw = await client.hget(this.dlqKey, id);
        if (raw) return JSON.parse(raw);
      } catch {
        // Fallback to in-memory
      }
    }
    return this.inMemoryDlq.get(id) || null;
  }

  public async deleteDlqEntry(id: string): Promise<boolean> {
    let deleted = false;
    const client = redisKeyStore.getRedisClient();
    if (client) {
      try {
        const count = await client.hdel(this.dlqKey, id);
        deleted = count > 0;
      } catch {
        // Fallback
      }
    }
    if (this.inMemoryDlq.delete(id)) {
      deleted = true;
    }
    return deleted;
  }

  public async clearDlq(): Promise<void> {
    const client = redisKeyStore.getRedisClient();
    if (client) {
      try {
        await client.del(this.dlqKey);
      } catch {}
    }
    this.inMemoryDlq.clear();
  }

  public async replayDlq(id: string): Promise<WebhookDispatchResult | null> {
    const entry = await this.getDlqEntry(id);
    if (!entry) return null;

    const payloadData = (entry.payload as any)?.data ?? entry.payload;
    const result = await this.dispatch(
      entry.targetUrl,
      entry.event as WebhookEvent,
      payloadData,
      entry.secret,
      { maxRetries: 3 }
    );

    entry.retryCount += result.totalAttempts;
    entry.finalStatusCode = result.finalStatusCode;
    entry.errorMessage = result.attempts.at(-1)?.error;
    if (result.success) {
      entry.status = 'replayed';
      entry.replayedAt = Date.now();
    }
    await this.saveToDlq(entry);

    return result;
  }

  public getHistory(): WebhookDispatchResult[] {
    return [...this.deliveryHistory];
  }

  public clearHistory(): void {
    this.deliveryHistory.length = 0;
  }
}

export const webhookDispatcher = new WebhookDispatcher();
