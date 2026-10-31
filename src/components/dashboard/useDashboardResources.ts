import { useCallback, useEffect, useState } from 'react';
import type { WebhookDlqEntry } from '@/lib/api-keys/types';
import { extractApiError, type FileWithRemaining } from './dashboard-types';

export function useFilesAndDlqController(
  enabled: boolean,
  onReportError: (message: string | null) => void
) {
  const [userFiles, setUserFiles] = useState<FileWithRemaining[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [dlqEntries, setDlqEntries] = useState<WebhookDlqEntry[]>([]);
  const [dlqLoading, setDlqLoading] = useState(false);
  const [inspectingDlq, setInspectingDlq] = useState<WebhookDlqEntry | null>(null);
  const [replayingDlqId, setReplayingDlqId] = useState<string | null>(null);
  const [dlqFeedback, setDlqFeedback] = useState<string | null>(null);

  const fetchUserFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const res = await fetch('/api/account/files');
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        onReportError(extractApiError(data, `Failed to load converted files (HTTP ${res.status}).`));
        return;
      }
      if (data && typeof data === 'object' && 'files' in data && Array.isArray(data.files)) {
        setUserFiles(data.files as FileWithRemaining[]);
      }
    } catch {
      onReportError('Network error while loading converted files.');
    } finally {
      setFilesLoading(false);
    }
  }, [onReportError]);

  const fetchDlqEntries = useCallback(async () => {
    setDlqLoading(true);
    try {
      const res = await fetch('/api/webhooks/dlq');
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        onReportError(extractApiError(data, `Failed to load webhook DLQ (HTTP ${res.status}).`));
        return;
      }
      if (data && typeof data === 'object' && 'entries' in data && Array.isArray(data.entries)) {
        setDlqEntries(data.entries as WebhookDlqEntry[]);
      }
    } catch {
      onReportError('Network error while loading webhook DLQ.');
    } finally {
      setDlqLoading(false);
    }
  }, [onReportError]);

  useEffect(() => {
    if (enabled) {
      void fetchUserFiles();
      void fetchDlqEntries();
    }
  }, [enabled, fetchUserFiles, fetchDlqEntries]);

  const hasActiveFiles = userFiles.length > 0;

  useEffect(() => {
    if (!hasActiveFiles) {
      return;
    }
    const timer = setInterval(() => {
      setUserFiles((prev) =>
        prev
          .map((file) => ({
            ...file,
            remainingSeconds: Math.max(0, file.remainingSeconds - 1),
          }))
          .filter((file) => file.remainingSeconds > 0)
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [hasActiveFiles]);

  const handleDeleteFile = async (id: string) => {
    onReportError(null);
    try {
      const res = await fetch(`/api/account/files/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        onReportError(extractApiError(data, `Failed to delete file (HTTP ${res.status}).`));
        return;
      }
      setUserFiles((prev) => prev.filter((file) => file.id !== id));
    } catch {
      onReportError('Network error while deleting file.');
    }
  };

  const handleReplayWebhook = async (id: string) => {
    setReplayingDlqId(id);
    setDlqFeedback(null);
    onReportError(null);
    try {
      const res = await fetch(`/api/webhooks/dlq/${id}/replay`, { method: 'POST' });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && data?.success) {
        setDlqFeedback(`Webhook replay succeeded (HTTP ${String(data.statusCode ?? res.status)}).`);
      } else {
        const reason = extractApiError(data, `HTTP ${res.status}`);
        setDlqFeedback(`Webhook replay failed (${reason}).`);
      }
      await fetchDlqEntries();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Network failure';
      setDlqFeedback(`Replay request failed (${msg}).`);
    } finally {
      setReplayingDlqId(null);
    }
  };

  const handleDeleteDlq = async (id: string) => {
    onReportError(null);
    try {
      const res = await fetch(`/api/webhooks/dlq/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        onReportError(
          extractApiError(data, `Failed to delete webhook entry (HTTP ${res.status}).`)
        );
        return;
      }
      setDlqEntries((prev) => prev.filter((entry) => entry.id !== id));
    } catch {
      onReportError('Network error while deleting webhook entry.');
    }
  };

  const handleClearDlq = async () => {
    onReportError(null);
    try {
      const res = await fetch('/api/webhooks/dlq', { method: 'DELETE' });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        onReportError(
          extractApiError(data, `Failed to clear dead letter queue (HTTP ${res.status}).`)
        );
        return;
      }
      setDlqEntries([]);
      setDlqFeedback('Dead letter queue cleared.');
    } catch {
      onReportError('Network error while clearing dead letter queue.');
    }
  };

  return {
    userFiles,
    filesLoading,
    fetchUserFiles,
    handleDeleteFile,
    dlqEntries,
    dlqLoading,
    inspectingDlq,
    setInspectingDlq,
    replayingDlqId,
    dlqFeedback,
    setDlqFeedback,
    fetchDlqEntries,
    handleReplayWebhook,
    handleDeleteDlq,
    handleClearDlq,
  };
}
