import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Play, X } from 'lucide-react';
import type { WebhookDlqEntry } from '@/lib/api-keys/types';
import { useModalDialog } from '@/hooks/useModalDialog';

interface DlqPayloadDialogProps {
  entry: WebhookDlqEntry | null;
  onClose: () => void;
  onReplay: (id: string) => void;
}

export function DlqPayloadDialog({
  entry,
  onClose,
  onReplay,
}: Readonly<DlqPayloadDialogProps>) {
  const t = useTranslations('dashboard.dlq.dialog');
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedPayload, setCopiedPayload] = useState(false);

  useModalDialog(dialogRef, Boolean(entry), onClose);

  useEffect(() => {
    setCopiedPayload(false);
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, [entry?.id]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  if (!entry) return null;

  const handleCopyPayload = async (payloadJson: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(payloadJson);
      setCopiedPayload(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopiedPayload(false);
        copyTimerRef.current = null;
      }, 2000);
    } catch {
      setCopiedPayload(false);
    }
  };

  const formattedPayload = JSON.stringify(entry.payload, null, 2);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="dlq-payload-dialog-title"
      className="bg-surface rounded-md border border-rule shadow-elev-2 text-ink max-w-2xl w-[calc(100%-2rem)] p-0"
    >
      <div className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              id="dlq-payload-dialog-title"
              className="text-lg text-ink"
            >
              {t('heading')}
            </h2>
            <p className="text-xs text-ink-2 font-mono mt-0.5 break-all">
              {entry.id} | {entry.event}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm text-ink-2 hover:text-ink hover:bg-sunken transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3 text-xs">
          <div>
            <span className="font-semibold text-ink-3">{t('target')}</span>
            <p className="font-mono bg-sunken p-2.5 rounded-sm mt-1 break-all border border-rule">
              {entry.targetUrl}
            </p>
          </div>

          {entry.errorMessage && (
            <div>
              <span className="font-semibold text-danger">
                {t('error')}
              </span>
              <p className="font-mono text-danger bg-danger-soft p-2.5 rounded-sm mt-1 break-words border border-danger-edge/25">
                {entry.errorMessage}
              </p>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="font-semibold text-ink-3">
                {t('payload')}
              </span>
              <button
                type="button"
                onClick={() => {
                  void handleCopyPayload(formattedPayload);
                }}
                aria-label={t('copyLabel')}
                className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 rounded-sm border border-rule text-xs font-semibold text-accent-ink hover:bg-sunken"
              >
                {copiedPayload ? (
                  <>
                    <Check
                      className="w-3.5 h-3.5 text-success"
                      aria-hidden="true"
                    />
                    <span>{t('copied')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{t('copy')}</span>
                  </>
                )}
              </button>
              <output aria-live="polite" className="sr-only">
                {copiedPayload ? t('copiedAnnouncement') : ''}
              </output>
            </div>
            <pre className="p-3.5 rounded-md text-ink-3 font-mono text-xs overflow-x-auto max-w-full max-h-64 border border-rule">
              <code>{formattedPayload}</code>
            </pre>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2.5 pt-2">
          <button
            type="button"
            onClick={() => {
              onReplay(entry.id);
              onClose();
            }}
            className="btn-primary min-h-[44px] px-4 py-2 rounded-sm font-semibold text-xs inline-flex items-center gap-1.5"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{t('replay')}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 py-2 rounded-sm border border-rule text-xs font-semibold hover:bg-sunken"
          >
            {t('closeButton')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
