import React, { useEffect, useRef } from 'react';
import { Copy, Play, X } from 'lucide-react';
import type { WebhookDlqEntry } from '@/lib/api-keys/types';

interface DlqPayloadDialogProps {
  entry: WebhookDlqEntry | null;
  onClose: () => void;
  onReplay: (id: string) => void;
  onCopy: (text: string) => void;
}

export function DlqPayloadDialog({
  entry,
  onClose,
  onReplay,
  onCopy,
}: Readonly<DlqPayloadDialogProps>) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (entry) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [entry]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          onClose();
        }
      }}
      aria-labelledby="dlq-payload-dialog-title"
      className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-brand-950 dark:text-white max-w-2xl w-[calc(100%-2rem)] p-0 shadow-lg backdrop:bg-black/50"
    >
      {entry && (
        <div className="p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="dlq-payload-dialog-title" className="text-base font-bold text-brand-950 dark:text-white">
                Inspect Webhook Payload
              </h2>
              <p className="text-xs text-ink-secondary dark:text-dark-muted font-mono mt-0.5 break-all">
                {entry.id} | {entry.event}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close payload viewer"
              className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md text-ink-secondary dark:text-dark-muted hover:text-brand-950 dark:hover:text-white hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="space-y-3 text-xs">
            <div>
              <span className="font-semibold text-ink-muted dark:text-dark-muted">Target URL</span>
              <p className="font-mono bg-neutral-subtle dark:bg-dark-elevated p-2.5 rounded-md mt-1 break-all border border-neutral-border dark:border-dark-border">
                {entry.targetUrl}
              </p>
            </div>

            {entry.errorMessage && (
              <div>
                <span className="font-semibold text-status-danger dark:text-rose-400">Delivery Error</span>
                <p className="font-mono text-status-danger dark:text-rose-300 bg-status-dangerSoft dark:bg-rose-950/30 p-2.5 rounded-md mt-1 break-words border border-status-danger/25 dark:border-rose-800/50">
                  {entry.errorMessage}
                </p>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="font-semibold text-ink-muted dark:text-dark-muted">Payload JSON</span>
                <button
                  type="button"
                  onClick={() => onCopy(JSON.stringify(entry.payload, null, 2))}
                  aria-label="Copy webhook payload JSON"
                  className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 rounded-md border border-neutral-border dark:border-dark-border text-xs font-semibold text-brand-700 dark:text-brand-300 hover:bg-neutral-subtle dark:hover:bg-dark-elevated"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Payload</span>
                </button>
              </div>
              <pre className="p-3.5 rounded-lg bg-brand-950 dark:bg-dark-scaffold text-neutral-subtle font-mono text-xs overflow-x-auto max-w-full max-h-64 border border-neutral-border dark:border-dark-border">
                <code>{JSON.stringify(entry.payload, null, 2)}</code>
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
              className="min-h-[44px] px-4 py-2 rounded-md bg-brand-700 hover:bg-brand-800 text-white font-semibold text-xs inline-flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Replay Now</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 py-2 rounded-md border border-neutral-border dark:border-dark-border text-xs font-semibold hover:bg-neutral-subtle dark:hover:bg-dark-elevated"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
