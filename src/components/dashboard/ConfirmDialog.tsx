'use client';

import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { useModalDialog } from '@/hooks/useModalDialog';

/*
 * The confirmation dialog of a destructive action. Its flow is the one of `TextConfirmModal` of supabase/supabase
 * (packages/ui-patterns/src/Dialogs/TextConfirmModal.tsx at commit 6b39a00d332704a6cb5396ea948e5f72595b0bf6, used by
 * apps/studio/components/interfaces/APIKeys/APIKeyRow.tsx to delete an API key), Apache-2.0 (the LICENSE of that repository names
 * no copyright holder):
 * a title, a destructive notice, "type the name to confirm" with the typed text trimmed and compared to the name exactly, the
 * confirm button off until they match and while the request runs, and the text cleared each time the dialog opens. That
 * source is written for Radix, react-hook-form and the Supabase UI kit, none of which this project uses, so the dialog is
 * written again on the native `<dialog>` of `useModalDialog` (focus trap, Escape, `aria-modal` and the inert page behind it
 * come from the browser) and the tokens of the site (docs/licensing.md). The wording and the placement of the two buttons
 * (cancel on the left, the red action on the right, the action named for what it does, the name of the thing shown) follow the
 * destructive-action guidance of the Vercel Geist design system.
 */

const FIELD_CLASS =
  'mt-1.5 w-full min-h-[44px] px-3.5 py-2 rounded-sm bg-canvas border border-rule-strong text-base sm:text-sm text-ink';
const CANCEL_CLASS =
  'min-h-[44px] inline-flex items-center justify-center px-4 py-2 rounded-sm border border-rule text-ink text-sm font-medium hover:bg-sunken disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';
const CONFIRM_CLASS =
  'min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-sm bg-danger text-canvas border border-danger text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';
const LABEL_CLASS = 'block text-sm font-medium leading-snug text-ink';

export interface ConfirmPhrase {
  /** The text the person types: trimmed on both sides, then equal to it. */
  value: string;
  /** Names the field and what to type; it is the label of the input. */
  label: ReactNode;
  /** Gives the input an id the page can name. */
  inputId?: string;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What the action does, under the title. */
  description?: ReactNode;
  /** The destructive notice: what cannot be undone. */
  warning?: ReactNode;
  /** What is being acted on (a name, a prefix), between the notice and the fields. */
  details?: ReactNode;
  /** With it the confirm button stays off until its `value` is typed; without it the dialog is a plain confirmation. */
  phrase?: ConfirmPhrase;
  /** More fields of the form (account deletion asks for a credential too). */
  children?: ReactNode;
  confirmLabel: string;
  /** The confirm button while the request runs; the confirm label when left out. */
  pendingLabel?: string;
  cancelLabel: string;
  closeLabel: string;
  pending?: boolean;
  /** Why the last attempt failed. The dialog stays open so the person can try again. */
  error?: string | null;
  /** Keeps the confirm button off for a reason the dialog does not know (a field of `children` is empty). */
  confirmBlocked?: boolean;
  /** An icon in the confirm button. */
  confirmIcon?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * A modal confirmation: the title names the action, the notice says what it costs, and the red button on the right does it.
 * Escape, the close button, the cancel button and a click on the backdrop close it, none of them while the request runs. The
 * first field gets the focus (the cancel button when there is none, so that Enter cannot confirm by accident).
 */
export function ConfirmDialog({
  open, title, description, warning, details, phrase, children, confirmLabel, pendingLabel, cancelLabel, closeLabel,
  pending = false, error = null, confirmBlocked = false, confirmIcon, onConfirm, onClose,
}: Readonly<ConfirmDialogProps>) {
  const titleId = useId();
  const phraseId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [typed, setTyped] = useState('');
  const closeUnlessPending = () => {
    if (!pending) onClose();
  };

  useModalDialog(dialogRef, open, closeUnlessPending);
  useEffect(() => {
    if (!open) return;
    setTyped('');
    (dialogRef.current?.querySelector<HTMLInputElement>('form input') ?? cancelRef.current)?.focus();
  }, [open]);

  if (!open) return null;

  const matches = !phrase || typed.trim() === phrase.value.trim();
  const ready = matches && !confirmBlocked && !pending;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
      className="!m-auto bg-surface rounded-md border border-rule shadow-elev-2 text-ink max-w-md w-[calc(100%-2rem)] p-0"
    >
      <div className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold leading-snug text-ink">{title}</h2>
            {description && <p className="mt-1 text-sm font-normal leading-relaxed text-ink-3">{description}</p>}
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={closeUnlessPending}
            aria-label={closeLabel}
            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm text-ink-2 hover:text-ink hover:bg-sunken transition-colors shrink-0 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {warning && (
          <div className="flex items-start gap-2.5 p-3 rounded-sm border border-danger-edge bg-danger-soft text-sm leading-relaxed text-ink">
            <AlertTriangle aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-danger" />
            <p>{warning}</p>
          </div>
        )}

        {details}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) onConfirm();
          }}
          className="space-y-4"
        >
          {children}
          {phrase && (
            <div>
              <label htmlFor={phrase.inputId ?? phraseId} className={LABEL_CLASS}>{phrase.label}</label>
              <input
                id={phrase.inputId ?? phraseId}
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={typed}
                disabled={pending}
                onChange={(event) => setTyped(event.target.value)}
                className={FIELD_CLASS}
              />
            </div>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2.5 pt-1">
            <button ref={cancelRef} type="button" disabled={pending} onClick={closeUnlessPending} className={CANCEL_CLASS}>
              {cancelLabel}
            </button>
            <button type="submit" disabled={!ready} aria-busy={pending} className={CONFIRM_CLASS}>
              {pending ? <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" /> : confirmIcon}
              <span>{pending ? (pendingLabel ?? confirmLabel) : confirmLabel}</span>
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
