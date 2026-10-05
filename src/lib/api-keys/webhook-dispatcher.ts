import crypto from 'node:crypto';
import { redactSecrets, redactText } from '../security/redact';
import { fetch as undiciFetch, Agent } from 'undici';
import { createSsrfSafeAgent, validateUrlForSsrf } from '../security/ssrf';
import type { WebhookDlqEntry } from './types';
import { redisKeyStore } from './redis-key-store';
import { getWebhookSecretStore } from './webhook-secret-store';
import {
  createQueueEngine,
  Worker,
  type IQueueEngine,
  type Job,
} from '../queue/bullmq-engine';

/** DLQ reason for events that were not sent because no signing secret is configured. */
export const MISSING_WEBHOOK_SECRET_REASON = 'missing_webhook_secret';

export type WebhookEvent =
  | 'conversion.completed'
  | 'conversion.failed'
  | 'job.created'
  | 'job.active'
  | 'job.completed'
  | 'job.failed'
  | 'graph.completed'
  | 'graph.failed'
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
  skipDlq?: boolean;
  deliveryId?: string;
  async?: boolean;
  subscribedEvents?: string[];
  /** Owner recorded on the DLQ entry if delivery fails; required to see or manage the entry later. */
  ownerUserId?: string;
  ownerKeyId?: string;
  targetId?: string;
  previousSecret?: string;
  previousExpiresAt?: number;
  durable?: boolean;
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
  skipped?: boolean;
  totalAttempts: number;
  finalStatusCode?: number;
  durationMs: number;
  attempts: WebhookDeliveryAttempt[];
}

export interface WebhookJobData<T = Record<string, unknown>> {
  deliveryId: string;
  targetUrl: string;
  event: WebhookEvent;
  data: T;
  secret: string;
  options?: WebhookDispatchOptions;
  attemptNumber: number;
  attempts: WebhookDeliveryAttempt[];
  createdAt: number;
}

/**
 * Standard enterprise webhook exponential retry intervals (in ms):
 * 30s, 2m, 10m, 1h, 6h, 24h
 */
export const WEBHOOK_RETRY_SCHEDULE_MS = [
  30_000,
  120_000,
  600_000,
  3_600_000,
  21_600_000,
  86_400_000,
] as const;

export type WebhookStatusAction = 'success' | 'deactivate' | 'dlq_immediate' | 'retry';

function classifyStatusCode(code: number): WebhookStatusAction {
  if (code >= 200 && code < 300) return 'success';
  if (code === 410) return 'deactivate';
  if (code === 408 || code === 429 || code >= 500) return 'retry';
  if (code >= 400 && code < 500) return 'dlq_immediate';
  return 'retry';
}

function classifyErrorMessage(err: string): WebhookStatusAction {
  if (err.includes('SSRF blocked') || err.includes('restricted')) {
    return 'dlq_immediate';
  }
  return 'retry';
}

/**
 * Classifies HTTP response status codes and network errors:
 * - 2xx: Success
 * - 410: Permanent deactivation (no retries, no DLQ)
 * - 4xx (except 408, 429): Non-retryable client error (immediate DLQ transfer)
 * - 5xx, 408, 429, timeouts: Retryable
 */
export function classifyWebhookStatus(statusCode?: number, error?: string): WebhookStatusAction {
  if (statusCode !== undefined) {
    return classifyStatusCode(statusCode);
  }
  if (error) {
    return classifyErrorMessage(error);
  }
  return 'retry';
}

function extractRetryAfterHeader(
  headers: Headers | Record<string, string | string[] | undefined>
): string | null {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get('retry-after');
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  const raw = rec['retry-after'] ?? rec['Retry-After'];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === 'string' ? raw : null;
}

function parseRetryAfterDelayMs(headerValue: string): number | null {
  const trimmed = headerValue.trim();
  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(seconds) && String(seconds) === trimmed) {
    return Math.min(86_400_000, Math.max(1000, seconds * 1000));
  }
  const dateParsed = Date.parse(trimmed);
  if (!Number.isNaN(dateParsed)) {
    const diff = dateParsed - Date.now();
    return Math.min(86_400_000, Math.max(1000, diff));
  }
  return null;
}

/**
 * Computes retry delay honoring HTTP Retry-After header with fallback to exponential schedule and full jitter.
 */
export function computeRetryDelay(
  attemptNumber: number,
  responseHeaders?: Headers | Record<string, string | string[] | undefined> | null,
  overrideSchedule?: readonly number[]
): number {
  if (responseHeaders) {
    const rawVal = extractRetryAfterHeader(responseHeaders);
    if (rawVal) {
      const parsed = parseRetryAfterDelayMs(rawVal);
      if (parsed !== null) return parsed;
    }
  }

  const schedule = overrideSchedule ?? WEBHOOK_RETRY_SCHEDULE_MS;
  const index = Math.min(Math.max(0, attemptNumber - 1), schedule.length - 1);
  const baseIntervalMs = schedule[index];
  if (baseIntervalMs <= 1000) return baseIntervalMs;
  return crypto.randomInt(1000, baseIntervalMs + 1);
}

function isDlqEntryOwnedBy(entry: WebhookDlqEntry, ownerUserId: string): boolean {
  return Boolean(ownerUserId) && entry.ownerUserId === ownerUserId;
}

/**
 * Enterprise Asynchronous Webhook Dispatcher with HMAC-SHA256 Signature Verification,
 * Zero-Trust SSRF Protection against cloud metadata/private ranges, Exponential Retries,
 * and Redis/In-Memory Dead Letter Queue (DLQ) with Manual Replay.
 */
export class WebhookDispatcher {
  private readonly deliveryHistory: WebhookDispatchResult[] = [];
  private readonly maxHistorySize = 100;
  private readonly inMemoryDlq = new Map<string, WebhookDlqEntry>();
  private readonly dlqKey = 'easyconvert:webhook:dlq';
  private readonly ssrfAgent: Agent;

  constructor(customAgent?: Agent) {
    this.ssrfAgent = customAgent || createSsrfSafeAgent();
  }

  public async close(): Promise<void> {
    await this.ssrfAgent.close().catch(() => {});
    if (this.queueWorker) {
      await this.queueWorker.close().catch(() => {});
      this.queueWorker = null;
    }
    if (this.queueEngine) {
      await this.queueEngine.close().catch(() => {});
      this.queueEngine = null;
    }
  }

  /**
   * Generates standard HMAC-SHA256 signature for the given payload string and secret.
   */
  public static signPayload(bodyString: string, secret: string, timestamp: number): string {
    const stringToSign = `${timestamp}.${bodyString}`;
    return crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
  }

  /**
   * Generates standard Svix / Standard Webhook v1 signature:
   * v1,<base64(HMAC-SHA256(secret, `${deliveryId}.${timestamp}.${bodyString}`))>
   */
  public static signStandardPayload(
    deliveryId: string,
    timestamp: number,
    bodyString: string,
    secret: string
  ): string {
    const stringToSign = `${deliveryId}.${timestamp}.${bodyString}`;
    const hmacB64 = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
    return `v1,${hmacB64}`;
  }

  /**
   * Generates standard HMAC-SHA256 signature for the given payload string and secret.
   */
  public generateSignature(bodyString: string, secret: string, timestamp: number): string {
    return WebhookDispatcher.signPayload(bodyString, secret, timestamp);
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
   * Verifies an incoming HMAC-SHA256 signature with dual secrets support (primary and optional secondary).
   * Enables seamless zero-downtime secret rotation without interrupting webhook processing.
   */
  public verifySignatureWithDualSecrets(
    bodyString: string,
    signatureHeader: string,
    timestamp: number,
    primarySecret: string,
    secondarySecret?: string,
    toleranceSeconds: number = 300
  ): boolean {
    if (this.verifySignature(bodyString, signatureHeader, timestamp, primarySecret, toleranceSeconds)) {
      return true;
    }
    if (secondarySecret && secondarySecret.trim().length > 0) {
      return this.verifySignature(bodyString, signatureHeader, timestamp, secondarySecret, toleranceSeconds);
    }
    return false;
  }

  /**
   * Verifies an incoming standard multi-signature header (Webhook-Signature) against the expected secret.
   * Handles space-separated signatures ("v1,sig1 v1,sig2").
   */
  public static verifyStandardSignature(
    deliveryId: string,
    timestamp: number,
    bodyString: string,
    signatureHeader: string,
    secret: string,
    toleranceSeconds: number = 300
  ): boolean {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      return false; // Replay attack prevention
    }

    const expectedSig = WebhookDispatcher.signStandardPayload(deliveryId, timestamp, bodyString, secret);
    const expectedBuf = Buffer.from(expectedSig, 'utf8');

    const items = signatureHeader.trim().split(/\s+/);
    for (const item of items) {
      if (!item.startsWith('v1,')) continue;
      const itemBuf = Buffer.from(item, 'utf8');
      if (itemBuf.length === expectedBuf.length && crypto.timingSafeEqual(itemBuf, expectedBuf)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Verifies an incoming standard multi-signature header with dual secret support (primary and optional secondary).
   */
  public static verifyStandardSignatureWithDualSecrets(
    deliveryId: string,
    timestamp: number,
    bodyString: string,
    signatureHeader: string,
    primarySecret: string,
    secondarySecret?: string,
    toleranceSeconds: number = 300
  ): boolean {
    if (
      WebhookDispatcher.verifyStandardSignature(
        deliveryId,
        timestamp,
        bodyString,
        signatureHeader,
        primarySecret,
        toleranceSeconds
      )
    ) {
      return true;
    }
    if (secondarySecret && secondarySecret.trim().length > 0) {
      return WebhookDispatcher.verifyStandardSignature(
        deliveryId,
        timestamp,
        bodyString,
        signatureHeader,
        secondarySecret,
        toleranceSeconds
      );
    }
    return false;
  }

  /**
   * Determines whether an event should be dispatched based on subscriber filters.
   */
  public shouldDispatchEvent(event: WebhookEvent | string, subscribedEvents?: string[]): boolean {
    if (!subscribedEvents || subscribedEvents.length === 0) return true;
    return subscribedEvents.some((pattern) => {
      if (pattern === '*' || pattern === event) return true;
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        return event.startsWith(prefix + '.');
      }
      return false;
    });
  }

  private recordHistory(result: WebhookDispatchResult): void {
    this.deliveryHistory.push(result);
    if (this.deliveryHistory.length > this.maxHistorySize) {
      this.deliveryHistory.shift();
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
    const deliveryId = options.deliveryId || `wh_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const startTime = Date.now();

    // Check event subscription filter
    if (options.subscribedEvents && !this.shouldDispatchEvent(event, options.subscribedEvents)) {
      const skippedResult: WebhookDispatchResult = {
        id: deliveryId,
        url: targetUrl,
        event,
        success: true,
        skipped: true,
        totalAttempts: 0,
        durationMs: 0,
        attempts: [],
      };
      this.recordHistory(skippedResult);
      return skippedResult;
    }

    // 1. URL Structure & Protocol Validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`Unsupported webhook protocol: ${parsedUrl.protocol}`);
      }
    } catch (urlErr: unknown) {
      const errMsg = urlErr instanceof Error ? urlErr.message : 'Invalid target URL';
      const result: WebhookDispatchResult = {
        id: deliveryId,
        url: targetUrl,
        event,
        success: false,
        totalAttempts: 1,
        finalStatusCode: 400,
        durationMs: Date.now() - startTime,
        attempts: [
          {
            attemptNumber: 1,
            timestamp: Date.now(),
            error: errMsg,
            durationMs: Date.now() - startTime,
          },
        ],
      };
      this.recordHistory(result);
      return result;
    }

    // 2. Pre-flight SSRF Validation (fail closed on private / link-local / cloud metadata ranges)
    const isSsrfSafe = await validateUrlForSsrf(parsedUrl);
    if (!isSsrfSafe) {
      const result: WebhookDispatchResult = {
        id: deliveryId,
        url: targetUrl,
        event,
        success: false,
        totalAttempts: 1,
        finalStatusCode: 403,
        durationMs: Date.now() - startTime,
        attempts: [
          {
            attemptNumber: 1,
            timestamp: Date.now(),
            error: `SSRF blocked: host ${parsedUrl.hostname} is restricted`,
            durationMs: Date.now() - startTime,
          },
        ],
      };
      this.recordHistory(result);
      return result;
    }

    let primarySecret = secret;
    let previousSecret = options.previousSecret;
    let previousExpiresAt = options.previousExpiresAt;

    if (options.ownerUserId) {
      try {
        const targetId = options.targetId || options.ownerKeyId || 'default';
        const record = await getWebhookSecretStore().getSecretRecord(options.ownerUserId, targetId);
        if (record) {
          if (!primarySecret || primarySecret === record.primary) {
            primarySecret = record.primary;
          }
          if (
            !previousSecret &&
            record.previous &&
            record.previousExpiresAt &&
            record.previousExpiresAt > Date.now()
          ) {
            previousSecret = record.previous;
            previousExpiresAt = record.previousExpiresAt;
          }
        }
      } catch {
        // Fall back to provided secret
      }
    }

    // An HMAC with an empty key is forgeable by anyone: never send an unsigned event.
    if (!primarySecret) {
      const result: WebhookDispatchResult = {
        id: deliveryId,
        url: targetUrl,
        event,
        success: false,
        totalAttempts: 0,
        durationMs: Date.now() - startTime,
        attempts: [],
      };
      this.recordHistory(result);
      if (!options.skipDlq) {
        await this.saveToDlq({
          id: `dlq_${deliveryId}`,
          originalDeliveryId: deliveryId,
          targetUrl,
          event,
          payload: data as Record<string, unknown>,
          secret: '',
          failedAt: Date.now(),
          errorMessage: MISSING_WEBHOOK_SECRET_REASON,
          retryCount: 0,
          status: 'failed',
          ownerUserId: options.ownerUserId,
          ownerKeyId: options.ownerKeyId,
        }).catch(() => {});
      }
      return result;
    }

    // Payloads are built from job state and error text: nothing secret leaves in a delivery, a
    // signature input, or the dead-letter copy of either.
    const payload: WebhookPayload<T> = {
      id: deliveryId,
      event,
      timestamp,
      data: redactSecrets(data),
    };

    const bodyString = JSON.stringify(payload);
    const legacySignature = this.generateSignature(bodyString, primarySecret, timestamp);
    const primaryStandardSig = WebhookDispatcher.signStandardPayload(
      deliveryId,
      timestamp,
      bodyString,
      primarySecret
    );
    let webhookSignatureHeader = primaryStandardSig;

    const nowMs = Date.now();
    if (previousSecret && (previousExpiresAt === undefined || previousExpiresAt > nowMs)) {
      const prevStandardSig = WebhookDispatcher.signStandardPayload(
        deliveryId,
        timestamp,
        bodyString,
        previousSecret
      );
      webhookSignatureHeader = `${primaryStandardSig} ${prevStandardSig}`;
    }

    const attempts: WebhookDeliveryAttempt[] = [];
    let success = false;
    let finalStatusCode: number | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const attemptStart = Date.now();
      const controller = new AbortController();
      let timer: NodeJS.Timeout | null = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const fetchFn = (globalThis.fetch || undiciFetch) as unknown as typeof undiciFetch;
        const response = (await fetchFn(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'EasyConvert-Webhook/1.0',
            'Webhook-Id': deliveryId,
            'Webhook-Timestamp': timestamp.toString(),
            'Webhook-Signature': webhookSignatureHeader,
            'X-EasyConvert-Delivery': deliveryId,
            'X-EasyConvert-Event': event,
            'X-EasyConvert-Timestamp': timestamp.toString(),
            'X-EasyConvert-Signature': `sha256=${legacySignature}`,
            'X-Signature-SHA256': legacySignature,
          },
          body: bodyString,
          dispatcher: this.ssrfAgent,
          signal: controller.signal as any,
        } as any)) as unknown as Response;

        finalStatusCode = response.status;
        const attemptDuration = Date.now() - attemptStart;

        attempts.push({
          attemptNumber: attempt,
          timestamp: Date.now(),
          statusCode: response.status,
          durationMs: attemptDuration,
        });

        const statusAction = classifyWebhookStatus(response.status);
        if (statusAction === 'success') {
          success = true;
          break;
        }

        if (statusAction === 'deactivate') {
          // 410 Gone: permanently stop retrying and do not store in DLQ
          break;
        }

        if (statusAction === 'dlq_immediate') {
          // 4xx client errors (except 408/429): fast-fail immediately to DLQ
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

        const statusAction = classifyWebhookStatus(undefined, errMsg);
        if (statusAction === 'dlq_immediate') {
          finalStatusCode = 403;
          break;
        }
      } finally {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }

      if (attempt < maxRetries) {
        const baseDelay = options.initialDelayMs ?? 200;
        const exponential = Math.floor(baseDelay * Math.pow(2, attempt - 1));
        const maxRange = Math.max(2, exponential + 1);
        const backoffMs = crypto.randomInt(1, maxRange);
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

    this.recordHistory(result);

    // Preserve failed webhooks in Dead Letter Queue (DLQ) unless permanently deactivated (410 Gone)
    if (!success && !options.skipDlq && finalStatusCode !== 410) {
      const lastError = attempts.at(-1)?.error;
      const dlqEntry: WebhookDlqEntry = {
        id: `dlq_${deliveryId}`,
        originalDeliveryId: deliveryId,
        targetUrl,
        event,
        payload: payload as unknown as Record<string, unknown>,
        secret: primarySecret,
        failedAt: Date.now(),
        finalStatusCode,
        errorMessage: lastError,
        retryCount: attempts.length,
        status: 'failed',
        ownerUserId: options.ownerUserId,
        ownerKeyId: options.ownerKeyId,
      };
      await this.saveToDlq(dlqEntry).catch(() => {});
    }

    return result;
  }

  public async saveToDlq(unmasked: WebhookDlqEntry): Promise<void> {
    // The target URL and signing secret stay as they are because a replay needs them; the payload
    // and the error text are what a reader of the queue sees, so they are stored masked.
    const entry: WebhookDlqEntry = {
      ...unmasked,
      payload: redactSecrets(unmasked.payload),
      errorMessage: unmasked.errorMessage === undefined ? undefined : redactText(unmasked.errorMessage),
    };
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

  private async readAllDlqEntries(): Promise<WebhookDlqEntry[]> {
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
        return entries;
      } catch {
        // Fallback to in-memory
      }
    }
    return Array.from(this.inMemoryDlq.values());
  }

  private async readDlqEntry(id: string): Promise<WebhookDlqEntry | null> {
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

  private async removeDlqEntries(ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) return false;
    let removed = false;
    const client = redisKeyStore.getRedisClient();
    if (client) {
      try {
        const count = await client.hdel(this.dlqKey, ...ids);
        removed = count > 0;
      } catch {
        // Fallback
      }
    }
    for (const id of ids) {
      if (this.inMemoryDlq.delete(id)) {
        removed = true;
      }
    }
    return removed;
  }

  /**
   * Deletes entries recorded before owners were tracked (or for anonymous jobs). No API caller can
   * reach them, so keeping them would only retain their plaintext signing secrets indefinitely.
   */
  private async purgeOwnerlessEntries(entries: readonly WebhookDlqEntry[]): Promise<void> {
    const ownerless = entries.filter((entry) => !entry.ownerUserId).map((entry) => entry.id);
    if (ownerless.length === 0) return;
    await this.removeDlqEntries(ownerless);
    console.warn(`[WebhookDispatcher] Purged ${ownerless.length} DLQ entries without an owner.`);
  }

  /**
   * Lists the DLQ entries owned by `ownerUserId`, newest first. Also purges ownerless entries.
   */
  public async getDlqEntries(ownerUserId: string): Promise<WebhookDlqEntry[]> {
    const entries = await this.readAllDlqEntries();
    await this.purgeOwnerlessEntries(entries);
    return entries
      .filter((entry) => isDlqEntryOwnedBy(entry, ownerUserId))
      .sort((a, b) => b.failedAt - a.failedAt);
  }

  /**
   * Returns the entry only when `ownerUserId` owns it; any other entry reads as not found.
   */
  public async getDlqEntry(id: string, ownerUserId: string): Promise<WebhookDlqEntry | null> {
    const entry = await this.readDlqEntry(id);
    if (!entry || !isDlqEntryOwnedBy(entry, ownerUserId)) {
      return null;
    }
    return entry;
  }

  public async deleteDlqEntry(id: string, ownerUserId: string): Promise<boolean> {
    const entry = await this.getDlqEntry(id, ownerUserId);
    if (!entry) return false;
    return this.removeDlqEntries([entry.id]);
  }

  /**
   * Removes every DLQ entry owned by `ownerUserId`; other owners' entries are untouched.
   */
  public async clearDlq(ownerUserId: string): Promise<void> {
    const owned = await this.getDlqEntries(ownerUserId);
    await this.removeDlqEntries(owned.map((entry) => entry.id));
  }

  public async replayDlq(id: string, ownerUserId: string): Promise<WebhookDispatchResult | null> {
    const entry = await this.getDlqEntry(id, ownerUserId);
    if (!entry) return null;

    const isWrappedEnvelope =
      entry.payload &&
      typeof entry.payload === 'object' &&
      'id' in entry.payload &&
      'event' in entry.payload &&
      'timestamp' in entry.payload &&
      'data' in entry.payload;

    const payloadData = isWrappedEnvelope
      ? (entry.payload as Record<string, unknown>).data
      : entry.payload;
    const result = await this.dispatch(
      entry.targetUrl,
      entry.event as WebhookEvent,
      payloadData,
      entry.secret,
      {
        maxRetries: 3,
        skipDlq: true,
        deliveryId: entry.originalDeliveryId || entry.id,
        ownerUserId: entry.ownerUserId,
        ownerKeyId: entry.ownerKeyId,
      }
    );

    entry.retryCount += result.totalAttempts;
    entry.finalStatusCode = result.finalStatusCode;
    entry.errorMessage = result.attempts.at(-1)?.error;
    if (result.success) {
      entry.status = 'replayed';
      entry.replayedAt = Date.now();
    } else {
      entry.status = 'failed';
    }
    await this.saveToDlq(entry);

    return result;
  }

  private queueEngine: IQueueEngine<WebhookJobData, WebhookDispatchResult> | null = null;
  private queueWorker: Worker<WebhookJobData, WebhookDispatchResult> | null = null;

  public getQueue(): IQueueEngine<WebhookJobData, WebhookDispatchResult> {
    this.queueEngine ??= createQueueEngine<WebhookJobData, WebhookDispatchResult>('easyconvert-webhooks');
    return this.queueEngine;
  }

  public getWorker(): Worker<WebhookJobData, WebhookDispatchResult> {
    this.queueWorker ??= new Worker<WebhookJobData, WebhookDispatchResult>(
      this.getQueue(),
      async (job) => this.processQueuedJob(job),
      { concurrency: 10 }
    );
    return this.queueWorker;
  }

  public async enqueueDelivery<T = Record<string, unknown>>(
    targetUrl: string,
    event: WebhookEvent,
    data: T,
    secret: string,
    options: WebhookDispatchOptions = {}
  ): Promise<Job<WebhookJobData, WebhookDispatchResult>> {
    const deliveryId = options.deliveryId || `wh_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const queue = this.getQueue();
    this.getWorker();

    const jobData: WebhookJobData<T> = {
      deliveryId,
      targetUrl,
      event,
      data,
      secret,
      options,
      attemptNumber: 1,
      attempts: [],
      createdAt: Date.now(),
    };

    return queue.add('webhook:delivery', jobData as any);
  }

  private async processQueuedJob(
    job: Job<WebhookJobData, WebhookDispatchResult>
  ): Promise<WebhookDispatchResult> {
    const { targetUrl, event, data, secret, options = {} } = job.data;
    const attemptResult = await this.dispatch(targetUrl, event, data, secret, {
      ...options,
      maxRetries: 1,
      deliveryId: job.data.deliveryId,
      skipDlq: true,
    });

    job.data.attempts.push(...attemptResult.attempts);
    job.data.attemptNumber += 1;

    if (attemptResult.success) {
      return attemptResult;
    }

    if (attemptResult.finalStatusCode === 410) {
      // 410 Gone: permanently deactivated, stop retrying, do not save to DLQ
      return attemptResult;
    }

    const action = classifyWebhookStatus(
      attemptResult.finalStatusCode,
      attemptResult.attempts.at(-1)?.error
    );
    const maxRetries = options.maxRetries || 6;

    if (action === 'dlq_immediate' || job.data.attempts.length >= maxRetries) {
      if (!options.skipDlq) {
        const lastError = job.data.attempts.at(-1)?.error;
        const dlqEntry: WebhookDlqEntry = {
          id: `dlq_${job.data.deliveryId}`,
          originalDeliveryId: job.data.deliveryId,
          targetUrl,
          event,
          payload: {
            id: job.data.deliveryId,
            event,
            timestamp: Math.floor(Date.now() / 1000),
            data,
          },
          secret,
          failedAt: Date.now(),
          finalStatusCode: attemptResult.finalStatusCode,
          errorMessage: lastError,
          retryCount: job.data.attempts.length,
          status: 'failed',
          ownerUserId: options.ownerUserId,
          ownerKeyId: options.ownerKeyId,
        };
        await this.saveToDlq(dlqEntry).catch(() => {});
      }
      return {
        ...attemptResult,
        totalAttempts: job.data.attempts.length,
        attempts: job.data.attempts,
      };
    }

    const delayMs = computeRetryDelay(job.data.attempts.length);
    await this.getQueue().add('webhook:delivery', job.data, { delay: delayMs });
    return {
      ...attemptResult,
      totalAttempts: job.data.attempts.length,
      attempts: job.data.attempts,
    };
  }

  /**
   * Dispatches a webhook asynchronously in the background without blocking the caller thread.
   */
  public dispatchAsync<T = Record<string, unknown>>(
    targetUrl: string,
    event: WebhookEvent,
    data: T,
    secret: string,
    options: WebhookDispatchOptions = {}
  ): { deliveryId: string; promise: Promise<WebhookDispatchResult> } {
    const deliveryId = options.deliveryId || `wh_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const promise = this.dispatch(targetUrl, event, data, secret, { ...options, deliveryId });
    promise.catch(() => {});
    return { deliveryId, promise };
  }

  public getHistory(): WebhookDispatchResult[] {
    return [...this.deliveryHistory];
  }

  public clearHistory(): void {
    this.deliveryHistory.length = 0;
  }
}

export const webhookDispatcher = new WebhookDispatcher();

export function verifySignatureWithDualSecrets(
  bodyString: string,
  signatureHeader: string,
  timestamp: number,
  primarySecret: string,
  secondarySecret?: string,
  toleranceSeconds: number = 300
): boolean {
  return webhookDispatcher.verifySignatureWithDualSecrets(
    bodyString,
    signatureHeader,
    timestamp,
    primarySecret,
    secondarySecret,
    toleranceSeconds
  );
}

export function shouldDispatchEvent(
  event: WebhookEvent | string,
  subscribedEvents?: string[]
): boolean {
  return webhookDispatcher.shouldDispatchEvent(event, subscribedEvents);
}

export function verifyStandardSignature(
  deliveryId: string,
  timestamp: number,
  bodyString: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300
): boolean {
  return WebhookDispatcher.verifyStandardSignature(
    deliveryId,
    timestamp,
    bodyString,
    signatureHeader,
    secret,
    toleranceSeconds
  );
}

export function verifyStandardSignatureWithDualSecrets(
  deliveryId: string,
  timestamp: number,
  bodyString: string,
  signatureHeader: string,
  primarySecret: string,
  secondarySecret?: string,
  toleranceSeconds: number = 300
): boolean {
  return WebhookDispatcher.verifyStandardSignatureWithDualSecrets(
    deliveryId,
    timestamp,
    bodyString,
    signatureHeader,
    primarySecret,
    secondarySecret,
    toleranceSeconds
  );
}
