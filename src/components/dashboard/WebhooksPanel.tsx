import React from 'react';
import { Eye, Inbox, Loader2, Play, RefreshCw, Trash2, X } from 'lucide-react';
import type { WebhookDlqEntry } from '@/lib/api-keys/types';
import { DlqPayloadDialog } from './DlqPayloadDialog';

interface WebhooksPanelProps {
  entries: WebhookDlqEntry[];
  loading: boolean;
  replayingId: string | null;
  feedback: string | null;
  inspectingEntry: WebhookDlqEntry | null;
  onRefresh: () => void;
  onClearAll: () => void;
  onDismissFeedback: () => void;
  onInspect: (entry: WebhookDlqEntry | null) => void;
  onReplay: (id: string) => void;
  onDelete: (id: string) => void;
  onCopy: (text: string) => void;
}

export function WebhooksPanel({
  entries,
  loading,
  replayingId,
  feedback,
  inspectingEntry,
  onRefresh,
  onClearAll,
  onDismissFeedback,
  onInspect,
  onReplay,
  onDelete,
  onCopy,
}: Readonly<WebhooksPanelProps>) {
  return (
    <div id="dashboard-panel-dlq" role="tabpanel" aria-labelledby="dashboard-tab-dlq" className="space-y-6">
      <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-brand-950 dark:text-white">
                Webhook Dead Letter Queue (DLQ)
              </h2>
              {entries.length > 0 && (
                <span className="px-2.5 py-0.5 rounded-md text-xs font-bold bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border border-rose-300 dark:border-rose-800">
                  {entries.length} Failed
                </span>
              )}
            </div>
            <p className="text-sm text-ink-secondary dark:text-dark-muted mt-1">
              Failed webhook deliveries retained after exhausted backoff retries. Inspect payloads or trigger a replay.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-md border border-neutral-border dark:border-dark-border text-xs font-semibold hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            {entries.length > 0 && (
              <button
                type="button"
                onClick={onClearAll}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-md border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-400 text-xs font-semibold hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear DLQ</span>
              </button>
            )}
          </div>
        </div>

        {feedback && (
          <div
            role="status"
            className="mb-4 pl-4 pr-2 py-2 rounded-lg bg-brand-50 dark:bg-brand-950/30 border border-brand-200 dark:border-brand-800/40 text-xs text-brand-900 dark:text-brand-300 flex items-center justify-between gap-2"
          >
            <span>{feedback}</span>
            <button
              type="button"
              onClick={onDismissFeedback}
              aria-label="Dismiss webhook notification"
              className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md hover:bg-brand-100 dark:hover:bg-white/10"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {entries.length === 0 ? (
          <div className="text-center py-14 border border-neutral-border dark:border-dark-border rounded-xl bg-neutral-scaffold/50 dark:bg-dark-scaffold/40">
            <Inbox className="w-10 h-10 text-ink-muted dark:text-dark-muted mx-auto mb-2.5" />
            <p className="text-base font-semibold text-brand-950 dark:text-white">Dead Letter Queue is Empty</p>
            <p className="text-xs text-ink-muted dark:text-dark-muted mt-1 max-w-sm mx-auto">
              All webhook deliveries succeeded or no failed dispatches are pending.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto max-w-full">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-border dark:border-dark-border text-ink-muted dark:text-dark-muted text-xs uppercase">
                  <th className="pb-3 pr-4 font-semibold">Event</th>
                  <th className="pb-3 pr-4 font-semibold">Target URL</th>
                  <th className="pb-3 pr-4 font-semibold">Status</th>
                  <th className="pb-3 pr-4 font-semibold">Failed At</th>
                  <th className="pb-3 pr-4 font-semibold">Retries</th>
                  <th className="pb-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-border dark:divide-dark-border">
                {entries.map((entry) => {
                  const isReplayed = entry.status === 'replayed';
                  return (
                    <tr key={entry.id} className="hover:bg-neutral-scaffold/40 dark:hover:bg-dark-elevated/40">
                      <td className="py-3.5 pr-4 whitespace-nowrap">
                        <span className="font-mono text-xs font-semibold text-brand-700 dark:text-brand-400">
                          {entry.event}
                        </span>
                      </td>
                      <td
                        className="py-3.5 pr-4 font-mono text-xs max-w-xs truncate text-ink-secondary dark:text-dark-muted"
                        title={entry.targetUrl}
                      >
                        {entry.targetUrl}
                      </td>
                      <td className="py-3.5 pr-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border ${
                            isReplayed
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30'
                              : 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30'
                          }`}
                        >
                          {isReplayed ? 'REPLAYED' : `HTTP ${entry.finalStatusCode ?? 'ERR'}`}
                        </span>
                      </td>
                      <td className="py-3.5 pr-4 text-xs text-ink-secondary dark:text-dark-muted whitespace-nowrap">
                        {new Date(entry.failedAt).toLocaleString()}
                      </td>
                      <td className="py-3.5 pr-4 text-xs text-ink-secondary dark:text-dark-muted whitespace-nowrap">
                        {entry.retryCount} attempts
                      </td>
                      <td className="py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onInspect(entry)}
                            aria-label={`Inspect payload for ${entry.event}`}
                            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md border border-neutral-border dark:border-dark-border hover:bg-neutral-subtle dark:hover:bg-dark-elevated text-ink-secondary dark:text-dark-muted hover:text-brand-950 dark:hover:text-white transition-colors"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onReplay(entry.id)}
                            disabled={replayingId === entry.id}
                            aria-label={`Replay webhook ${entry.id}`}
                            className="min-h-[44px] inline-flex items-center gap-1.5 px-3 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold shadow-sm transition-colors disabled:opacity-60"
                          >
                            {replayingId === entry.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                            <span>Replay</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(entry.id)}
                            aria-label={`Delete failed webhook ${entry.id}`}
                            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md border border-neutral-border dark:border-dark-border hover:bg-rose-50 dark:hover:bg-rose-950/30 text-status-danger dark:text-rose-400 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DlqPayloadDialog
        entry={inspectingEntry}
        onClose={() => onInspect(null)}
        onReplay={onReplay}
        onCopy={onCopy}
      />
    </div>
  );
}
