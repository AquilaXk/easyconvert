'use client';

import React, { useState, useRef } from 'react';
import { Globe, X, ArrowRight, Loader2, AlertCircle } from 'lucide-react';
import { useModalDialog } from '@/hooks/useModalDialog';
import { formatBytes } from '@/lib/format-bytes';
import { URL_IMPORT_MAX_BYTES } from '@/lib/plan-limits';

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
      className="w-[calc(100dvw-1.5rem)] max-w-md rounded-md p-0 glass text-ink border border-rule shadow-elev-2 overflow-hidden"
    >
      <div className="px-5 py-4 border-b border-rule flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-9 text-accent-ink inline-flex items-center justify-center shrink-0">
            <Globe className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2
              id="url-import-heading"
              className="text-lg text-ink"
            >
              Add File from URL
            </h2>
            <p className="text-xs text-ink-3">
              Enter a direct HTTP or HTTPS link to a file of up to {formatBytes(URL_IMPORT_MAX_BYTES)}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="min-w-[44px] min-h-[44px] -mr-2 inline-flex items-center justify-center rounded-sm text-ink-2 hover:text-ink hover:bg-sunken transition-colors cursor-pointer"
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
            className="block text-xs font-semibold text-ink mb-1.5"
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
            className="w-full min-h-[44px] px-3.5 text-base bg-surface/80 border border-rule-strong rounded-sm text-ink placeholder-ink-3 focus:border-accent"
          />
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 p-3 rounded-sm bg-danger-soft border border-danger-edge text-danger text-xs"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 text-sm font-medium text-ink-2 hover:text-ink hover:bg-sunken rounded-sm transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="lift min-h-[44px] px-5 inline-flex items-center gap-2 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover hover:shadow-glow active:bg-accent-press disabled:opacity-50 disabled:cursor-not-allowed rounded-sm cursor-pointer"
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
