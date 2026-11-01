import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { WebhookDlqEntry } from '@/lib/api-keys/types';
import type { FileWithRemaining } from './dashboard-types';
import { useProblemWording, type ErrorWording } from '../i18n/error-wording';

export function useFilesAndDlqController(
  enabled: boolean,
  onReportError: (error: ErrorWording | null) => void
) {
  const t = useTranslations('dashboard.errors');
  const problemWording = useProblemWording();
  const [userFiles, setUserFiles] = useState<FileWithRemaining[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [dlqEntries, setDlqEntries] = useState<WebhookDlqEntry[]>([]);
  const [dlqLoading, setDlqLoading] = useState(false);
  const [inspectingDlq, setInspectingDlq] = useState<WebhookDlqEntry | null>(null);
  const [replayingDlqId, setReplayingDlqId] = useState<string | null>(null);
  const [dlqFeedback, setDlqFeedback] = useState<ErrorWording | null>(null);

  const fetchUserFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const res = await fetch('/api/account/files');
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        onReportError(problemWording(data, res.status, t('loadFiles', { status: res.status })));
        return;
      }
      if (data && typeof data === 'object' && 'files' in data && Array.isArray(data.files)) {
        setUserFiles(data.files as FileWithRemaining[]);
      }
    } catch {
      onReportError({ message: t('loadFilesNetwork') });
    } finally {
      setFilesLoading(false);
    }
  }, [onReportError, problemWording, t]);

  const fetchDlqEntries = useCallback(async () => {
    setDlqLoading(true);
    try {
      const res = await fetch('/api/webhooks/dlq');
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        onReportError(problemWording(data, res.status, t('loadDlq', { status: res.status })));
        return;
      }
      if (data && typeof data === 'object' && 'entries' in data && Array.isArray(data.entries)) {
        setDlqEntries(data.entries as WebhookDlqEntry[]);
      }
    } catch {
      onReportError({ message: t('loadDlqNetwork') });
    } finally {
      setDlqLoading(false);
    }
  }, [onReportError, problemWording, t]);

  // The read runs when the dashboard is enabled, not again when the zone switch after hydration renews the wording.
  const readersRef = useRef({ fetchUserFiles, fetchDlqEntries });
  readersRef.current = { fetchUserFiles, fetchDlqEntries };
  useEffect(() => {
    if (!enabled) return;
    void readersRef.current.fetchUserFiles();
    void readersRef.current.fetchDlqEntries();
  }, [enabled]);

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
        onReportError(problemWording(data, res.status, t('deleteFile', { status: res.status })));
        return;
      }
      setUserFiles((prev) => prev.filter((file) => file.id !== id));
    } catch {
      onReportError({ message: t('deleteFileNetwork') });
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
        setDlqFeedback({ message: t('replaySucceeded', { status: statusLabel }) });
      } else {
        setDlqFeedback(problemWording(data, res.status, t('replayFailed')));
      }
      await fetchDlqEntries();
    } catch (err: unknown) {
      setDlqFeedback({ message: t('replayRequestFailed'), technical: err instanceof Error ? err.message : undefined });
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
          problemWording(data, res.status, t('deleteDlq', { status: res.status }))
        );
        return;
      }
      setDlqEntries((prev) => prev.filter((entry) => entry.id !== id));
    } catch {
      onReportError({ message: t('deleteDlqNetwork') });
    }
  };

  const handleClearDlq = async () => {
    onReportError(null);
    try {
      const res = await fetch('/api/webhooks/dlq', { method: 'DELETE' });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        onReportError(
          problemWording(data, res.status, t('clearDlq', { status: res.status }))
        );
        return;
      }
      setDlqEntries([]);
      setDlqFeedback({ message: t('dlqCleared') });
    } catch {
      onReportError({ message: t('clearDlqNetwork') });
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
