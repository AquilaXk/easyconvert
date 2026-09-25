'use client';

import React, { useState } from 'react';
import { Globe, X, ArrowRight, Loader2, AlertCircle } from 'lucide-react';

interface UrlImportModalProps {
  isOpen?: boolean;
  onClose: () => void;
  onImport?: (file: File) => void;
  onAddFile?: (file: File) => void;
}

export default function UrlImportModal({
  isOpen = true,
  onClose,
  onImport,
  onAddFile,
}: UrlImportModalProps) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetUrl = url.trim();
    if (!targetUrl) return;

    try {
      setLoading(true);
      setError(null);

      // Validate URL
      new URL(targetUrl);

      const response = await fetch('/api/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Failed to fetch file (HTTP ${response.status})`);
      }

      const rawFilename = response.headers.get('X-Filename');
      const filename = rawFilename
        ? decodeURIComponent(rawFilename)
        : targetUrl.split('/').pop()?.split('?')[0] || 'remote_file.bin';

      const blob = await response.blob();
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });

      if (onImport) onImport(file);
      if (onAddFile) onAddFile(file);

      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid URL or network error';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md bg-neutral-900 text-white rounded-2xl shadow-2xl border border-neutral-700/80 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-neutral-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-[#d9383a]/20 text-[#d9383a] border border-[#d9383a]/30">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Add File by URL</h3>
              <p className="text-xs text-neutral-400">Enter a direct public link to any file</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label htmlFor="url-input" className="block text-xs font-semibold text-neutral-300 mb-1.5">
              File URL
            </label>
            <input
              id="url-input"
              type="url"
              required
              autoFocus
              placeholder="https://example.com/document.pdf"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm bg-neutral-800/80 border border-neutral-700 rounded-xl text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-[#d9383a] focus:border-transparent transition-all"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-950/40 border border-red-500/40 text-red-300 text-xs animate-in fade-in duration-150">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-neutral-400 hover:text-white hover:bg-white/5 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !url.trim()}
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#d9383a] hover:bg-[#c22e30] active:bg-[#a82527] disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-[#d9383a]/20 transition-all"
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
