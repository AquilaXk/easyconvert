import { useCallback, useRef, useState } from 'react';
import { useDashboardErrorWording } from '../i18n/error-wording';

const HTTP_NOT_FOUND = 404;

export interface RecordDeleteOptions {
  /** The route that deletes the record of `id`. */
  url: (id: string) => string;
  /** A 404: the record was gone before the request. */
  goneSentence: string;
  /** Any other refusal or failure the answer does not word by its code. */
  failedSentence: string;
  /** The request never reached the server. */
  networkSentence: string;
  /** Writes the English reason of a request that never reached the server to the console (`warnBrowserFailure`). */
  warnNetworkFailure: (error: unknown) => void;
  onReportError: (error: string | null) => void;
  /** The record is gone, deleted now or before (`wasGone`): the caller drops its row. */
  onRemoved: (id: string, wasGone: boolean) => void;
  /** Reads the list again, so that a read in flight while the record was deleted cannot bring its row back. */
  refetch: () => Promise<void>;
}

/**
 * The deletion of a dashboard record (a converted file, a failed webhook, an API key): one request per record at a time, a
 * 404 read as "already gone" with the row dropped, any other refusal worded by its code, and the list read again after an
 * answer that removed the record.
 */
export function useRecordDelete({
  url, goneSentence, failedSentence, networkSentence, warnNetworkFailure, onReportError, onRemoved, refetch,
}: RecordDeleteOptions) {
  const errorWording = useDashboardErrorWording();
  const pending = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);

  const setPending = useCallback((id: string, isPending: boolean) => {
    if (isPending) pending.current.add(id);
    else pending.current.delete(id);
    setPendingIds([...pending.current]);
  }, []);

  const remove = async (id: string): Promise<void> => {
    if (pending.current.has(id)) return;
    setPending(id, true);
    onReportError(null);
    try {
      const res = await fetch(url(id), { method: 'DELETE' });
      if (res.ok || res.status === HTTP_NOT_FOUND) {
        const wasGone = !res.ok;
        if (wasGone) onReportError(goneSentence);
        onRemoved(id, wasGone);
        await refetch();
        return;
      }
      const data: unknown = await res.json().catch(() => null);
      onReportError(errorWording(data, res.status, failedSentence));
    } catch (error) {
      warnNetworkFailure(error);
      onReportError(networkSentence);
    } finally {
      setPending(id, false);
    }
  };

  return { pendingIds, remove };
}
