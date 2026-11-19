import { useEffect } from 'react';
import type { ConversionQueueItem } from './types';

const STORAGE_KEY_PREFIX = 'easyconvert:completed-results:';
const SERVER_RESULT_PREFIX = '/api/storage/file/';
const MAX_SAVED_ITEMS = 20;
const MAX_SAVED_RESULT_AGE_MS = 55 * 60 * 1000;

interface PersistedResultEntry {
  id: string;
  name: string;
  size: number;
  sourceFormat: string;
  targetFormat: string;
  resultUrl: string;
  resultSize?: number;
  unchanged?: boolean;
  savedAt: number;
}

function storageKeyOf(scope: string): string {
  return `${STORAGE_KEY_PREFIX}${scope || 'default'}`;
}

function isPersistableItem(item: ConversionQueueItem): item is ConversionQueueItem & { resultUrl: string } {
  return item.status === 'completed' && typeof item.resultUrl === 'string' && item.resultUrl.startsWith(SERVER_RESULT_PREFIX);
}

function isValidEntry(entry: unknown, now: number): entry is PersistedResultEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.name === 'string' &&
    typeof e.size === 'number' &&
    typeof e.sourceFormat === 'string' &&
    typeof e.targetFormat === 'string' &&
    typeof e.resultUrl === 'string' &&
    e.resultUrl.startsWith(SERVER_RESULT_PREFIX) &&
    typeof e.savedAt === 'number' &&
    now - e.savedAt >= 0 &&
    now - e.savedAt <= MAX_SAVED_RESULT_AGE_MS
  );
}

/** When each stored item was first saved, by id, so re-saving the queue keeps the completion time of an item that is still there. */
function storedSavedAtById(key: string): Map<string, number> {
  const savedAt = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionStorage.getItem(key) ?? '[]');
  } catch {
    return savedAt;
  }
  if (!Array.isArray(parsed)) return savedAt;
  for (const entry of parsed) {
    if (entry && typeof entry.id === 'string' && typeof entry.savedAt === 'number') savedAt.set(entry.id, entry.savedAt);
  }
  return savedAt;
}

/** Saves completed server-hosted queue items in `sessionStorage` without any conversion options or passwords. */
export function persistCompletedServerQueue(items: readonly ConversionQueueItem[], scope: string, now = Date.now()): void {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return;
  try {
    const key = storageKeyOf(scope);
    const previous = storedSavedAtById(key);
    const saved: PersistedResultEntry[] = items
      .filter(isPersistableItem)
      .slice(-MAX_SAVED_ITEMS)
      .map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        sourceFormat: item.sourceFormat,
        targetFormat: item.targetFormat,
        resultUrl: item.resultUrl,
        resultSize: item.resultSize,
        unchanged: item.unchanged,
        savedAt: previous.get(item.id) ?? now,
      }));
    if (saved.length === 0) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, JSON.stringify(saved));
  } catch {
    // Ignore private-mode or quota errors in sessionStorage
  }
}

/** Restores non-expired completed server-hosted queue items from `sessionStorage` after a reload or back-navigation. */
export function restoreCompletedServerQueue(scope: string, now = Date.now()): ConversionQueueItem[] {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined' || typeof File === 'undefined') return [];
  try {
    const key = storageKeyOf(scope);
    const raw = sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      sessionStorage.removeItem(key);
      return [];
    }
    const valid = parsed.filter((entry) => isValidEntry(entry, now)).slice(-MAX_SAVED_ITEMS);
    if (valid.length === 0) {
      sessionStorage.removeItem(key);
      return [];
    }
    if (valid.length !== parsed.length) {
      sessionStorage.setItem(key, JSON.stringify(valid));
    }
    return valid.map((entry) => ({
      id: entry.id,
      file: new File([], entry.name),
      name: entry.name,
      size: entry.size,
      sourceFormat: entry.sourceFormat,
      targetFormat: entry.targetFormat,
      status: 'completed',
      progress: 100,
      options: {},
      resultUrl: entry.resultUrl,
      resultSize: entry.resultSize,
      unchanged: entry.unchanged,
    }));
  } catch {
    return [];
  }
}

/** Prompts before accidental tab close or reload while an upload or conversion is actively running. */
export function useBeforeUnloadWhileBusy(busy: boolean): void {
  useEffect(() => {
    if (!busy || typeof window === 'undefined') return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy]);
}
