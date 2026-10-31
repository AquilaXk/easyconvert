'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export async function writeClipboardText(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface CopyFeedbackState {
  copiedKey: string | null;
  copyText: (text: string, key?: string) => Promise<boolean>;
}

export function useCopyFeedback(resetMs = 2000): CopyFeedbackState {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPendingTimer();
    };
  }, [clearPendingTimer]);

  const copyText = useCallback(
    async (text: string, key = 'default'): Promise<boolean> => {
      const ok = await writeClipboardText(text);
      if (!ok || !mountedRef.current) return false;
      clearPendingTimer();
      setCopiedKey(key);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopiedKey(null);
      }, resetMs);
      return true;
    },
    [clearPendingTimer, resetMs]
  );

  return { copiedKey, copyText };
}
