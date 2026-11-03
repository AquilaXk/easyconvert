'use client';

import React, { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { X, Loader2, AlertCircle } from 'lucide-react';
import { useModalDialog } from '@/hooks/useModalDialog';
import { URL_IMPORT_MAX_BYTES } from '@/lib/plan-limits';
import { useFormatBytes } from './i18n/format';
import { useUrlImportErrorWording } from './i18n/error-wording';

export interface UrlImportModalProps {
  isOpen?: boolean;
  onClose: () => void;
  onAddFile?: (file: File) => void;
}

export default function UrlImportModal({
  isOpen = true,
  onClose,
  onAddFile,
}: Readonly<UrlImportModalProps>) {
  const t = useTranslations('urlImport');
  const formatBytes = useFormatBytes();
  const urlImportErrorWording = useUrlImportErrorWording();
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

    setLoading(true);
    setError(null);
    try {
      new URL(targetUrl);
    } catch {
      setError(t('invalidUrl'));
      setLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => ({}));
        setError(urlImportErrorWording(payload, response.status));
        return;
      }

      const rawFilename = response.headers.get('X-Filename');
      const filename = rawFilename
        ? decodeURIComponent(rawFilename)
        : targetUrl.split('/').pop()?.split('?')[0] || 'remote_file.bin';

      const blob = await response.blob();
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });

      onAddFile?.(file);
      onClose();
    } catch {
      setError(t('networkError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="url-import-heading"
      className="w-[calc(100dvw-1.5rem)] max-w-3xl rounded-xs p-0 bg-surface text-ink border border-rule shadow-elev-2 overflow-hidden"
    >
      <div className="px-5 py-4 border-b border-rule flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="url-import-heading" className="text-base font-semibold text-ink">
            {t('heading')}
          </h2>
          <p className="text-xs text-ink-3">
            {t('intro', { size: formatBytes(URL_IMPORT_MAX_BYTES) })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="min-w-[44px] min-h-[44px] -mr-2 inline-flex items-center justify-center rounded-xs text-ink-2 hover:text-ink hover:bg-sunken transition-colors cursor-pointer"
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
            {t('label')}
          </label>
          <input
            id="url-input"
            type="url"
            required
            placeholder="https://example.com/document.pdf"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full min-h-[44px] px-3.5 text-base bg-surface/80 border border-rule-strong rounded-xs text-ink placeholder-ink-3 focus:border-accent"
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xs bg-danger-soft border border-danger-edge text-danger text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p role="alert" className="min-w-0">{error}</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 text-sm font-medium text-ink-2 hover:text-ink hover:bg-sunken rounded-xs transition-colors cursor-pointer"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="btn-primary min-h-[44px] px-5 inline-flex items-center gap-2 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed rounded-xs cursor-pointer"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{t('fetching')}</span>
              </>
            ) : (
              <span>{t('submit')}</span>
            )}
          </button>
        </div>
      </form>
    </dialog>
  );
}
