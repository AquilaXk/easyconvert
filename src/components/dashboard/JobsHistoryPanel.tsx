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
      className="border-t border-rule-strong pt-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl text-ink">Recent Conversion Files</h2>
          <p className="text-sm text-ink-2">
            Temporary output files are deleted after download or when their retention timer expires.
          </p>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-sm border border-rule text-xs font-semibold hover:bg-sunken transition-colors self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {files.length === 0 ? (
        <div className="text-center py-14 border border-dashed border-rule-strong/60 rounded-sm">
          <FileText className="w-10 h-10 text-ink-3 mx-auto mb-2.5" />
          <p className="text-base font-semibold text-ink">No active conversion files</p>
          <p className="text-xs text-ink-3 mt-1 max-w-sm mx-auto">
            Files converted via your account or API keys appear here with a live automatic expiration countdown.
          </p>
          <Link
            href="/"
            className="lift min-h-[44px] inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-sm bg-accent hover:bg-accent-hover hover:shadow-glow text-on-accent text-xs font-semibold"
          >
            <span>Open Converter Workbench</span>
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto max-w-full">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-rule text-ink-3 text-xs uppercase">
                <th className="pb-3 pr-4 font-semibold">File Name</th>
                <th className="pb-3 pr-4 font-semibold">Format</th>
                <th className="pb-3 pr-4 font-semibold">Size</th>
                <th className="pb-3 pr-4 font-semibold">Auto-Purge TTL</th>
                <th className="pb-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {files.map((file) => (
                <tr key={file.id} className="hover:bg-sunken/50">
                  <td className="py-3.5 pr-4 font-semibold text-ink break-all">
                    {file.fileName}
                  </td>
                  <td className="py-3.5 pr-4 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold px-2 py-0.5 rounded-md bg-accent-soft text-accent-ink border border-accent-edge">
                      {file.fromFormat.toUpperCase()} to {file.toFormat.toUpperCase()}
                    </span>
                  </td>
                  <td className="py-3.5 pr-4 text-xs text-ink-2 whitespace-nowrap">
                    {formatBytes(file.size)}
                  </td>
                  <td className="py-3.5 pr-4 text-xs font-medium whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-warning-soft text-warning border border-warning-edge">
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
                        className="lift min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm bg-accent text-on-accent hover:bg-accent-hover hover:shadow-glow"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                      <button
                        type="button"
                        onClick={() => onDeleteFile(file.id)}
                        aria-label={`Delete ${file.fileName}`}
                        className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm border border-rule text-ink-3 hover:text-danger transition-colors"
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
