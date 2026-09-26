/**
 * OPFS Storage Quota Monitor & Orphan Garbage Collector (Level 3 - L3)
 *
 * Implements:
 * 1. Storage quota estimation and high-watermark alert (85% threshold).
 * 2. Automated 2-hour orphaned session directory sweeper.
 * 3. Session path isolation (/easyconvert/sessions/${timestamp}-${uuid}/).
 */

export interface StorageQuotaInfo {
  usage: number;
  quota: number;
  percentUsed: number;
  isQuotaCritical: boolean;
}

export interface StorageGcSweepResult {
  sweptCount: number;
  remainingCount: number;
  errors: string[];
}

export const MAX_SESSION_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
export const QUOTA_CRITICAL_RATIO = 0.85; // 85% disk quota threshold
export const ROOT_SESSION_BASE_PATH = 'easyconvert/sessions';

/**
 * Creates unique, timestamped session identifier for OPFS isolation.
 */
export function createSessionId(): string {
  const timestamp = Date.now();
  let uuid: string;

  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    uuid = crypto.randomUUID();
  } else if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    uuid = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    uuid = `${timestamp.toString(16)}-session`;
  }

  return `${timestamp}-${uuid}`;
}

/**
 * Parses timestamp from session folder name.
 * Format: "${timestamp}-${uuid}".
 */
export function parseSessionTimestamp(sessionId: string): number | null {
  const parts = sessionId.split('-');
  if (parts.length < 2) return null;

  const timestamp = Number.parseInt(parts[0], 10);
  return Number.isNaN(timestamp) ? null : timestamp;
}

/**
 * Checks whether a given session is orphaned (exceeds maxAgeMs).
 */
export function isSessionOrphaned(
  sessionId: string,
  now: number = Date.now(),
  maxAgeMs: number = MAX_SESSION_AGE_MS
): boolean {
  const timestamp = parseSessionTimestamp(sessionId);
  if (timestamp === null) {
    // If not matching convention, treat as orphan to prevent permanent disk leakage
    return true;
  }
  return now - timestamp > maxAgeMs;
}

/**
 * Probes browser storage quota usage.
 */
export async function estimateStorageQuota(): Promise<StorageQuotaInfo> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return {
      usage: 0,
      quota: 0,
      percentUsed: 0,
      isQuotaCritical: false,
    };
  }

  try {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    const percentUsed = quota > 0 ? (usage / quota) * 100 : 0;
    const isQuotaCritical = quota > 0 && usage / quota >= QUOTA_CRITICAL_RATIO;

    return {
      usage,
      quota,
      percentUsed,
      isQuotaCritical,
    };
  } catch {
    return {
      usage: 0,
      quota: 0,
      percentUsed: 0,
      isQuotaCritical: false,
    };
  }
}

/**
 * Traverses to the OPFS sessions directory.
 */
async function openSessionsDirectory(rootDir?: any): Promise<any | null> {
  let directoryHandle = rootDir;
  if (!directoryHandle && typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
    try {
      directoryHandle = await navigator.storage.getDirectory();
    } catch {
      return null;
    }
  }

  if (!directoryHandle) return null;

  try {
    const easyconvertDir = await directoryHandle.getDirectoryHandle('easyconvert', { create: false });
    return await easyconvertDir.getDirectoryHandle('sessions', { create: false });
  } catch {
    return null;
  }
}

/**
 * Sweeps directory entries in the OPFS sessions folder.
 */
async function sweepDirectoryEntries(
  sessionsDir: any,
  now: number,
  maxAgeMs: number
): Promise<{ sweptCount: number; remainingCount: number; errors: string[] }> {
  let sweptCount = 0;
  let remainingCount = 0;
  const errors: string[] = [];

  const entries = typeof sessionsDir.values === 'function' ? sessionsDir.values() : sessionsDir.entries();
  for await (const entry of entries) {
    const handle = Array.isArray(entry) ? entry[1] : entry;
    const name = handle.name || (Array.isArray(entry) ? entry[0] : '');

    if (handle.kind === 'directory') {
      if (isSessionOrphaned(name, now, maxAgeMs)) {
        try {
          await sessionsDir.removeEntry(name, { recursive: true });
          sweptCount += 1;
        } catch (delErr: any) {
          errors.push(`Failed to remove session ${name}: ${delErr.message}`);
        }
      } else {
        remainingCount += 1;
      }
    }
  }

  return { sweptCount, remainingCount, errors };
}

/**
 * Recursively sweeps and deletes expired session directories from OPFS root.
 */
export async function sweepOrphanedSessions(
  rootDir?: any,
  now: number = Date.now(),
  maxAgeMs: number = MAX_SESSION_AGE_MS
): Promise<StorageGcSweepResult> {
  const sessionsDir = await openSessionsDirectory(rootDir);
  if (!sessionsDir) {
    return { sweptCount: 0, remainingCount: 0, errors: [] };
  }

  try {
    return await sweepDirectoryEntries(sessionsDir, now, maxAgeMs);
  } catch (err: any) {
    return { sweptCount: 0, remainingCount: 0, errors: [`Storage GC scan error: ${err.message}`] };
  }
}
