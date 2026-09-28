import crypto from 'node:crypto';

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
 * Enterprise Asynchronous Webhook Dispatcher with HMAC-SHA256 Signature Verification.
 * Supports configurable exponential retries, event signing, and non-blocking asynchronous delivery.
 */
export class WebhookDispatcher {
  private readonly deliveryHistory: WebhookDispatchResult[] = [];
  private readonly maxHistorySize = 100;

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
