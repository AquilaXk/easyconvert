import crypto from 'node:crypto';
import { redactForOutput, redactText } from '../security/redact';
import { fetch as undiciFetch, Agent } from 'undici';
import { createSsrfSafeAgent, validateUrlForSsrf } from '../security/ssrf';
import type { WebhookDlqEntry } from './types';
import { WebhookDlqStore, type DlqPage, type DlqPageOptions } from './webhook-dlq-store';
import { redisKeyStore } from './redis-key-store';
import { getWebhookSecretStore, requireWebhookTargetId } from './webhook-secret-store';
import { decryptSecret, encryptSecret } from './secret-encryption';
import { openWebhookSecret, sealWebhookSecret } from '../security/sealed-webhook-secret';
import {
  createQueueEngine,
  Worker,
  type IQueueEngine,
  type Job,
} from '../queue/bullmq-engine';

/**
 * How long a dead letter is kept after its delivery failed: 30 days, within the 2 to 90 days for which webhook delivery
 * services keep a failed delivery for a manual redelivery (docs/policy-decisions.md, entry 147). The download link in a
 * letter expires long before, so a later redelivery would only announce a file that is gone.
 */
export const WEBHOOK_DLQ_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function isDlqEntryExpired(entry: WebhookDlqEntry, now: number): boolean {
  return !(entry.failedAt > now - WEBHOOK_DLQ_RETENTION_MS);
}

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

/** How long an ended delivery job stays in the webhook queue: a day to look at a failure, an hour after a success. */
const WEBHOOK_COMPLETED_JOB_KEEP_SECONDS = 3600;
const WEBHOOK_FAILED_JOB_KEEP_SECONDS = 24 * 3600;

/** What every delivery job gets: ended jobs expire, and the signing secret leaves the stored job when it ends. */
const WEBHOOK_JOB_OPTIONS = {
  removeOnComplete: { age: WEBHOOK_COMPLETED_JOB_KEEP_SECONDS },
  removeOnFail: { age: WEBHOOK_FAILED_JOB_KEEP_SECONDS },
  removeDataOnFinish: ['secret'],
} as const;

export interface WebhookJobData<T = Record<string, unknown>> {
  deliveryId: string;
  targetUrl: string;
  event: WebhookEvent;
  data: T;
  /** The signing secret sealed for `deliveryId` (a retry is a new job with the same delivery id), or empty. */
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
  if (code >= 300 && code < 500) return 'dlq_immediate';
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
/**
 * The secret that signs first for a target whose rotation record is `record`: a caller's own secret stays, except the one the
 * target rotated away from (a job queued before the rotation), which the current secret replaces, since that is the one the
 * receiver now trusts first.
 */
function leadingSecret(callerSecret: string, record: { primary: string; previous?: string }): string {
  return !callerSecret || callerSecret === record.primary || callerSecret === record.previous ? record.primary : callerSecret;
}

export class WebhookDispatcher {
  private readonly deliveryHistory: WebhookDispatchResult[] = [];
  private readonly maxHistorySize = 100;
  private readonly inMemoryDlq = new Map<string, WebhookDlqEntry>();
  private readonly dlq = new WebhookDlqStore(this.inMemoryDlq, () => redisKeyStore.getRedisClient(), WEBHOOK_DLQ_RETENTION_MS);
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

  private async executeFetchAttempt(
    targetUrl: string,
    headers: Record<string, string>,
    bodyString: string,
    timeoutMs: number,
    attempt: number
  ): Promise<{ attemptEntry: WebhookDeliveryAttempt; statusAction: WebhookStatusAction; statusCode?: number }> {
    const attemptStart = Date.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchFn = (globalThis.fetch || undiciFetch) as unknown as typeof undiciFetch;
      const response = (await fetchFn(targetUrl, {
        method: 'POST',
        headers,
        body: bodyString,
        redirect: 'manual',
        dispatcher: this.ssrfAgent,
        signal: controller.signal,
      })) as unknown as Response;

      await response.body?.cancel?.().catch(() => undefined);
      const attemptDuration = Date.now() - attemptStart;
      const redirectError =
        response.status >= 300 && response.status < 400
          ? `Webhook redirect (${response.status}) is not followed.`
          : undefined;

      return {
        attemptEntry: {
          attemptNumber: attempt,
          timestamp: Date.now(),
          statusCode: response.status,
          error: redirectError,
          durationMs: attemptDuration,
        },
        statusAction: classifyWebhookStatus(response.status),
        statusCode: response.status,
      };
    } catch (err: unknown) {
      const attemptDuration = Date.now() - attemptStart;
      const errMsg = this.formatFetchError(err);
      const statusAction = classifyWebhookStatus(undefined, errMsg);
      return {
        attemptEntry: {
          attemptNumber: attempt,
          timestamp: Date.now(),
          error: errMsg,
          durationMs: attemptDuration,
        },
        statusAction,
        statusCode: statusAction === 'dlq_immediate' ? 403 : undefined,
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  }

  private formatFetchError(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    if (err.cause instanceof Error && err.cause.message) {
      return `${err.message}: ${err.cause.message}`;
    }
    return err.message;
  }

  private parseWebhookTargetUrl(targetUrl: string): URL {
    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Unsupported webhook protocol: ${parsedUrl.protocol}`);
    }
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error('webhookUrl cannot include embedded credentials.');
    }
    return parsedUrl;
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
    // An explicitly named target must not be blank; the typed error replaces the old silent fallback.
    const namedTarget = options.targetId ?? options.ownerKeyId;
    const secretTargetId = namedTarget === undefined ? undefined : requireWebhookTargetId(namedTarget);

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
      parsedUrl = this.parseWebhookTargetUrl(targetUrl);
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

    // Rotated secrets are stored per target. A dispatch that names no target reads no record: its owner
    // only attributes dead-letter entries, and there is no shared slot to fall back to.
    if (options.ownerUserId && secretTargetId !== undefined) {
      try {
        const record = await getWebhookSecretStore().getSecretRecord(options.ownerUserId, secretTargetId);
        if (record) {
          primarySecret = leadingSecret(primarySecret, record);
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
      data: redactForOutput(data),
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

    const requestHeaders: Record<string, string> = {
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
    };

    const attempts: WebhookDeliveryAttempt[] = [];
    let success = false;
    let finalStatusCode: number | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const { attemptEntry, statusAction, statusCode } = await this.executeFetchAttempt(
        targetUrl,
        requestHeaders,
        bodyString,
        timeoutMs,
        attempt
      );
      attempts.push(attemptEntry);
      if (statusCode !== undefined) {
        finalStatusCode = statusCode;
      }
      if (statusAction === 'success') {
        success = true;
        break;
      }
      if (statusAction === 'deactivate' || statusAction === 'dlq_immediate') {
        break;
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
    const entry: WebhookDlqEntry = {
      ...unmasked,
      secret: encryptSecret(unmasked.secret) ?? '',
      payload: redactForOutput(unmasked.payload),
      errorMessage: unmasked.errorMessage === undefined ? undefined : redactText(unmasked.errorMessage),
    };
    await this.dlq.put(entry);
  }

  private async readDlqEntry(id: string): Promise<WebhookDlqEntry | null> {
    const entry = await this.dlq.get(id);
    return entry && !isDlqEntryExpired(entry, Date.now()) ? entry : null;
  }

  /** Removes the entries whose retention (WEBHOOK_DLQ_RETENTION_MS) has passed, and answers how many it removed. */
  public purgeExpiredDlqEntries(): Promise<number> {
    return this.dlq.purgeExpired();
  }

  /**
   * A page of the DLQ entries owned by `ownerUserId`, newest first, with the count of all of them. Also purges ownerless entries.
   * Reads the owner's index, so the cost follows the page and not the size of the queue.
   */
  public getDlqPage(ownerUserId: string, options?: DlqPageOptions): Promise<DlqPage> {
    return this.dlq.page(ownerUserId, options);
  }

  /** The newest DLQ entries owned by `ownerUserId` (a page, `DLQ_PAGE_DEFAULT` unless `limit` says otherwise). */
  public async getDlqEntries(ownerUserId: string, options?: DlqPageOptions): Promise<WebhookDlqEntry[]> {
    return (await this.getDlqPage(ownerUserId, options)).entries;
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
    return this.dlq.remove([entry]);
  }

  /**
   * Removes every DLQ entry owned by `ownerUserId`; other owners' entries are untouched.
   */
  public clearDlq(ownerUserId: string): Promise<void> {
    return this.dlq.clear(ownerUserId);
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
      decryptSecret(entry.secret) ?? '',
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
      secret: sealWebhookSecret(secret, deliveryId),
      options,
      attemptNumber: 1,
      attempts: [],
      createdAt: Date.now(),
    };

    return queue.add('webhook:delivery', jobData as any, { ...WEBHOOK_JOB_OPTIONS });
  }

  private async processQueuedJob(
    job: Job<WebhookJobData, WebhookDispatchResult>
  ): Promise<WebhookDispatchResult> {
    const { targetUrl, event, data, options = {} } = job.data;
    const secret = openWebhookSecret(job.data.secret, job.data.deliveryId);
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
    await this.getQueue().add('webhook:delivery', job.data, { ...WEBHOOK_JOB_OPTIONS, delay: delayMs });
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
