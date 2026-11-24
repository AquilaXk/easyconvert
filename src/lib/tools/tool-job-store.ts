import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { isAnonymousUserId } from '@/lib/auth/anonymous-identity';
import { isClusterRedis } from '@/lib/redis/cluster-ops';
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
  inputKeys?: string[];
  result?: StoredToolJobResult;
  error?: string;
  createdAt: number;
}

export type ToolJobStatus = ToolJobState['status'];
export type ToolJobNonTerminalStatus = 'queued' | 'running';
export type ToolJobPatch = Partial<Pick<ToolJobState, 'status' | 'progress' | 'inputKeys' | 'result' | 'error'>>;

const TOOL_JOB_TTL_SECONDS = 3600;
const TOOL_JOB_TTL_MS = TOOL_JOB_TTL_SECONDS * 1000;
const MAX_LOCAL_TOOL_JOBS = 1000;
const TERMINAL_TOOL_JOB_STATUSES: ReadonlySet<ToolJobStatus> = new Set(['completed', 'failed', 'cancelled']);
const NON_TERMINAL_TOOL_JOB_STATUSES: ReadonlySet<ToolJobStatus> = new Set(['queued', 'running']);

export const TRANSITION_TOOL_JOB_LUA_SCRIPT = `
-- KEYS[1]: tool_job:<id>
-- ARGV[1]: ttlSeconds
-- ARGV[2]: allowedStatusesJson (JSON array of expected non-terminal statuses)
-- ARGV[3]: patchJson (JSON object of allowed fields: status, progress, inputKeys, result, error)
-- Returns false when missing/corrupt, {0, raw} when terminal or status mismatch, or {1, updated} on transition.
local raw = redis.call('GET', KEYS[1])
if not raw then
  return false
end
local okDecode, current = pcall(cjson.decode, raw)
if not okDecode or type(current) ~= 'table' then
  return false
end
local status = current['status']
if status == 'cancelled' or status == 'completed' or status == 'failed' then
  return {0, raw}
end
local allowed = cjson.decode(ARGV[2])
local isAllowed = false
for _, expected in ipairs(allowed) do
  if status == expected then
    isAllowed = true
    break
  end
end
if not isAllowed then
  return {0, raw}
end
local patch = cjson.decode(ARGV[3])
for _, field in ipairs({'status', 'progress', 'inputKeys', 'result', 'error'}) do
  local val = patch[field]
  if val ~= nil then
    if val == cjson.null then
      current[field] = nil
    else
      current[field] = val
    end
  end
end
local updated = cjson.encode(current)
redis.call('SET', KEYS[1], updated, 'EX', tonumber(ARGV[1]), 'XX')
return {1, updated}
`;

const GLOBAL_STORE_SYMBOL = Symbol.for('easyconvert.toolJobStore');
const GLOBAL_ABORT_SYMBOL = Symbol.for('easyconvert.toolJobAbortControllers');
const GLOBAL_ABORT_USERS_SYMBOL = Symbol.for('easyconvert.toolJobAbortUsers');
const GLOBAL_RUNNING_SYMBOL = Symbol.for('easyconvert.toolJobRunningPromises');

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

function localAbortUserMap(): Map<string, string> {
  const g = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
  if (!g[GLOBAL_ABORT_USERS_SYMBOL]) {
    g[GLOBAL_ABORT_USERS_SYMBOL] = new Map<string, string>();
  }
  return g[GLOBAL_ABORT_USERS_SYMBOL];
}

function localRunningMap(): Map<string, { userId: string; promise: Promise<void> }> {
  const g = globalThis as unknown as Record<symbol, Map<string, { userId: string; promise: Promise<void> }> | undefined>;
  if (!g[GLOBAL_RUNNING_SYMBOL]) {
    g[GLOBAL_RUNNING_SYMBOL] = new Map<string, { userId: string; promise: Promise<void> }>();
  }
  return g[GLOBAL_RUNNING_SYMBOL];
}

export function registerLocalToolRun(jobId: string, userId: string, promise: Promise<void>): void {
  const map = localRunningMap();
  const entry = { userId, promise };
  map.set(jobId, entry);
  void promise.finally(() => {
    if (map.get(jobId) === entry) {
      map.delete(jobId);
    }
  });
}

export function registerLocalToolAbort(jobId: string, userId?: string): AbortController {
  const controller = new AbortController();
  localAbortMap().set(jobId, controller);
  if (userId) localAbortUserMap().set(jobId, userId);
  return controller;
}

export function abortLocalToolJob(jobId: string, reason = 'Tool job cancelled'): boolean {
  const controller = localAbortMap().get(jobId);
  localAbortUserMap().delete(jobId);
  if (!controller) return false;
  controller.abort(new Error(reason));
  localAbortMap().delete(jobId);
  return true;
}

export function abortLocalToolJobsOfUser(userId: string): void {
  if (!userId || isAnonymousUserId(userId)) return;
  const jobIds = new Set<string>();
  for (const [id, entry] of localStore()) {
    if (entry.userId === userId) jobIds.add(id);
  }
  for (const [id, owner] of localAbortUserMap()) {
    if (owner === userId) jobIds.add(id);
  }
  for (const [id, entry] of localRunningMap()) {
    if (entry.userId === userId) jobIds.add(id);
  }
  for (const jobId of jobIds) {
    abortLocalToolJob(jobId, 'The account was deleted');
  }
}

export async function drainLocalToolJobsOfUser(userId: string, drainMs: number): Promise<string[]> {
  if (!userId || isAnonymousUserId(userId)) return [];
  abortLocalToolJobsOfUser(userId);
  const map = localRunningMap();
  const active = [...map.entries()].filter(([, entry]) => entry.userId === userId);
  if (active.length === 0) return [];
  if (drainMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(active.map(([, entry]) => entry.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, drainMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  return [...map.entries()].filter(([, entry]) => entry.userId === userId).map(([jobId]) => jobId);
}

export function unregisterLocalToolAbort(jobId: string): void {
  localAbortMap().delete(jobId);
  localAbortUserMap().delete(jobId);
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

export function userToolJobsKey(userId: string): string {
  return `${redisKeyStore.getPrefix()}user:tool_jobs:${userId}`;
}

export async function saveToolJob(state: ToolJobState): Promise<void> {
  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    const jobKey = redisKeyOf(state.id);
    const serialized = JSON.stringify(state);
    if (!state.userId || isAnonymousUserId(state.userId)) {
      await redis.set(jobKey, serialized, 'EX', TOOL_JOB_TTL_SECONDS);
      return;
    }
    const indexKey = userToolJobsKey(state.userId);
    if (!isClusterRedis(redis) && typeof (redis as { pipeline?: unknown }).pipeline === 'function') {
      const pipeline = redis.pipeline();
      pipeline.set(jobKey, serialized, 'EX', TOOL_JOB_TTL_SECONDS);
      pipeline.sadd(indexKey, state.id);
      pipeline.expire(indexKey, TOOL_JOB_TTL_SECONDS);
      const replies = await pipeline.exec();
      if (!replies) throw new Error('Redis pipeline returned null while saving tool job');
      for (const [err] of replies) {
        if (err) throw err;
      }
      return;
    }
    await redis.set(jobKey, serialized, 'EX', TOOL_JOB_TTL_SECONDS);
    await redis.sadd(indexKey, state.id);
    await redis.expire(indexKey, TOOL_JOB_TTL_SECONDS);
    return;
  }
  const store = localStore();
  sweepLocalStore(store, Date.now());
  store.set(state.id, { ...state });
}

function normalizeToolJobState(state: ToolJobState): ToolJobState {
  if (state.inputKeys !== undefined && !Array.isArray(state.inputKeys)) {
    state.inputKeys = [];
  }
  if (state.result?.kind === 'entries' && !Array.isArray(state.result.entries)) {
    state.result = { kind: 'entries', entries: [] };
  }
  return state;
}

function applyToolJobPatch(target: ToolJobState, patch: ToolJobPatch): void {
  if (patch.status !== undefined) target.status = patch.status;
  if (patch.progress !== undefined) target.progress = patch.progress;
  if (patch.inputKeys !== undefined) target.inputKeys = [...patch.inputKeys];
  if (patch.result !== undefined) target.result = patch.result;
  if (patch.error !== undefined) target.error = patch.error;
}

interface TransitionOutcome {
  transitioned: boolean;
  state: ToolJobState | null;
}

async function transitionToolJobOutcome(
  jobId: string,
  expectedStatuses: readonly ToolJobNonTerminalStatus[],
  patch: ToolJobPatch
): Promise<TransitionOutcome> {
  const allowed = expectedStatuses.filter((status) => NON_TERMINAL_TOOL_JOB_STATUSES.has(status));
  if (allowed.length === 0) {
    return { transitioned: false, state: await getToolJob(jobId) };
  }
  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    const reply = (await redis.eval(
      TRANSITION_TOOL_JOB_LUA_SCRIPT,
      1,
      redisKeyOf(jobId),
      String(TOOL_JOB_TTL_SECONDS),
      JSON.stringify(allowed),
      JSON.stringify(patch)
    )) as [number | string, string] | null;
    if (!Array.isArray(reply)) return { transitioned: false, state: null };
    const state =
      typeof reply[1] === 'string' && reply[1] ? normalizeToolJobState(JSON.parse(reply[1]) as ToolJobState) : null;
    return { transitioned: Number(reply[0]) === 1, state };
  }
  const store = localStore();
  const existing = store.get(jobId);
  if (!existing) return { transitioned: false, state: null };
  if (Date.now() - existing.createdAt > TOOL_JOB_TTL_MS) {
    store.delete(jobId);
    return { transitioned: false, state: null };
  }
  if (TERMINAL_TOOL_JOB_STATUSES.has(existing.status) || !allowed.includes(existing.status as ToolJobNonTerminalStatus)) {
    return { transitioned: false, state: { ...existing } };
  }
  const next: ToolJobState = { ...existing };
  applyToolJobPatch(next, patch);
  store.set(jobId, next);
  return { transitioned: true, state: { ...next } };
}

export async function transitionToolJob(
  jobId: string,
  expectedStatuses: readonly ToolJobNonTerminalStatus[],
  patch: ToolJobPatch
): Promise<ToolJobState | null> {
  const outcome = await transitionToolJobOutcome(jobId, expectedStatuses, patch);
  return outcome.transitioned ? outcome.state : null;
}

export async function attachToolJobInputs(jobId: string, inputKeys: readonly string[]): Promise<boolean> {
  return (await transitionToolJob(jobId, ['queued'], { inputKeys: [...inputKeys] })) !== null;
}

export async function startToolJob(jobId: string, progress = 25): Promise<boolean> {
  return (await transitionToolJob(jobId, ['queued'], { status: 'running', progress })) !== null;
}

export async function completeToolJob(jobId: string, result: StoredToolJobResult): Promise<boolean> {
  return (await transitionToolJob(jobId, ['running'], { status: 'completed', progress: 100, result })) !== null;
}

export async function failToolJob(jobId: string, error: string): Promise<boolean> {
  return (await transitionToolJob(jobId, ['queued', 'running'], { status: 'failed', error })) !== null;
}

export async function updateExistingToolJob(state: ToolJobState): Promise<boolean> {
  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    const reply = await redis.set(redisKeyOf(state.id), JSON.stringify(state), 'EX', TOOL_JOB_TTL_SECONDS, 'XX');
    return reply === 'OK';
  }
  const store = localStore();
  const existing = store.get(state.id);
  if (!existing) return false;
  if (Date.now() - existing.createdAt > TOOL_JOB_TTL_MS) {
    store.delete(state.id);
    return false;
  }
  store.set(state.id, { ...state });
  return true;
}

export async function getToolJob(jobId: string): Promise<ToolJobState | null> {
  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    const raw = await redis.get(redisKeyOf(jobId));
    if (!raw) return null;
    return normalizeToolJobState(JSON.parse(raw) as ToolJobState);
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
  const { state } = await transitionToolJobOutcome(jobId, ['queued', 'running'], { status: 'cancelled' });
  return state;
}

export async function deleteToolJob(jobId: string): Promise<void> {
  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    const existing = await getToolJob(jobId);
    if (existing?.userId && !isAnonymousUserId(existing.userId)) {
      await redis.srem(userToolJobsKey(existing.userId), jobId);
    }
    await redis.del(redisKeyOf(jobId));
    return;
  }
  localStore().delete(jobId);
}

export function toolResultStorageKeys(result: StoredToolJobResult | undefined): string[] {
  if (!result) return [];
  if (result.kind === 'file') return result.file.key ? [result.file.key] : [];
  if (result.kind === 'entries') {
    return Array.isArray(result.entries) ? result.entries.map((entry) => entry.key).filter(Boolean) : [];
  }
  return [];
}

function collectToolJobStorageKeys(job: ToolJobState | null, into: Set<string>): void {
  if (!job) return;
  for (const key of job.inputKeys ?? []) {
    if (key) into.add(key);
  }
  for (const key of toolResultStorageKeys(job.result)) {
    into.add(key);
  }
}

export async function eraseUserToolJobs(userId: string): Promise<{ jobIds: string[]; storageKeys: string[] }> {
  if (!userId || isAnonymousUserId(userId)) {
    return { jobIds: [], storageKeys: [] };
  }
  const redis = redisKeyStore.getRedisClient();
  const hasSetSupport = redis !== null && typeof (redis as { smembers?: unknown }).smembers === 'function';
  const indexKey = userToolJobsKey(userId);
  const ids = new Set<string>();
  if (redis && hasSetSupport) {
    for (const id of await redis.smembers(indexKey)) {
      ids.add(id);
    }
  }
  for (const [id, entry] of localStore()) {
    if (entry.userId === userId) ids.add(id);
  }
  for (const [id, owner] of localAbortUserMap()) {
    if (owner === userId) ids.add(id);
  }

  const collectedKeys = new Set<string>();
  for (const jobId of ids) {
    abortLocalToolJob(jobId, 'The account was deleted');
    collectToolJobStorageKeys(await getToolJob(jobId), collectedKeys);
    if (redis && typeof (redis as { del?: unknown }).del === 'function') {
      await redis.del(redisKeyOf(jobId));
    }
    localStore().delete(jobId);
  }
  if (redis && hasSetSupport) {
    await redis.del(indexKey);
  }
  return { jobIds: [...ids], storageKeys: [...collectedKeys] };
}
