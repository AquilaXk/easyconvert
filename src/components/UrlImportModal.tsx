'use client';

import React, { useState, useRef } from 'react';
import { Globe, X, ArrowRight, Loader2, AlertCircle } from 'lucide-react';
import { useModalDialog } from '@/hooks/useModalDialog';

export interface UrlImportModalProps {
  isOpen?: boolean;
  onClose: () => void;
  onAddFile?: (file: File) => void;
}

interface FetchUrlErrorPayload {
  error?: string;
}

export default function UrlImportModal({
  isOpen = true,
  onClose,
  onAddFile,
}: Readonly<UrlImportModalProps>) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useModalDialog(dialogRef, isOpen, onClose);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetUrl = url.trim();
    if (!targetUrl) return;

    try {
      setLoading(true);
      setError(null);
      new URL(targetUrl);

      const response = await fetch('/api/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });

      if (!response.ok) {
        const errJson = (await response.json().catch(() => ({}))) as FetchUrlErrorPayload;
        throw new Error(errJson.error || `Failed to fetch file (HTTP ${response.status})`);
      }

      const rawFilename = response.headers.get('X-Filename');
      const filename = rawFilename
        ? decodeURIComponent(rawFilename)
        : targetUrl.split('/').pop()?.split('?')[0] || 'remote_file.bin';

      const blob = await response.blob();
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });

      onAddFile?.(file);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invalid URL or network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="url-import-heading"
      className="w-[calc(100dvw-1.5rem)] max-w-md rounded-xl p-0 bg-white dark:bg-dark-surface text-brand-950 dark:text-white border border-neutral-border dark:border-dark-border shadow-2xl overflow-hidden"
    >
      <div className="px-5 py-4 border-b border-neutral-border dark:border-dark-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-9 rounded-lg bg-brand-50 dark:bg-white/10 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-white/10 inline-flex items-center justify-center shrink-0">
            <Globe className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2
              id="url-import-heading"
              className="text-base font-semibold text-brand-950 dark:text-white"
            >
              Add File from URL
            </h2>
            <p className="text-xs text-ink-muted dark:text-dark-muted">
              Enter a direct HTTP or HTTPS link to a file
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="min-w-[44px] min-h-[44px] -mr-2 inline-flex items-center justify-center rounded-md text-ink-secondary dark:text-slate-300 hover:text-brand-950 dark:hover:text-white hover:bg-neutral-subtle dark:hover:bg-white/10 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="p-5 space-y-4"
      >
        <div>
          <label
            htmlFor="url-input"
            className="block text-xs font-semibold text-brand-950 dark:text-slate-200 mb-1.5"
          >
            File URL
          </label>
          <input
            id="url-input"
            type="url"
            required
            placeholder="https://example.com/document.pdf"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full min-h-[44px] px-3.5 text-base bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border rounded-md text-brand-950 dark:text-white placeholder-ink-muted dark:placeholder-dark-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus:border-brand-700"
          />
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 p-3 rounded-md bg-status-dangerSoft dark:bg-red-950/40 border border-red-300 dark:border-red-500/40 text-status-danger dark:text-red-300 text-xs"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 text-sm font-medium text-ink-secondary dark:text-slate-300 hover:text-brand-950 dark:hover:text-white hover:bg-neutral-subtle dark:hover:bg-white/10 rounded-md transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="min-h-[44px] px-5 inline-flex items-center gap-2 text-sm font-semibold text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors cursor-pointer"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Fetching...</span>
              </>
            ) : (
              <>
                <span>Load File</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </form>
    </dialog>
  );
}
