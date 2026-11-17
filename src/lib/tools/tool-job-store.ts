import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import type { WebTool } from './tool-names';

export type StoredToolJobResult =
  | { kind: 'file'; file: { name: string; size: number; url: string; key?: string } }
  | { kind: 'entries'; entries: Array<{ name: string; size: number; mimeType: string; url: string; key: string }> };

export interface ToolJobState {
  id: string;
  userId: string;
  tool: WebTool;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  result?: StoredToolJobResult;
  error?: string;
  createdAt: number;
}

const TOOL_JOB_TTL_SECONDS = 3600;
const TOOL_JOB_TTL_MS = TOOL_JOB_TTL_SECONDS * 1000;
const MAX_LOCAL_TOOL_JOBS = 1000;

const GLOBAL_STORE_SYMBOL = Symbol.for('easyconvert.toolJobStore');
const GLOBAL_ABORT_SYMBOL = Symbol.for('easyconvert.toolJobAbortControllers');

function localStore(): Map<string, ToolJobState> {
  const g = globalThis as unknown as Record<symbol, Map<string, ToolJobState> | undefined>;
  if (!g[GLOBAL_STORE_SYMBOL]) {
    g[GLOBAL_STORE_SYMBOL] = new Map<string, ToolJobState>();
  }
  return g[GLOBAL_STORE_SYMBOL];
}

function localAbortMap(): Map<string, AbortController> {
  const g = globalThis as unknown as Record<symbol, Map<string, AbortController> | undefined>;
  if (!g[GLOBAL_ABORT_SYMBOL]) {
    g[GLOBAL_ABORT_SYMBOL] = new Map<string, AbortController>();
  }
  return g[GLOBAL_ABORT_SYMBOL];
}

export function registerLocalToolAbort(jobId: string): AbortController {
  const controller = new AbortController();
  localAbortMap().set(jobId, controller);
  return controller;
}

export function abortLocalToolJob(jobId: string, reason = 'Tool job cancelled'): boolean {
  const controller = localAbortMap().get(jobId);
  if (!controller) return false;
  controller.abort(new Error(reason));
  localAbortMap().delete(jobId);
  return true;
}

export function unregisterLocalToolAbort(jobId: string): void {
  localAbortMap().delete(jobId);
}

function sweepLocalStore(store: Map<string, ToolJobState>, now: number): void {
  for (const [id, entry] of store) {
    if (now - entry.createdAt > TOOL_JOB_TTL_MS) {
      store.delete(id);
    }
  }
  while (store.size >= MAX_LOCAL_TOOL_JOBS) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}

function redisKeyOf(jobId: string): string {
  return `${redisKeyStore.getPrefix()}tool_job:${jobId}`;
}

export async function saveToolJob(state: ToolJobState): Promise<void> {
  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    await redis.set(redisKeyOf(state.id), JSON.stringify(state), 'EX', TOOL_JOB_TTL_SECONDS);
    return;
  }
  const store = localStore();
  sweepLocalStore(store, Date.now());
  store.set(state.id, { ...state });
}

export async function getToolJob(jobId: string): Promise<ToolJobState | null> {
  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    const raw = await redis.get(redisKeyOf(jobId));
    if (!raw) return null;
    return JSON.parse(raw) as ToolJobState;
  }
  const store = localStore();
  const entry = store.get(jobId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TOOL_JOB_TTL_MS) {
    store.delete(jobId);
    return null;
  }
  return { ...entry };
}

export async function cancelToolJob(jobId: string): Promise<ToolJobState | null> {
  abortLocalToolJob(jobId);
  const existing = await getToolJob(jobId);
  if (!existing) return null;
  if (existing.status === 'completed' || existing.status === 'failed') {
    return existing;
  }
  const updated: ToolJobState = { ...existing, status: 'cancelled' };
  await saveToolJob(updated);
  return updated;
}

export async function deleteToolJob(jobId: string): Promise<void> {
  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    await redis.del(redisKeyOf(jobId));
    return;
  }
  localStore().delete(jobId);
}
