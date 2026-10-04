import path from 'node:path';
import zlib from 'node:zlib';
import type Redis from 'ioredis';
import { PDFDocument } from 'pdf-lib';
import { storageProvider as defaultStorage, type IStorageBackend } from '@/lib/storage';
import {
  convertFile,
  createZipArchive,
  createTarArchive,
  create7zArchive,
} from '@/lib/conversions';
import { getFormatByExtension } from '@/lib/registry';
import {
  type TaskNode,
  type JobGraph,
  type GraphFailurePolicy,
  normalizeGraphNodes,
  getTaskDependencies,
} from './graph';

export interface TaskExecutionState {
  id: string;
  operation: string;
  status: 'pending' | 'waiting' | 'active' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  outputs: string[];
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface GraphExecutionState {
  jobId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'partially_completed';
  policy: GraphFailurePolicy;
  ownerUserId?: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  createdAt: number;
  finishedOn?: number;
  failedReason?: string;
  tasks: Record<string, TaskExecutionState>;
  reservationId?: string;
}

export interface TaskExecutionResult {
  taskId: string;
  status: 'completed' | 'failed';
  outputKeys: string[];
  error?: string;
  executionTimeMs: number;
}

export interface IJobGraphExecutor {
  initGraph(
    jobId: string,
    graph: JobGraph,
    options?: {
      ownerUserId?: string;
      reservationId?: string;
      sourceStorageKey?: string;
      sourceFilename?: string;
    }
  ): Promise<GraphExecutionState>;

  onTaskStarted(jobId: string, taskId: string): Promise<void>;

  onTaskCompleted(
    jobId: string,
    taskId: string,
    outputKeys: string[]
  ): Promise<{ graphStatus: string; readyTasks: string[] }>;

  onTaskFailed(
    jobId: string,
    taskId: string,
    error: string
  ): Promise<{ graphStatus: string; cancelledTasks: string[]; skippedTasks: string[] }>;

  executeTask(
    jobId: string,
    task: TaskNode,
    inputArtifactKeys?: string[]
  ): Promise<TaskExecutionResult>;

  getGraphState(jobId: string): Promise<GraphExecutionState | null>;

  cancelGraph(jobId: string, reason?: string): Promise<boolean>;
}

export async function runExecutorTask(
  executor: IJobGraphExecutor,
  storage: IStorageBackend,
  jobId: string,
  task: TaskNode,
  inputArtifactKeys: string[] = []
): Promise<TaskExecutionResult> {
  const startTime = Date.now();
  await executor.onTaskStarted(jobId, task.id);

  try {
    const outputKeys = await runTaskOperation(jobId, task, inputArtifactKeys, storage);
    await executor.onTaskCompleted(jobId, task.id, outputKeys);
    return {
      taskId: task.id,
      status: 'completed',
      outputKeys,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await executor.onTaskFailed(jobId, task.id, errorMsg);
    return {
      taskId: task.id,
      status: 'failed',
      outputKeys: [],
      error: errorMsg,
      executionTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Extracts metadata from file buffer in a safe, deterministic manner.
 */
export async function extractArtifactMetadata(
  buf: Buffer,
  filename: string,
  storageKey?: string
): Promise<Record<string, unknown>> {
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();
  const formatDef = getFormatByExtension(ext);
  const metadata: Record<string, unknown> = {
    filename,
    sizeBytes: buf.length,
    format: ext,
    mimeType: formatDef?.mimeType || 'application/octet-stream',
    category: formatDef?.category || 'unknown',
    storageKey,
    timestamp: new Date().toISOString(),
  };

  if (ext === 'pdf') {
    try {
      const pdfDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
      metadata.pageCount = pdfDoc.getPageCount();
      metadata.title = pdfDoc.getTitle() || undefined;
      metadata.author = pdfDoc.getAuthor() || undefined;
    } catch {
      // ignore
    }
  } else if (ext === 'png' && buf.length >= 24) {
    metadata.width = buf.readUInt32BE(16);
    metadata.height = buf.readUInt32BE(20);
  }

  return metadata;
}

/**
 * Merges multiple PDF buffers into a single PDF buffer using pdf-lib.
 */
export async function mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
  const mergedPdf = await PDFDocument.create();
  for (const buf of buffers) {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
    for (const page of copiedPages) {
      mergedPdf.addPage(page);
    }
  }
  const mergedBytes = await mergedPdf.save();
  return Buffer.from(mergedBytes);
}

// -------------------------------------------------------------
// Lua Scripts for Cluster-Safe Atomic Dependency Tracking
// All keys share `{job}` hash tag for single-slot Redis Cluster
// -------------------------------------------------------------

const LUA_INIT_GRAPH = `
-- KEYS[1]: metaKey ({job}:{jobId}:meta)
-- KEYS[2]: tasksKey ({job}:{jobId}:tasks)
-- KEYS[3]: waitingKey (bull:{job}:waiting)
-- KEYS[4]: jobKeyPrefix (bull:{job}:job:)
-- ARGV[1]: jobId
-- ARGV[2]: policy ('fail_job' or 'continue')
-- ARGV[3]: ownerUserId
-- ARGV[4]: createdAt timestamp
-- ARGV[5]: totalTasks
-- ARGV[6]: JSON array of tasks [{ id, op, inDegree, children }]
-- ARGV[7]: reservationId

local exists = redis.call('HGET', KEYS[1], 'status')
if exists then
  return redis.error_reply('JobGraph already initialized: ' .. ARGV[1])
end

redis.call('HSET', KEYS[1],
  'jobId', ARGV[1],
  'status', 'running',
  'policy', ARGV[2],
  'ownerUserId', ARGV[3],
  'createdAt', ARGV[4],
  'totalTasks', ARGV[5],
  'completedTasks', '0',
  'failedTasks', '0',
  'reservationId', ARGV[7] or ''
)

local tasks = cjson.decode(ARGV[6])
local readyTasks = {}

for _, t in ipairs(tasks) do
  local tid = t.id
  local depKey = '{job}:' .. ARGV[1] .. ':dep:' .. tid
  local childKey = '{job}:' .. ARGV[1] .. ':children:' .. tid

  redis.call('SET', depKey, tostring(t.inDegree))
  redis.call('SET', childKey, cjson.encode(t.children or {}))

  local initialStatus = (t.inDegree == 0) and 'waiting' or 'pending'
  local taskState = {
    id = tid,
    operation = t.op,
    status = initialStatus,
    outputs = {},
    createdAt = tonumber(ARGV[4])
  }
  redis.call('HSET', KEYS[2], tid, cjson.encode(taskState))

  if t.inDegree == 0 then
    local fullJobId = ARGV[1] .. ':' .. tid
    redis.call('RPUSH', KEYS[3], fullJobId)
    table.insert(readyTasks, tid)
  end
end

return { ARGV[1], cjson.encode(readyTasks) }
`;

const LUA_TASK_STARTED = `
-- KEYS[1]: tasksKey ({job}:{jobId}:tasks)
-- ARGV[1]: taskId
-- ARGV[2]: startedAt timestamp

local rawTask = redis.call('HGET', KEYS[1], ARGV[1])
if rawTask then
  local ok, state = pcall(cjson.decode, rawTask)
  if ok and type(state) == 'table' then
    state.status = 'active'
    state.startedAt = tonumber(ARGV[2])
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
  end
end
return 1
`;

const LUA_TASK_COMPLETED = `
-- KEYS[1]: metaKey ({job}:{jobId}:meta)
-- KEYS[2]: tasksKey ({job}:{jobId}:tasks)
-- KEYS[3]: waitingKey (bull:{job}:waiting)
-- KEYS[4]: jobKeyPrefix (bull:{job}:job:)
-- ARGV[1]: jobId
-- ARGV[2]: taskId
-- ARGV[3]: outputs JSON array string
-- ARGV[4]: finishedAt timestamp

local graphStatus = redis.call('HGET', KEYS[1], 'status')
if graphStatus ~= 'running' then
  return { 0, graphStatus or 'missing', '[]' }
end

-- 1. Store outputs in {job}:{jobId}:outputs:{taskId}
local outputsKey = '{job}:' .. ARGV[1] .. ':outputs:' .. ARGV[2]
redis.call('SET', outputsKey, ARGV[3])

-- 2. Update task state
local rawTask = redis.call('HGET', KEYS[2], ARGV[2])
local taskState = {}
if rawTask then
  local ok, dec = pcall(cjson.decode, rawTask)
  if ok and type(dec) == 'table' then taskState = dec end
end
taskState.status = 'completed'
taskState.finishedAt = tonumber(ARGV[4])
taskState.outputs = cjson.decode(ARGV[3])
redis.call('HSET', KEYS[2], ARGV[2], cjson.encode(taskState))

local completedCount = redis.call('HINCRBY', KEYS[1], 'completedTasks', 1)
local totalTasks = tonumber(redis.call('HGET', KEYS[1], 'totalTasks') or '0')

-- 3. Decrement dependency counters for child tasks
local readyTasks = {}
local childKey = '{job}:' .. ARGV[1] .. ':children:' .. ARGV[2]
local rawChildren = redis.call('GET', childKey)
if rawChildren then
  local ok, children = pcall(cjson.decode, rawChildren)
  if ok and type(children) == 'table' then
    for _, childId in ipairs(children) do
      local depKey = '{job}:' .. ARGV[1] .. ':dep:' .. childId
      local remaining = redis.call('DECR', depKey)
      if remaining == 0 then
        -- Child task is ready
        local rawChild = redis.call('HGET', KEYS[2], childId)
        local childState = {}
        if rawChild then
          local ok2, dec2 = pcall(cjson.decode, rawChild)
          if ok2 and type(dec2) == 'table' then childState = dec2 end
        end
        childState.status = 'waiting'
        redis.call('HSET', KEYS[2], childId, cjson.encode(childState))

        local fullChildJobId = ARGV[1] .. ':' .. childId
        redis.call('RPUSH', KEYS[3], fullChildJobId)
        table.insert(readyTasks, childId)
      end
    end
  end
end

-- 4. Check if entire graph completed
local isComplete = false
if completedCount >= totalTasks then
  redis.call('HSET', KEYS[1], 'status', 'completed', 'finishedOn', ARGV[4])
  isComplete = true
else
  local allTasks = redis.call('HGETALL', KEYS[2])
  local allTerminal = true
  for i = 1, #allTasks, 2 do
    local ok, tState = pcall(cjson.decode, allTasks[i + 1])
    if ok and tState then
      if tState.status == 'waiting' or tState.status == 'pending' or tState.status == 'active' then
        allTerminal = false
        break
      end
    end
  end
  if allTerminal then
    redis.call('HSET', KEYS[1], 'status', 'completed', 'finishedOn', ARGV[4])
    isComplete = true
  end
end

return { 1, isComplete and 'completed' or 'running', cjson.encode(readyTasks) }
`;

const LUA_TASK_FAILED = `
-- KEYS[1]: metaKey ({job}:{jobId}:meta)
-- KEYS[2]: tasksKey ({job}:{jobId}:tasks)
-- KEYS[3]: waitingKey (bull:{job}:waiting)
-- KEYS[4]: jobKeyPrefix (bull:{job}:job:)
-- ARGV[1]: jobId
-- ARGV[2]: taskId
-- ARGV[3]: error message
-- ARGV[4]: finishedAt timestamp

local policy = redis.call('HGET', KEYS[1], 'policy') or 'fail_job'
if policy == 'fail_fast' then policy = 'fail_job' end
redis.call('HINCRBY', KEYS[1], 'failedTasks', 1)

local rawTask = redis.call('HGET', KEYS[2], ARGV[2])
local taskState = {}
if rawTask then
  local ok, dec = pcall(cjson.decode, rawTask)
  if ok and type(dec) == 'table' then taskState = dec end
end
taskState.status = 'failed'
taskState.error = ARGV[3]
taskState.finishedAt = tonumber(ARGV[4])
redis.call('HSET', KEYS[2], ARGV[2], cjson.encode(taskState))

local cancelledTasks = {}
local skippedTasks = {}

if policy == 'fail_job' then
  redis.call('HSET', KEYS[1], 'status', 'failed', 'failedReason', ARGV[3], 'finishedOn', ARGV[4])

  local allTasks = redis.call('HGETALL', KEYS[2])
  for i = 1, #allTasks, 2 do
    local tid = allTasks[i]
    local ok, tState = pcall(cjson.decode, allTasks[i + 1])
    if ok and tState and tState.status ~= 'completed' and tState.status ~= 'failed' then
      tState.status = 'cancelled'
      redis.call('HSET', KEYS[2], tid, cjson.encode(tState))
      local fullJobId = ARGV[1] .. ':' .. tid
      redis.call('LREM', KEYS[3], 0, fullJobId)
      table.insert(cancelledTasks, tid)
    end
  end

  return { 1, 'failed', cjson.encode(cancelledTasks), '[]' }
else
  -- continue policy: cascade skipped status only to transitive dependents
  local toSkip = {}
  local queue = { ARGV[2] }

  while #queue > 0 do
    local curr = table.remove(queue, 1)
    local childKey = '{job}:' .. ARGV[1] .. ':children:' .. curr
    local rawChildren = redis.call('GET', childKey)
    if rawChildren then
      local ok, children = pcall(cjson.decode, rawChildren)
      if ok and type(children) == 'table' then
        for _, ch in ipairs(children) do
          if not toSkip[ch] then
            toSkip[ch] = true
            table.insert(queue, ch)
          end
        end
      end
    end
  end

  for tid, _ in pairs(toSkip) do
    local rawChild = redis.call('HGET', KEYS[2], tid)
    local ok, cState = pcall(cjson.decode, rawChild)
    if ok and cState and cState.status ~= 'completed' and cState.status ~= 'failed' then
      cState.status = 'skipped'
      redis.call('HSET', KEYS[2], tid, cjson.encode(cState))
      local fullJobId = ARGV[1] .. ':' .. tid
      redis.call('LREM', KEYS[3], 0, fullJobId)
      table.insert(skippedTasks, tid)
    end
  end

  -- Check if all remaining tasks are in terminal states
  local allTasks = redis.call('HGETALL', KEYS[2])
  local allTerminal = true
  for i = 1, #allTasks, 2 do
    local ok, tState = pcall(cjson.decode, allTasks[i + 1])
    if ok and tState then
      if tState.status == 'waiting' or tState.status == 'pending' or tState.status == 'active' then
        allTerminal = false
        break
      end
    end
  end

  if allTerminal then
    redis.call('HSET', KEYS[1], 'status', 'completed', 'finishedOn', ARGV[4])
  end

  return { 1, allTerminal and 'completed' or 'running', '[]', cjson.encode(skippedTasks) }
end
`;

/**
 * Redis-backed atomic DAG executor.
 */
export class RedisGraphExecutor implements IJobGraphExecutor {
  private readonly redis: Redis;
  private readonly storage: IStorageBackend;

  constructor(redisClient: Redis, storage: IStorageBackend = defaultStorage) {
    this.redis = redisClient;
    this.storage = storage;
  }

  async initGraph(
    jobId: string,
    graph: JobGraph,
    options: {
      ownerUserId?: string;
      reservationId?: string;
      sourceStorageKey?: string;
      sourceFilename?: string;
    } = {}
  ): Promise<GraphExecutionState> {
    const nodes = normalizeGraphNodes(graph);
    const nodeEntries = Object.entries(nodes);
    const policy = graph.failurePolicy === 'continue' ? 'continue' : 'fail_job';
    const createdAt = Date.now();

    // Build children mapping and in-degree
    const inDegree: Record<string, number> = {};
    const children: Record<string, string[]> = {};

    for (const [id] of nodeEntries) {
      inDegree[id] = 0;
      children[id] = [];
    }

    for (const [id, node] of nodeEntries) {
      const deps = getTaskDependencies(node);
      inDegree[id] = deps.length;
      for (const depId of deps) {
        if (!children[depId]) children[depId] = [];
        children[depId].push(id);
      }
    }

    const taskSpecs = nodeEntries.map(([id, node]) => ({
      id,
      op: node.operation || node.op || 'convert',
      inDegree: inDegree[id] || 0,
      children: children[id] || [],
      targetFormat: node.targetFormat,
      options: node.options,
      storageKey: node.storageKey || (id === 'import_source' ? options.sourceStorageKey : undefined),
      url: node.url,
    }));

    const metaKey = `{job}:${jobId}:meta`;
    const tasksKey = `{job}:${jobId}:tasks`;
    const waitingKey = `bull:{job}:waiting`;
    const jobKeyPrefix = `bull:{job}:job:`;

    const res = await this.redis.eval(
      LUA_INIT_GRAPH,
      4,
      metaKey,
      tasksKey,
      waitingKey,
      jobKeyPrefix,
      jobId,
      policy,
      options.ownerUserId || 'anonymous',
      String(createdAt),
      String(nodeEntries.length),
      JSON.stringify(taskSpecs),
      options.reservationId || ''
    );

    const readyTaskIds: string[] = JSON.parse((res as any)[1] || '[]');
    const tasksState: Record<string, TaskExecutionState> = {};

    for (const [id, node] of nodeEntries) {
      const deg = inDegree[id] || 0;
      tasksState[id] = {
        id,
        operation: node.operation || node.op || 'convert',
        status: deg === 0 ? 'waiting' : 'pending',
        outputs: [],
        startedAt: undefined,
        finishedAt: undefined,
      };
    }

    return {
      jobId,
      status: 'running',
      policy,
      ownerUserId: options.ownerUserId,
      totalTasks: nodeEntries.length,
      completedTasks: 0,
      failedTasks: 0,
      createdAt,
      tasks: tasksState,
      reservationId: options.reservationId,
    };
  }

  async onTaskStarted(jobId: string, taskId: string): Promise<void> {
    const tasksKey = `{job}:${jobId}:tasks`;
    await this.redis.eval(LUA_TASK_STARTED, 1, tasksKey, taskId, String(Date.now()));
  }

  async onTaskCompleted(
    jobId: string,
    taskId: string,
    outputKeys: string[]
  ): Promise<{ graphStatus: string; readyTasks: string[] }> {
    const metaKey = `{job}:${jobId}:meta`;
    const tasksKey = `{job}:${jobId}:tasks`;
    const waitingKey = `bull:{job}:waiting`;
    const jobKeyPrefix = `bull:{job}:job:`;

    const res = (await this.redis.eval(
      LUA_TASK_COMPLETED,
      4,
      metaKey,
      tasksKey,
      waitingKey,
      jobKeyPrefix,
      jobId,
      taskId,
      JSON.stringify(outputKeys),
      String(Date.now())
    )) as [number, string, string];

    const graphStatus = res[1] || 'running';
    const readyTasks = JSON.parse(res[2] || '[]');

    return { graphStatus, readyTasks };
  }

  async onTaskFailed(
    jobId: string,
    taskId: string,
    error: string
  ): Promise<{ graphStatus: string; cancelledTasks: string[]; skippedTasks: string[] }> {
    const metaKey = `{job}:${jobId}:meta`;
    const tasksKey = `{job}:${jobId}:tasks`;
    const waitingKey = `bull:{job}:waiting`;
    const jobKeyPrefix = `bull:{job}:job:`;

    const res = (await this.redis.eval(
      LUA_TASK_FAILED,
      4,
      metaKey,
      tasksKey,
      waitingKey,
      jobKeyPrefix,
      jobId,
      taskId,
      error,
      String(Date.now())
    )) as [number, string, string, string];

    const graphStatus = res[1] || 'failed';
    const cancelledTasks = JSON.parse(res[2] || '[]');
    const skippedTasks = JSON.parse(res[3] || '[]');

    return { graphStatus, cancelledTasks, skippedTasks };
  }

  executeTask(
    jobId: string,
    task: TaskNode,
    inputArtifactKeys: string[] = []
  ): Promise<TaskExecutionResult> {
    return runExecutorTask(this, this.storage, jobId, task, inputArtifactKeys);
  }

  async getGraphState(jobId: string): Promise<GraphExecutionState | null> {
    const metaKey = `{job}:${jobId}:meta`;
    const tasksKey = `{job}:${jobId}:tasks`;

    const [metaRaw, tasksRaw] = await Promise.all([
      this.redis.hgetall(metaKey),
      this.redis.hgetall(tasksKey),
    ]);

    if (!metaRaw || Object.keys(metaRaw).length === 0) {
      return null;
    }

    const tasksState: Record<string, TaskExecutionState> = {};
    for (const [tid, rawJson] of Object.entries(tasksRaw)) {
      try {
        tasksState[tid] = JSON.parse(rawJson);
      } catch {
        // ignore
      }
    }

    return {
      jobId,
      status: (metaRaw.status as any) || 'running',
      policy: (metaRaw.policy as any) || 'fail_job',
      ownerUserId: metaRaw.ownerUserId,
      totalTasks: Number(metaRaw.totalTasks) || Object.keys(tasksState).length,
      completedTasks: Number(metaRaw.completedTasks) || 0,
      failedTasks: Number(metaRaw.failedTasks) || 0,
      createdAt: Number(metaRaw.createdAt) || Date.now(),
      finishedOn: metaRaw.finishedOn ? Number(metaRaw.finishedOn) : undefined,
      failedReason: metaRaw.failedReason,
      tasks: tasksState,
      reservationId: metaRaw.reservationId,
    };
  }

  async cancelGraph(jobId: string, reason = 'User requested cancellation'): Promise<boolean> {
    const metaKey = `{job}:${jobId}:meta`;
    const tasksKey = `{job}:${jobId}:tasks`;
    const waitingKey = `bull:{job}:waiting`;

    const status = await this.redis.hget(metaKey, 'status');
    if (!status || status === 'completed' || status === 'failed' || status === 'cancelled') {
      return false;
    }

    await this.redis.hset(
      metaKey,
      'status',
      'cancelled',
      'failedReason',
      reason,
      'finishedOn',
      String(Date.now())
    );

    const allTasks = await this.redis.hgetall(tasksKey);
    for (const [tid, rawJson] of Object.entries(allTasks)) {
      try {
        const state: TaskExecutionState = JSON.parse(rawJson);
        if (state.status !== 'completed' && state.status !== 'failed') {
          state.status = 'cancelled';
          state.error = reason;
          await this.redis.hset(tasksKey, tid, JSON.stringify(state));
          await this.redis.lrem(waitingKey, 0, `${jobId}:${tid}`);
        }
      } catch {
        // ignore
      }
    }

    return true;
  }
}

/**
 * In-memory atomic DAG executor for zero-dependency local testing.
 */
export class InMemoryGraphExecutor implements IJobGraphExecutor {
  private readonly storage: IStorageBackend;
  private readonly states = new Map<string, GraphExecutionState>();
  private readonly taskDependencies = new Map<string, Map<string, number>>();
  private readonly taskChildren = new Map<string, Map<string, string[]>>();
  private readonly taskOutputs = new Map<string, Map<string, string[]>>();

  constructor(storage: IStorageBackend = defaultStorage) {
    this.storage = storage;
  }

  async initGraph(
    jobId: string,
    graph: JobGraph,
    options: {
      ownerUserId?: string;
      reservationId?: string;
      sourceStorageKey?: string;
      sourceFilename?: string;
    } = {}
  ): Promise<GraphExecutionState> {
    const nodes = normalizeGraphNodes(graph);
    const nodeEntries = Object.entries(nodes);
    const policy = graph.failurePolicy === 'continue' ? 'continue' : 'fail_job';
    const createdAt = Date.now();

    const inDegreeMap = new Map<string, number>();
    const childrenMap = new Map<string, string[]>();
    const outputsMap = new Map<string, string[]>();

    for (const [id] of nodeEntries) {
      inDegreeMap.set(id, 0);
      childrenMap.set(id, []);
      outputsMap.set(id, []);
    }

    for (const [id, node] of nodeEntries) {
      const deps = getTaskDependencies(node);
      inDegreeMap.set(id, deps.length);
      for (const depId of deps) {
        if (!childrenMap.has(depId)) childrenMap.set(depId, []);
        childrenMap.get(depId)!.push(id);
      }
    }

    this.taskDependencies.set(jobId, inDegreeMap);
    this.taskChildren.set(jobId, childrenMap);
    this.taskOutputs.set(jobId, outputsMap);

    const tasks: Record<string, TaskExecutionState> = {};
    for (const [id, node] of nodeEntries) {
      const deg = inDegreeMap.get(id) || 0;
      tasks[id] = {
        id,
        operation: node.operation || node.op || 'convert',
        status: deg === 0 ? 'waiting' : 'pending',
        outputs: [],
      };
    }

    const state: GraphExecutionState = {
      jobId,
      status: 'running',
      policy,
      ownerUserId: options.ownerUserId,
      totalTasks: nodeEntries.length,
      completedTasks: 0,
      failedTasks: 0,
      createdAt,
      tasks,
      reservationId: options.reservationId,
    };

    this.states.set(jobId, state);
    return state;
  }

  async onTaskStarted(jobId: string, taskId: string): Promise<void> {
    const state = this.states.get(jobId);
    if (state && state.tasks[taskId]) {
      state.tasks[taskId].status = 'active';
      state.tasks[taskId].startedAt = Date.now();
    }
  }

  async onTaskCompleted(
    jobId: string,
    taskId: string,
    outputKeys: string[]
  ): Promise<{ graphStatus: string; readyTasks: string[] }> {
    const state = this.states.get(jobId);
    if (!state || state.status !== 'running') {
      return { graphStatus: state?.status || 'missing', readyTasks: [] };
    }

    const task = state.tasks[taskId];
    if (task) {
      task.status = 'completed';
      task.outputs = outputKeys;
      task.finishedAt = Date.now();
    }

    state.completedTasks++;
    this.taskOutputs.get(jobId)?.set(taskId, outputKeys);

    const readyTasks: string[] = [];
    const children = this.taskChildren.get(jobId)?.get(taskId) || [];
    const depMap = this.taskDependencies.get(jobId);

    for (const childId of children) {
      if (depMap) {
        const remaining = (depMap.get(childId) || 1) - 1;
        depMap.set(childId, remaining);
        if (remaining === 0) {
          if (state.tasks[childId]) {
            state.tasks[childId].status = 'waiting';
          }
          readyTasks.push(childId);
        }
      }
    }

    let isComplete = state.completedTasks >= state.totalTasks;
    if (!isComplete) {
      const allTerminal = Object.values(state.tasks).every(
        (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled' || t.status === 'skipped'
      );
      if (allTerminal) {
        isComplete = true;
      }
    }

    if (isComplete) {
      state.status = 'completed';
      state.finishedOn = Date.now();
    }

    return { graphStatus: state.status, readyTasks };
  }

  async onTaskFailed(
    jobId: string,
    taskId: string,
    error: string
  ): Promise<{ graphStatus: string; cancelledTasks: string[]; skippedTasks: string[] }> {
    const state = this.states.get(jobId);
    if (!state) {
      return { graphStatus: 'missing', cancelledTasks: [], skippedTasks: [] };
    }

    const task = state.tasks[taskId];
    if (task) {
      task.status = 'failed';
      task.error = error;
      task.finishedAt = Date.now();
    }
    state.failedTasks++;

    const cancelledTasks: string[] = [];
    const skippedTasks: string[] = [];

    if (state.policy === 'fail_job') {
      state.status = 'failed';
      state.failedReason = error;
      state.finishedOn = Date.now();

      for (const [tid, tState] of Object.entries(state.tasks)) {
        if (tState.status !== 'completed' && tState.status !== 'failed') {
          tState.status = 'cancelled';
          cancelledTasks.push(tid);
        }
      }
    } else {
      // continue policy: cascade skip downstream
      const childrenMap = this.taskChildren.get(jobId);
      const toSkip = new Set<string>();
      const queue = [taskId];

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const chList = childrenMap?.get(curr) || [];
        for (const ch of chList) {
          if (!toSkip.has(ch)) {
            toSkip.add(ch);
            queue.push(ch);
          }
        }
      }

      for (const tid of toSkip) {
        const cState = state.tasks[tid];
        if (cState && cState.status !== 'completed' && cState.status !== 'failed') {
          cState.status = 'skipped';
          skippedTasks.push(tid);
        }
      }

      const allTerminal = Object.values(state.tasks).every(
        (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled' || t.status === 'skipped'
      );
      if (allTerminal) {
        state.status = 'completed';
        state.finishedOn = Date.now();
      }
    }

    return { graphStatus: state.status, cancelledTasks, skippedTasks };
  }

  executeTask(
    jobId: string,
    task: TaskNode,
    inputArtifactKeys: string[] = []
  ): Promise<TaskExecutionResult> {
    return runExecutorTask(this, this.storage, jobId, task, inputArtifactKeys);
  }

  async getGraphState(jobId: string): Promise<GraphExecutionState | null> {
    return this.states.get(jobId) || null;
  }

  async cancelGraph(jobId: string, reason = 'User requested cancellation'): Promise<boolean> {
    const state = this.states.get(jobId);
    if (!state || state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
      return false;
    }

    state.status = 'cancelled';
    state.failedReason = reason;
    state.finishedOn = Date.now();

    for (const tState of Object.values(state.tasks)) {
      if (tState.status !== 'completed' && tState.status !== 'failed') {
        tState.status = 'cancelled';
        tState.error = reason;
      }
    }

    return true;
  }
}

/**
 * Executes a single task's operation, reading from input artifacts and persisting
 * output under tasks/{jobId}/{taskId}/{filename}.
 */
export async function runTaskOperation(
  jobId: string,
  task: TaskNode,
  inputArtifactKeys: string[],
  storage: IStorageBackend
): Promise<string[]> {
  const op = task.operation || task.op || 'convert';
  const outputKeys: string[] = [];

  switch (op) {
    case 'import.upload':
    case 'import': {
      if (task.storageKey) {
        outputKeys.push(task.storageKey);
      } else {
        const dummyKey = `tasks/${jobId}/${task.id}/source.bin`;
        storage.saveObject(dummyKey, Buffer.from(''), 'application/octet-stream', 'source.bin', 86400000);
        outputKeys.push(dummyKey);
      }
      break;
    }

    case 'import.url': {
      const urlStr = task.url || '';
      const response = await fetch(urlStr, { headers: task.headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch URL ${urlStr}: HTTP ${response.status} ${response.statusText}`);
      }
      const arrayBuf = await response.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      let filename = path.basename(new URL(urlStr).pathname) || 'source.bin';
      const outKey = `tasks/${jobId}/${task.id}/${filename}`;
      const mime = response.headers.get('content-type') || 'application/octet-stream';
      storage.saveObject(outKey, buf, mime, filename, 86400000);
      outputKeys.push(outKey);
      break;
    }

    case 'convert': {
      if (inputArtifactKeys.length === 0) {
        throw new Error(`Task "${task.id}" has no input artifacts from upstream`);
      }

      for (const inputKey of inputArtifactKeys) {
        const stored = storage.getObject(inputKey);
        if (!stored) {
          throw new Error(`Input artifact "${inputKey}" not found in storage`);
        }

        const srcExt = path.extname(stored.filename || inputKey).replace(/^\./, '').toLowerCase() || 'bin';
        const targetFormat = (task.targetFormat || 'pdf').toLowerCase().replace(/^\./, '');
        const convRes = await convertFile(
          stored.buffer,
          srcExt,
          targetFormat,
          task.options || {},
          stored.filename
        );

        const outKey = `tasks/${jobId}/${task.id}/${convRes.filename}`;
        storage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, 86400000);
        outputKeys.push(outKey);
      }
      break;
    }

    case 'thumbnail': {
      if (inputArtifactKeys.length === 0) {
        throw new Error(`Thumbnail task "${task.id}" requires at least one input artifact`);
      }

      const inputKey = inputArtifactKeys[0];
      const stored = storage.getObject(inputKey);
      if (!stored) {
        throw new Error(`Input artifact "${inputKey}" not found in storage`);
      }

      const srcExt = path.extname(stored.filename || inputKey).replace(/^\./, '').toLowerCase() || 'jpg';
      const targetFormat = (task.targetFormat || (task.options?.thumbnail as any)?.format || 'jpg').toLowerCase().replace(/^\./, '');
      const width = task.options?.thumbnail?.width || task.options?.width || 256;
      const height = (task.options?.thumbnail as any)?.height || task.options?.height || 256;

      const convRes = await convertFile(
        stored.buffer,
        srcExt,
        targetFormat === 'png' ? 'png' : 'jpg',
        {
          ...(task.options || {}),
          thumbnail: undefined,
          width,
          height,
          fit: 'inside',
        },
        stored.filename
      );

      const outFilename = `thumbnail.${targetFormat}`;
      const outKey = `tasks/${jobId}/${task.id}/${outFilename}`;
      storage.saveObject(outKey, convRes.buffer, convRes.mimeType, outFilename, 86400000);
      outputKeys.push(outKey);
      break;
    }

    case 'archive/create':
    case 'archive.create':
    case 'archive': {
      if (inputArtifactKeys.length === 0) {
        throw new Error(`archive/create task "${task.id}" has no input artifacts to bundle`);
      }

      const filesToArchive: { filename: string; buffer: Buffer }[] = [];
      for (const inputKey of inputArtifactKeys) {
        const stored = storage.getObject(inputKey);
        if (!stored) {
          throw new Error(`Artifact "${inputKey}" not found in storage`);
        }
        filesToArchive.push({
          filename: stored.filename || path.basename(inputKey),
          buffer: stored.buffer,
        });
      }

      const targetFmt = (task.targetFormat || 'zip').toLowerCase().replace(/^\./, '');
      let archiveBuf: Buffer;
      let mimeType: string;

      if (targetFmt === 'zip') {
        const res = await createZipArchive(filesToArchive, task.options || {}, 'bundle.zip');
        archiveBuf = res.buffer;
        mimeType = 'application/zip';
      } else if (targetFmt === 'tar' || targetFmt === 'tar.gz') {
        const res = createTarArchive(filesToArchive, task.options || {}, 'bundle.tar');
        archiveBuf = targetFmt === 'tar.gz' ? zlib.gzipSync(res.buffer) : res.buffer;
        mimeType = targetFmt === 'tar.gz' ? 'application/gzip' : 'application/x-tar';
      } else if (targetFmt === '7z') {
        const res = create7zArchive(filesToArchive, task.options || {}, 'bundle.7z');
        archiveBuf = res.buffer;
        mimeType = 'application/x-7z-compressed';
      } else {
        const res = await createZipArchive(filesToArchive, task.options || {}, `bundle.${targetFmt}`);
        archiveBuf = res.buffer;
        mimeType = 'application/zip';
      }

      const outFilename = `bundle.${targetFmt === 'tar.gz' ? 'tar.gz' : targetFmt}`;
      const outKey = `tasks/${jobId}/${task.id}/${outFilename}`;
      storage.saveObject(outKey, archiveBuf, mimeType, outFilename, 86400000);
      outputKeys.push(outKey);
      break;
    }

    case 'merge': {
      if (inputArtifactKeys.length === 0) {
        throw new Error(`merge task "${task.id}" has no input artifacts`);
      }

      const targetFmt = (task.targetFormat || 'pdf').toLowerCase().replace(/^\./, '');
      if (targetFmt === 'pdf') {
        const pdfBuffers: Buffer[] = [];
        for (const inputKey of inputArtifactKeys) {
          const stored = storage.getObject(inputKey);
          if (stored) {
            pdfBuffers.push(stored.buffer);
          }
        }
        const mergedBuf = await mergePdfBuffers(pdfBuffers);
        const outFilename = 'merged.pdf';
        const outKey = `tasks/${jobId}/${task.id}/${outFilename}`;
        storage.saveObject(outKey, mergedBuf, 'application/pdf', outFilename, 86400000);
        outputKeys.push(outKey);
      } else {
        const textParts: string[] = [];
        for (const inputKey of inputArtifactKeys) {
          const stored = storage.getObject(inputKey);
          if (stored) {
            textParts.push(stored.buffer.toString('utf-8'));
          }
        }
        const mergedBuf = Buffer.from(textParts.join('\n\n'), 'utf-8');
        const outFilename = `merged.${targetFmt || 'txt'}`;
        const outKey = `tasks/${jobId}/${task.id}/${outFilename}`;
        storage.saveObject(outKey, mergedBuf, 'text/plain', outFilename, 86400000);
        outputKeys.push(outKey);
      }
      break;
    }

    case 'metadata': {
      if (inputArtifactKeys.length === 0) {
        throw new Error(`metadata task "${task.id}" has no input artifacts`);
      }
      const inputKey = inputArtifactKeys[0];
      const stored = storage.getObject(inputKey);
      if (!stored) {
        throw new Error(`Input artifact "${inputKey}" not found in storage`);
      }
      const meta = await extractArtifactMetadata(
        stored.buffer,
        stored.filename || path.basename(inputKey),
        inputKey
      );
      const jsonBuf = Buffer.from(JSON.stringify(meta, null, 2), 'utf-8');
      const outFilename = 'metadata.json';
      const outKey = `tasks/${jobId}/${task.id}/${outFilename}`;
      storage.saveObject(outKey, jsonBuf, 'application/json', outFilename, 86400000);
      outputKeys.push(outKey);
      break;
    }

    case 'ocr': {
      for (const inputKey of inputArtifactKeys) {
        const stored = storage.getObject(inputKey);
        if (!stored) {
          throw new Error(`Input artifact "${inputKey}" not found in storage`);
        }
        const srcExt = path.extname(stored.filename || inputKey).replace(/^\./, '').toLowerCase() || 'png';
        const convRes = await convertFile(
          stored.buffer,
          srcExt,
          'pdf',
          { ...(task.options || {}), ocrEnabled: true },
          stored.filename
        );
        const outKey = `tasks/${jobId}/${task.id}/${convRes.filename}`;
        storage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, 86400000);
        outputKeys.push(outKey);
      }
      break;
    }

    case 'optimize': {
      for (const inputKey of inputArtifactKeys) {
        const stored = storage.getObject(inputKey);
        if (!stored) {
          throw new Error(`Input artifact "${inputKey}" not found in storage`);
        }
        const srcExt = path.extname(stored.filename || inputKey).replace(/^\./, '').toLowerCase() || 'bin';
        const convRes = await convertFile(
          stored.buffer,
          srcExt,
          srcExt,
          task.options || {},
          stored.filename
        );
        const outKey = `tasks/${jobId}/${task.id}/${convRes.filename}`;
        storage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, 86400000);
        outputKeys.push(outKey);
      }
      break;
    }

    case 'export.url': {
      const urlStr = task.url || '';
      for (const inputKey of inputArtifactKeys) {
        const stored = storage.getObject(inputKey);
        if (stored) {
          await fetch(urlStr, {
            method: task.method || 'PUT',
            body: new Uint8Array(stored.buffer),
            headers: {
              'Content-Type': stored.mimeType,
              ...(task.headers || {}),
            },
          });
        }
        outputKeys.push(inputKey);
      }
      break;
    }

    case 'export.internal':
    default: {
      for (const inputKey of inputArtifactKeys) {
        const stored = storage.getObject(inputKey);
        if (stored) {
          const resKey = `results/${jobId}/${stored.filename || path.basename(inputKey)}`;
          storage.saveObject(resKey, stored.buffer, stored.mimeType, stored.filename, 86400000);
          outputKeys.push(resKey);
        } else {
          outputKeys.push(inputKey);
        }
      }
      break;
    }
  }

  return outputKeys;
}

/**
 * Factory creating appropriate executor based on Redis availability.
 */
export function createGraphExecutor(
  redisClient?: Redis | null,
  storage: IStorageBackend = defaultStorage
): IJobGraphExecutor {
  if (redisClient) {
    return new RedisGraphExecutor(redisClient, storage);
  }
  return new InMemoryGraphExecutor(storage);
}
