import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { WebhookDlqEntry } from '@/lib/api-keys/types';
import type { FileWithRemaining } from './dashboard-types';
import { useServerErrorMessage } from '../i18n/problems';

export function useFilesAndDlqController(
  enabled: boolean,
  onReportError: (message: string | null) => void
) {
  const t = useTranslations('dashboard.errors');
  const extractApiError = useServerErrorMessage();
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
        onReportError(extractApiError(data, t('loadFiles', { status: res.status })));
        return;
      }
      if (data && typeof data === 'object' && 'files' in data && Array.isArray(data.files)) {
        setUserFiles(data.files as FileWithRemaining[]);
      }
    } catch {
      onReportError(t('loadFilesNetwork'));
    } finally {
      setFilesLoading(false);
    }
  }, [onReportError, extractApiError, t]);

  const fetchDlqEntries = useCallback(async () => {
    setDlqLoading(true);
    try {
      const res = await fetch('/api/webhooks/dlq');
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        onReportError(extractApiError(data, t('loadDlq', { status: res.status })));
        return;
      }
      if (data && typeof data === 'object' && 'entries' in data && Array.isArray(data.entries)) {
        setDlqEntries(data.entries as WebhookDlqEntry[]);
      }
    } catch {
      onReportError(t('loadDlqNetwork'));
    } finally {
      setDlqLoading(false);
    }
  }, [onReportError, extractApiError, t]);

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
        onReportError(extractApiError(data, t('deleteFile', { status: res.status })));
        return;
      }
      setUserFiles((prev) => prev.filter((file) => file.id !== id));
    } catch {
      onReportError(t('deleteFileNetwork'));
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
        const statusLabel = typeof data.statusCode === 'number' ? data.statusCode : res.status;
        setDlqFeedback(t('replaySucceeded', { status: statusLabel }));
      } else {
        const reason = extractApiError(data, `HTTP ${res.status}`);
        setDlqFeedback(t('replayFailed', { reason }));
      }
      await fetchDlqEntries();
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : t('networkFailure');
      setDlqFeedback(t('replayRequestFailed', { reason }));
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
          extractApiError(data, t('deleteDlq', { status: res.status }))
        );
        return;
      }
      setDlqEntries((prev) => prev.filter((entry) => entry.id !== id));
    } catch {
      onReportError(t('deleteDlqNetwork'));
    }
  };

  const handleClearDlq = async () => {
    onReportError(null);
    try {
      const res = await fetch('/api/webhooks/dlq', { method: 'DELETE' });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        onReportError(
          extractApiError(data, t('clearDlq', { status: res.status }))
        );
        return;
      }
      setDlqEntries([]);
      setDlqFeedback(t('dlqCleared'));
    } catch {
      onReportError(t('clearDlqNetwork'));
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
