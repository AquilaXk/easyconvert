import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { WebhookDlqEntry } from '@/lib/api-keys/types';
import type { FileWithRemaining } from './dashboard-types';
import { warnBrowserFailure } from '@/lib/browser-failure';
import { useDashboardErrorWording } from '../i18n/error-wording';
import { useRecordDelete } from './useRecordDelete';

export function useFilesAndDlqController(
  enabled: boolean,
  onReportError: (error: string | null) => void
) {
  const t = useTranslations('dashboard.errors');
  const problemWording = useDashboardErrorWording();
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
        onReportError(problemWording(data, res.status, t('loadFiles')));
        return;
      }
      if (data && typeof data === 'object' && 'files' in data && Array.isArray(data.files)) {
        setUserFiles(data.files as FileWithRemaining[]);
      }
    } catch (error) {
      warnBrowserFailure('Reading the converted files failed', error);
      onReportError(t('loadFilesNetwork'));
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
        onReportError(problemWording(data, res.status, t('loadDlq')));
        return;
      }
      if (data && typeof data === 'object' && 'entries' in data && Array.isArray(data.entries)) {
        setDlqEntries(data.entries as WebhookDlqEntry[]);
      }
    } catch (error) {
      warnBrowserFailure('Reading the failed webhooks failed', error);
      onReportError(t('loadDlqNetwork'));
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

  const fileDelete = useRecordDelete({
    url: (id) => `/api/account/files/${id}`,
    goneSentence: t('deleteFileGone'),
    failedSentence: t('deleteFile'),
    networkSentence: t('deleteFileNetwork'),
    warnNetworkFailure: (error) => warnBrowserFailure('Deleting a file failed', error),
    onReportError,
    onRemoved: (id) => setUserFiles((prev) => prev.filter((file) => file.id !== id)),
    refetch: fetchUserFiles,
  });

  const handleReplayWebhook = async (id: string) => {
    setReplayingDlqId(id);
    setDlqFeedback(null);
    onReportError(null);
    try {
      const res = await fetch(`/api/webhooks/dlq/${id}/replay`, { method: 'POST' });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      setDlqFeedback(res.ok && data?.success ? t('replaySucceeded') : problemWording(data, res.status, t('replayFailed')));
      await fetchDlqEntries();
    } catch (error) {
      warnBrowserFailure('Sending a webhook again failed', error);
      setDlqFeedback(t('replayRequestFailed'));
    } finally {
      setReplayingDlqId(null);
    }
  };

  const dlqDelete = useRecordDelete({
    url: (id) => `/api/webhooks/dlq/${id}`,
    goneSentence: t('deleteDlqGone'),
    failedSentence: t('deleteDlq'),
    networkSentence: t('deleteDlqNetwork'),
    warnNetworkFailure: (error) => warnBrowserFailure('Deleting a failed webhook failed', error),
    onReportError,
    onRemoved: (id) => setDlqEntries((prev) => prev.filter((entry) => entry.id !== id)),
    refetch: fetchDlqEntries,
  });

  const handleClearDlq = async () => {
    onReportError(null);
    try {
      const res = await fetch('/api/webhooks/dlq', { method: 'DELETE' });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        onReportError(
          problemWording(data, res.status, t('clearDlq'))
        );
        return;
      }
      setDlqEntries([]);
      setDlqFeedback(t('dlqCleared'));
    } catch (error) {
      warnBrowserFailure('Clearing the failed webhooks failed', error);
      onReportError(t('clearDlqNetwork'));
    }
  };

  return {
    userFiles,
    deletingFileIds: fileDelete.pendingIds,
    filesLoading,
    fetchUserFiles,
    handleDeleteFile: fileDelete.remove,
    dlqEntries,
    dlqLoading,
    inspectingDlq,
    setInspectingDlq,
    replayingDlqId,
    dlqFeedback,
    setDlqFeedback,
    fetchDlqEntries,
    handleReplayWebhook,
    handleDeleteDlq: dlqDelete.remove,
    handleClearDlq,
  };
}
