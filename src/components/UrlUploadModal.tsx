'use client';

import React, { useState } from 'react';
import { Globe, X, ArrowRight, Loader2, AlertCircle } from 'lucide-react';

interface UrlUploadModalProps {
  onAddFile: (file: File) => void;
  onClose: () => void;
}

export default function UrlUploadModal({ onAddFile, onClose }: UrlUploadModalProps) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    try {
      setLoading(true);
      setError(null);

      // Validate URL format
      new URL(url);

      const response = await fetch('/api/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Failed to fetch file (HTTP ${response.status})`);
      }

      const rawFilename = response.headers.get('X-Filename');
      const filename = rawFilename
        ? decodeURIComponent(rawFilename)
        : url.split('/').pop()?.split('?')[0] || 'remote_file.bin';

      const blob = await response.blob();
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      onAddFile(file);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid URL or network error';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-950/40 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-md bg-white dark:bg-dark-surface rounded-2xl shadow-2xl border border-neutral-border dark:border-dark-border overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-neutral-border dark:border-dark-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-brand-100 dark:bg-brand-900/60 text-brand-700 dark:text-brand-300">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-brand-950 dark:text-dark-text">Add File by URL</h3>
              <p className="text-xs text-ink-muted">Enter a direct public link to any file</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink-muted hover:text-brand-950 dark:hover:text-dark-text hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-brand-950 dark:text-dark-text mb-1.5">File URL</label>
            <input
              type="url"
              required
              placeholder="https://example.com/sample.png"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full px-3.5 py-2 text-sm bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl text-brand-950 dark:text-dark-text focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-status-dangerSoft border border-status-danger/30 text-status-danger text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-ink-secondary dark:text-dark-muted hover:bg-neutral-subtle dark:hover:bg-dark-elevated rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !url.trim()}
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-brand-700 hover:bg-brand-800 disabled:opacity-50 rounded-xl shadow-sm transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Fetching...</span>
                </>
              ) : (
                <>
                  <span>Load File</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
