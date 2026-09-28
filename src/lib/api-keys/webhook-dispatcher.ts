import crypto from 'node:crypto';
import { fetch as undiciFetch, Agent } from 'undici';
import { createSsrfSafeAgent, validateUrlForSsrf } from '../security/ssrf';

export type WebhookEvent =
  | 'conversion.completed'
  | 'conversion.failed'
  | 'job.created'
  | 'job.active'
  | 'job.completed'
  | 'job.failed'
  | 'quota.warning';

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
  deliveryId?: string;
  async?: boolean;
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
 * Enterprise Asynchronous Webhook Dispatcher with HMAC-SHA256 Signature Verification
 * and Zero-Trust SSRF Protection against cloud metadata (169.254.169.254) and private networks.
 */
export class WebhookDispatcher {
  private readonly deliveryHistory: WebhookDispatchResult[] = [];
  private readonly maxHistorySize = 100;
  private readonly ssrfAgent: Agent;

  constructor(customAgent?: Agent) {
    this.ssrfAgent = customAgent || createSsrfSafeAgent();
  }

  public async close(): Promise<void> {
    await this.ssrfAgent.close().catch(() => {});
  }

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

  private recordHistory(result: WebhookDispatchResult): void {
    this.deliveryHistory.push(result);
    if (this.deliveryHistory.length > this.maxHistorySize) {
      this.deliveryHistory.shift();
    }
  }

  /**
   * Dispatches a signed webhook payload to the destination URL with SSRF protection.
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

    const payload: WebhookPayload<T> = {
      id: deliveryId,
      event,
      timestamp,
      data,
    };

    const bodyString = JSON.stringify(payload);
    const signature = this.generateSignature(bodyString, secret, timestamp);
    const attempts: WebhookDeliveryAttempt[] = [];

    let success = false;
    let finalStatusCode: number | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const attemptStart = Date.now();
      const controller = new AbortController();
      let timer: NodeJS.Timeout | null = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = (await undiciFetch(targetUrl, {
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
          dispatcher: this.ssrfAgent,
          signal: controller.signal as any,
        })) as unknown as Response;

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
        const causeMsg = (err as any)?.cause?.message || ((err as any)?.cause ? String((err as any).cause) : '');
        const errMsg = err instanceof Error ? err.message : String(err);
        const fullError = causeMsg ? `${errMsg}: ${causeMsg}` : errMsg;
        attempts.push({
          attemptNumber: attempt,
          timestamp: Date.now(),
          error: fullError,
          durationMs: attemptDuration,
        });

        // Fast-fail if blocked by SSRF agent during connection lookup or DNS rebinding
        if (
          fullError.includes('SSRF blocked') ||
          fullError.includes('restricted') ||
          errMsg.includes('SSRF blocked') ||
          causeMsg.includes('SSRF blocked') ||
          causeMsg.includes('restricted')
        ) {
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

    this.recordHistory(result);
    return result;
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

