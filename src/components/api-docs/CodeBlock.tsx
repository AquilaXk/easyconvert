'use client';

import { Check, Copy } from 'lucide-react';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';

/** A code sample with a copy button in its corner, as the reference documentation shows one. */
export default function CodeBlock({ code, copyLabel, copiedLabel }: Readonly<{ code: string; copyLabel: string; copiedLabel: string }>) {
  const { copiedKey, copyText } = useCopyFeedback(2000);
  const copied = copiedKey !== null;
  return (
    <div className="relative my-5">
      <pre tabIndex={0} className="font-mono text-sm leading-6 border border-rule bg-sunken px-4 py-3 pe-16 overflow-x-auto">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={() => void copyText(code)}
        aria-label={copyLabel}
        className="absolute top-1.5 end-1.5 size-11 md:top-2.5 md:end-2.5 md:size-7 inline-flex items-center justify-center rounded-xs bg-canvas text-ink-2 hover:bg-surface hover:text-ink transition-colors cursor-pointer"
      >
        {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      </button>
      <output aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ''}
      </output>
    </div>
  );
}
