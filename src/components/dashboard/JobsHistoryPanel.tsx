import React from 'react';
import Link from 'next/link';
import { Clock, Download, FileText, RefreshCw, Trash2 } from 'lucide-react';
import { formatBytes, formatCountdown, type FileWithRemaining } from './dashboard-types';

interface JobsHistoryPanelProps {
  files: FileWithRemaining[];
  loading: boolean;
  onRefresh: () => void;
  onDeleteFile: (id: string) => void;
}

export function JobsHistoryPanel({
  files,
  loading,
  onRefresh,
  onDeleteFile,
}: Readonly<JobsHistoryPanelProps>) {
  return (
    <div
      id="dashboard-panel-files"
      role="tabpanel"
      aria-labelledby="dashboard-tab-files"
      className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-6 shadow-sm"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-lg font-bold text-brand-950 dark:text-white">Recent Conversion Files</h2>
          <p className="text-sm text-ink-secondary dark:text-dark-muted">
            Temporary output files are deleted after download or when their retention timer expires.
          </p>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-md border border-neutral-border dark:border-dark-border text-xs font-semibold hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {files.length === 0 ? (
        <div className="text-center py-14 border border-neutral-border dark:border-dark-border rounded-xl bg-neutral-scaffold/50 dark:bg-dark-scaffold/40">
          <FileText className="w-10 h-10 text-ink-muted dark:text-dark-muted mx-auto mb-2.5" />
          <p className="text-base font-semibold text-brand-950 dark:text-white">No active conversion files</p>
          <p className="text-xs text-ink-muted dark:text-dark-muted mt-1 max-w-sm mx-auto">
            Files converted via your account or API keys appear here with a live automatic expiration countdown.
          </p>
          <Link
            href="/"
            className="min-h-[44px] inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold shadow-sm"
          >
            <span>Open Converter Workbench</span>
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto max-w-full">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-border dark:border-dark-border text-ink-muted dark:text-dark-muted text-xs uppercase">
                <th className="pb-3 pr-4 font-semibold">File Name</th>
                <th className="pb-3 pr-4 font-semibold">Format</th>
                <th className="pb-3 pr-4 font-semibold">Size</th>
                <th className="pb-3 pr-4 font-semibold">Auto-Purge TTL</th>
                <th className="pb-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-border dark:divide-dark-border">
              {files.map((file) => (
                <tr key={file.id} className="hover:bg-neutral-scaffold/40 dark:hover:bg-dark-elevated/40">
                  <td className="py-3.5 pr-4 font-semibold text-brand-950 dark:text-white break-all">
                    {file.fileName}
                  </td>
                  <td className="py-3.5 pr-4 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold px-2 py-0.5 rounded bg-brand-50 dark:bg-white/10 text-brand-800 dark:text-brand-300 border border-brand-200 dark:border-white/10">
                      {file.fromFormat.toUpperCase()} to {file.toFormat.toUpperCase()}
                    </span>
                  </td>
                  <td className="py-3.5 pr-4 text-xs text-ink-secondary dark:text-dark-muted whitespace-nowrap">
                    {formatBytes(file.size)}
                  </td>
                  <td className="py-3.5 pr-4 text-xs font-medium whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30">
                      <Clock className="w-3.5 h-3.5" />
                      {formatCountdown(file.remainingSeconds)}
                    </span>
                  </td>
                  <td className="py-3.5 text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-2">
                      <a
                        href={file.downloadUrl}
                        download={file.fileName}
                        aria-label={`Download ${file.fileName}`}
                        className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md bg-brand-700 text-white hover:bg-brand-800 transition-colors shadow-sm"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                      <button
                        type="button"
                        onClick={() => onDeleteFile(file.id)}
                        aria-label={`Delete ${file.fileName}`}
                        className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md border border-neutral-border dark:border-dark-border text-ink-muted hover:text-status-danger dark:hover:text-rose-400 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
