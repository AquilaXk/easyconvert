import React from 'react';
import { useFormatter, useTranslations } from 'next-intl';
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
}: Readonly<WebhooksPanelProps>) {
  const t = useTranslations('dashboard.dlq');
  const format = useFormatter();
  return (
    <div
      id="dashboard-panel-dlq"
      role="tabpanel"
      aria-labelledby="dashboard-tab-dlq"
      className="space-y-6"
    >
      <div className="border-t border-rule-strong pt-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl text-ink">
                {t('heading')}
              </h2>
              {entries.length > 0 && (
                <span className="px-2.5 py-0.5 rounded-sm text-xs font-bold bg-danger-soft text-danger border border-danger-edge">
                  {t('failedCount', { count: entries.length })}
                </span>
              )}
            </div>
            <p className="text-sm text-ink-2 mt-1">
              {t('intro')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-sm border border-rule text-xs font-semibold hover:bg-sunken transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>{t('refresh')}</span>
            </button>
            {entries.length > 0 && (
              <button
                type="button"
                onClick={onClearAll}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-sm border border-danger-edge text-danger text-xs font-semibold hover:bg-danger-soft transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{t('clear')}</span>
              </button>
            )}
          </div>
        </div>

        {feedback && (
          <output
            aria-live="polite"
            className="mb-4 pl-4 pr-2 py-2 rounded-md bg-accent-soft border border-accent-edge text-xs text-accent-ink flex items-center justify-between gap-2"
          >
            <span>{feedback}</span>
            <button
              type="button"
              onClick={onDismissFeedback}
              aria-label={t('dismissFeedback')}
              className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm hover:bg-accent-soft"
            >
              <X className="w-4 h-4" />
            </button>
          </output>
        )}

        {entries.length === 0 ? (
          <div className="text-center py-14 border border-dashed border-rule-strong/60 rounded-sm">
            <Inbox className="w-10 h-10 text-ink-3 mx-auto mb-2.5" />
            <p className="text-base font-semibold text-ink">
              {t('emptyHeading')}
            </p>
            <p className="text-xs text-ink-3 mt-1 max-w-sm mx-auto">
              {t('emptyBody')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto max-w-full">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-rule text-ink-3 text-xs uppercase">
                  <th className="pb-3 pr-4 font-semibold">{t('columns.event')}</th>
                  <th className="pb-3 pr-4 font-semibold">{t('columns.target')}</th>
                  <th className="pb-3 pr-4 font-semibold">{t('columns.status')}</th>
                  <th className="pb-3 pr-4 font-semibold">{t('columns.failedAt')}</th>
                  <th className="pb-3 pr-4 font-semibold">{t('columns.retries')}</th>
                  <th className="pb-3 font-semibold text-right">{t('columns.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {entries.map((entry) => {
                  const isReplayed = entry.status === 'replayed';
                  return (
                    <tr
                      key={entry.id}
                      className="hover:bg-sunken/50"
                    >
                      <td className="py-3.5 pr-4 whitespace-nowrap">
                        <span className="font-mono text-xs font-semibold text-accent-ink">
                          {entry.event}
                        </span>
                      </td>
                      <td
                        className="py-3.5 pr-4 font-mono text-xs max-w-xs truncate text-ink-2"
                        title={entry.targetUrl}
                      >
                        {entry.targetUrl}
                      </td>
                      <td className="py-3.5 pr-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-semibold border ${
                            isReplayed
                              ? 'bg-success-soft text-success border-success-edge'
                              : 'bg-danger-soft text-danger border-danger-edge'
                          }`}
                        >
                          {isReplayed ? t('replayed') : `HTTP ${entry.finalStatusCode ?? 'ERR'}`}
                        </span>
                      </td>
                      <td className="py-3.5 pr-4 text-xs text-ink-2 whitespace-nowrap">
                        {format.dateTime(new Date(entry.failedAt), { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="py-3.5 pr-4 text-xs text-ink-2 whitespace-nowrap">
                        {t('attempts', { count: entry.retryCount })}
                      </td>
                      <td className="py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onInspect(entry)}
                            aria-label={t('inspectLabel', { event: entry.event })}
                            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm border border-rule hover:bg-sunken text-ink-2 hover:text-ink transition-colors"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onReplay(entry.id)}
                            disabled={replayingId === entry.id}
                            aria-label={t('replayLabel', { id: entry.id })}
                            className="lift min-h-[44px] inline-flex items-center gap-1.5 px-3 rounded-sm bg-accent hover:bg-accent-hover hover:shadow-glow text-on-accent text-xs font-semibold disabled:opacity-60"
                          >
                            {replayingId === entry.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                            <span>{t('replay')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(entry.id)}
                            aria-label={t('deleteLabel', { id: entry.id })}
                            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm border border-rule hover:bg-danger-soft text-danger transition-colors"
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
      />
    </div>
  );
}
