import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebsiteCaptureOptions } from '@/lib/capture-options';
import {
  conversionFailureOf,
  ConversionFailureError,
  jobFailure,
  serverRefusal,
  type ConversionFailure,
} from '@/lib/conversion-failure';

const INITIAL_POLL_MS = 150;
const MAX_POLL_MS = 1000;
const POLL_BACKOFF = 1.5;

export interface CompletedCapture {
  filename: string;
  size: number;
  downloadUrl: string;
  hasBlockedRequests: boolean;
}

interface CaptureJobSnapshot {
  state?: unknown;
  progress?: unknown;
  returnvalue?: unknown;
  failedReason?: unknown;
  failedRefusalCode?: unknown;
}

function abortPromise(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeCaptureOptions(options: WebsiteCaptureOptions): WebsiteCaptureOptions {
  const out: WebsiteCaptureOptions = {};
  if (options.viewport && (options.viewport.width !== undefined || options.viewport.height !== undefined)) {
    out.viewport = { ...options.viewport };
  }
  if (options.fullPage !== undefined) out.fullPage = options.fullPage;
  if (options.waitUntil !== undefined) out.waitUntil = options.waitUntil;
  if (options.delayMs !== undefined) out.delayMs = options.delayMs;
  if (options.quality !== undefined) out.quality = options.quality;
  if (options.timeoutMs !== undefined) out.timeoutMs = options.timeoutMs;
  if (options.pdf) out.pdf = { ...options.pdf };
  return out;
}

function completedFromSnapshot(job: CaptureJobSnapshot): CompletedCapture | null {
  const rv = job.returnvalue && typeof job.returnvalue === 'object' ? (job.returnvalue as Record<string, unknown>) : null;
  if (!rv || typeof rv.downloadUrl !== 'string' || rv.downloadUrl.length === 0) return null;
  const filename = typeof rv.filename === 'string' && rv.filename ? rv.filename : 'capture';
  const size = typeof rv.size === 'number' && Number.isFinite(rv.size) ? rv.size : 0;
  const warnings = Array.isArray(rv.warnings) ? rv.warnings : [];
  return { filename, size, downloadUrl: rv.downloadUrl, hasBlockedRequests: warnings.length > 0 };
}

function captureErrorFailure(err: unknown): ConversionFailure {
  return err instanceof ConversionFailureError ? err.failure : conversionFailureOf(err);
}

/**
 * Manages asynchronous `POST /api/capture/jobs` submission, polling `/api/queue/jobs/[id]`, cancellation, and failure state.
 */
export function useWebsiteCaptureRun(targetFormat: 'pdf' | 'png' | 'jpg') {
  const [busy, setBusy] = useState(false);
  const [phaseLabel, setPhaseLabel] = useState<'queued' | 'capturing'>('queued');
  const [progress, setProgress] = useState(0);
  const [failure, setFailure] = useState<ConversionFailure | null>(null);
  const [completedResult, setCompletedResult] = useState<CompletedCapture | null>(null);

  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      const jobId = activeJobIdRef.current;
      if (jobId) {
        void fetch(`/api/queue/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
      }
    };
  }, []);

  const cancel = useCallback(() => {
    const jobId = activeJobIdRef.current;
    activeJobIdRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    if (jobId) {
      void fetch(`/api/queue/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    }
    if (mountedRef.current) {
      setBusy(false);
      setProgress(0);
    }
  }, []);

  const reset = useCallback(() => {
    setCompletedResult(null);
    setFailure(null);
    setProgress(0);
  }, []);

  const pollCaptureJob = useCallback(async (jobId: string, signal: AbortSignal): Promise<CompletedCapture> => {
    let delayMs = INITIAL_POLL_MS;
    while (!signal.aborted) {
      const pollRes = await fetch(`/api/queue/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store', signal });
      const snapshot = (await pollRes.json().catch(() => ({}))) as CaptureJobSnapshot;
      if (!pollRes.ok) {
        throw serverRefusal(snapshot, pollRes.status, 'Failed polling website capture job.');
      }
      const state = typeof snapshot.state === 'string' ? snapshot.state : '';
      if (state === 'completed') {
        const done = completedFromSnapshot(snapshot);
        if (!done) throw new ConversionFailureError('Website capture finished without output.', { code: 'conversionFailed' });
        return done;
      }
      if (state === 'failed') throw jobFailure(snapshot);
      if (state === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
      if (mountedRef.current && !signal.aborted) {
        setPhaseLabel(state === 'active' ? 'capturing' : 'queued');
        if (typeof snapshot.progress === 'number' && Number.isFinite(snapshot.progress)) {
          setProgress(Math.min(100, Math.max(0, Math.round(snapshot.progress))));
        }
      }
      await abortPromise(delayMs, signal);
      delayMs = Math.min(Math.round(delayMs * POLL_BACKOFF), MAX_POLL_MS);
    }
    throw new DOMException('Cancelled', 'AbortError');
  }, []);

  const start = useCallback(
    async (targetUrl: string, options: WebsiteCaptureOptions) => {
      if (busy) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      activeJobIdRef.current = null;

      setFailure(null);
      setCompletedResult(null);
      setBusy(true);
      setPhaseLabel('queued');
      setProgress(0);

      try {
        const normalizedOptions = normalizeCaptureOptions(options);
        const idempotencyKey =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now());
        const enqueueRes = await fetch('/api/capture/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({
            url: targetUrl,
            targetFormat,
            ...(Object.keys(normalizedOptions).length > 0 ? { options: normalizedOptions } : {}),
          }),
          signal: controller.signal,
        });

        const enqueueBody = (await enqueueRes.json().catch(() => ({}))) as Record<string, unknown>;
        if (!enqueueRes.ok) {
          throw serverRefusal(enqueueBody, enqueueRes.status, 'Failed starting website capture job.');
        }

        const jobId = typeof enqueueBody.jobId === 'string' ? enqueueBody.jobId : '';
        if (!jobId) {
          throw new ConversionFailureError('Capture job id missing from server response.', { code: 'conversionFailed' });
        }
        activeJobIdRef.current = jobId;

        const done = await pollCaptureJob(jobId, controller.signal);
        if (mountedRef.current && !controller.signal.aborted) {
          activeJobIdRef.current = null;
          setProgress(100);
          setCompletedResult(done);
          setBusy(false);
        }
      } catch (err: unknown) {
        activeJobIdRef.current = null;
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          if (mountedRef.current) setBusy(false);
          return;
        }
        if (mountedRef.current) {
          setFailure(captureErrorFailure(err));
          setBusy(false);
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [busy, pollCaptureJob, targetFormat]
  );

  return { busy, phaseLabel, progress, failure, completedResult, start, cancel, reset };
}
