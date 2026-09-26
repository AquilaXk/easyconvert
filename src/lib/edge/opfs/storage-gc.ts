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
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.floor(Math.random() * 1_000_000).toString(16);
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
 * Recursively sweeps and deletes expired session directories from OPFS root.
 */
export async function sweepOrphanedSessions(
  rootDir?: any,
  now: number = Date.now(),
  maxAgeMs: number = MAX_SESSION_AGE_MS
): Promise<StorageGcSweepResult> {
  let sweptCount = 0;
  let remainingCount = 0;
  const errors: string[] = [];

  let directoryHandle = rootDir;
  if (!directoryHandle && typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
    try {
      directoryHandle = await navigator.storage.getDirectory();
    } catch (err: any) {
      errors.push(`Failed to open OPFS root: ${err.message}`);
      return { sweptCount: 0, remainingCount: 0, errors };
    }
  }

  if (!directoryHandle) {
    return { sweptCount: 0, remainingCount: 0, errors };
  }

  try {
    // Traverse down to easyconvert/sessions
    let easyconvertDir: any;
    try {
      easyconvertDir = await directoryHandle.getDirectoryHandle('easyconvert', { create: false });
    } catch {
      return { sweptCount: 0, remainingCount: 0, errors: [] };
    }

    let sessionsDir: any;
    try {
      sessionsDir = await easyconvertDir.getDirectoryHandle('sessions', { create: false });
    } catch {
      return { sweptCount: 0, remainingCount: 0, errors: [] };
    }

    // Inspect entries in sessions directory
    const entries = (sessionsDir as any).values ? (sessionsDir as any).values() : (sessionsDir as any).entries();
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
  } catch (err: any) {
    errors.push(`Storage GC scan error: ${err.message}`);
  }

  return { sweptCount, remainingCount, errors };
}
