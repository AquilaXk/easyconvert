import type Redis from 'ioredis';

export const ALL_JOB_STATES = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] as const;

const USER_JOBS_MARKER = ':user_jobs:';

/** Derives `{queuePrefix}:by_state:{userId}:{state}` from `{queuePrefix}:user_jobs:{userId}` so every secondary index hashes to the same Redis Cluster slot. */
export function userByStateKey(userJobsKey: string, state: string): string {
  const at = userJobsKey.lastIndexOf(USER_JOBS_MARKER);
  if (at < 0) return `${userJobsKey}:by_state:${state}`;
  return `${userJobsKey.slice(0, at)}:by_state:${userJobsKey.slice(at + USER_JOBS_MARKER.length)}:${state}`;
}

export function userByStateKeys(userJobsKey: string, states: readonly string[] = ALL_JOB_STATES): string[] {
  return states.map((state) => userByStateKey(userJobsKey, state));
}

const USER_INDEX_LUA_HELPERS = `
local ALL_STATES = { 'waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled' }

local function parseUserIndex(indexKey)
  local prefix, uid = string.match(indexKey, '^(.*):user_jobs:(.*)$')
  if prefix and uid then return prefix, uid end
  prefix, uid = string.match(indexKey, '^(.*):by_state:(.*):[^:]+$')
  if prefix and uid then return prefix, uid end
  return nil, nil
end

local function removeStaleId(indexKey, id)
  redis.call('ZREM', indexKey, id)
  local prefix, uid = parseUserIndex(indexKey)
  if prefix and uid then
    redis.call('ZREM', prefix .. ':user_jobs:' .. uid, id)
    for _, st in ipairs(ALL_STATES) do
      redis.call('ZREM', prefix .. ':by_state:' .. uid .. ':' .. st, id)
    end
  end
end

local function isGraphNodeJob(jobKey, id, skipGraphNodes)
  if not skipGraphNodes or not string.find(id, ':', 1, true) then
    return false
  end
  local data = redis.call('HGET', jobKey, 'data')
  return data ~= false and string.find(data, '"graphId":"', 1, true) ~= nil
end

local function canUseByStateIndex(userJobsKey, jobKeyPrefix, prefix, uid, userTotal, wanted)
  if not prefix or not uid then return false, 0 end
  local byStateTotal = 0
  local wantedTotal = 0
  for _, st in ipairs(ALL_STATES) do
    local c = redis.call('ZCARD', prefix .. ':by_state:' .. uid .. ':' .. st)
    byStateTotal = byStateTotal + c
    if wanted[st] then
      wantedTotal = wantedTotal + c
    end
  end
  if byStateTotal < userTotal then
    return false, wantedTotal
  end
  -- Detect fixtures/tools that mutate hash state via direct HSET/HDEL without updating by_state.
  local sample = redis.call('ZREVRANGE', userJobsKey, 0, 7)
  for _, id in ipairs(sample) do
    local st = redis.call('HGET', jobKeyPrefix .. id, 'state') or 'waiting'
    if not redis.call('ZSCORE', prefix .. ':by_state:' .. uid .. ':' .. st, id) then
      return false, wantedTotal
    end
  end
  return true, wantedTotal
end
`;

/**
 * The job hashes of a window of a user's job ids, only of the jobs in one of the states given after the ids (all of them when no
 * state is given), so a job of another state costs one `HGET` and no transfer. An id whose job is gone leaves both the main user
 * index and its `by_state` sets atomically.
 * KEYS[1]: the user's job index (`user_jobs` or `by_state`)  KEYS[2]: job key prefix (e.g. prefix:{queue}:job:)
 * ARGV[1]: how many ids follow  ARGV[2]: '1' to skip the node jobs of graphs  then the ids  then the states wanted.
 * Returns the flat hashes of the jobs wanted, in the order of the ids.
 */
export const LIST_USER_JOBS_LUA_SCRIPT = `
${USER_INDEX_LUA_HELPERS}
local count = tonumber(ARGV[1])
local skipGraphNodes = ARGV[2] == '1'
local wanted = {}
local filtered = #ARGV > count + 2
for i = count + 3, #ARGV do wanted[ARGV[i]] = true end
local jobs = {}
for i = 3, count + 2 do
  local id = ARGV[i]
  local key = KEYS[2] .. id
  local state = redis.call('HGET', key, 'state')
  if not state and redis.call('EXISTS', key) == 0 then
    removeStaleId(KEYS[1], id)
  elseif not filtered or wanted[state or 'waiting'] then
    if not isGraphNodeJob(key, id, skipGraphNodes) then
      jobs[#jobs + 1] = redis.call('HGETALL', key)
    end
  end
end
return jobs
`;

/**
 * Cursor-based k-way descending read across `{queue}:by_state:{userId}:{state}` ZSETs, with automatic fallback to `user_jobs`
 * for pre-migration keys or tests that mutate job hash states directly.
 * KEYS[1]: user_jobs:<uid>  KEYS[2]: job key prefix
 * ARGV[1]: '1' to skip graph node jobs  ARGV[2]: targetCount  ARGV[3]: K wanted states  ARGV[4..3+K]: wanted state names
 * ARGV[4+K]: userCursor (0-based rank)  ARGV[5+K..4+2*K]: stateCursors[1..K] (0-based ranks)
 * Returns: { 'done'|'more', flats, newUserCursor, ...newStateCursors }
 */
export const LIST_USER_JOBS_BY_STATE_LUA_SCRIPT = `
${USER_INDEX_LUA_HELPERS}
local skipGraphNodes = ARGV[1] == '1'
local targetCount = tonumber(ARGV[2]) or 50
local stateCount = tonumber(ARGV[3]) or 0
local wanted = {}
local wantedStates = {}
for i = 1, stateCount do
  local st = ARGV[3 + i]
  wanted[st] = true
  wantedStates[i] = st
end
local userCursor = tonumber(ARGV[4 + stateCount]) or 0
local stateCursors = {}
for i = 1, stateCount do
  stateCursors[i] = tonumber(ARGV[4 + stateCount + i]) or 0
end

local function packResult(status, jobs)
  local res = { status, jobs, userCursor }
  for i = 1, stateCount do res[#res + 1] = stateCursors[i] end
  return res
end

local userTotal = redis.call('ZCARD', KEYS[1])
if userTotal == 0 or stateCount == 0 or targetCount <= 0 then
  return packResult('done', {})
end

local prefix, uid = string.match(KEYS[1], '^(.*):user_jobs:(.*)$')
local useByState, wantedTotal = canUseByStateIndex(KEYS[1], KEYS[2], prefix, uid, userTotal, wanted)
local jobs = {}
local BATCH = 64

if useByState then
  if wantedTotal == 0 then
    return packResult('done', {})
  end
  local stateKeys = {}
  local heads = {}
  local pos = {}
  local exhausted = {}
  for i = 1, stateCount do
    stateKeys[i] = prefix .. ':by_state:' .. uid .. ':' .. wantedStates[i]
    heads[i] = {}
    pos[i] = 1
    exhausted[i] = false
  end

  local function ensureHead(i)
    if pos[i] <= #heads[i] then return true end
    if exhausted[i] then return false end
    local raw = redis.call('ZREVRANGE', stateKeys[i], stateCursors[i], stateCursors[i] + BATCH - 1, 'WITHSCORES')
    heads[i] = {}
    pos[i] = 1
    if #raw == 0 then
      exhausted[i] = true
      return false
    end
    for r = 1, #raw, 2 do
      heads[i][#heads[i] + 1] = { id = raw[r], score = tonumber(raw[r + 1]) }
    end
    if (#raw / 2) < BATCH then
      -- Tail of ZSET fit in this buffer; exhausted flips only once pos[i] passes #heads[i].
      heads[i].isTail = true
    end
    return true
  end

  local function peek(i)
    if not ensureHead(i) then return nil end
    return heads[i][pos[i]]
  end

  local seen = {}
  while #jobs < targetCount do
    local bestIdx = nil
    local bestCand = nil
    for i = 1, stateCount do
      local cand = peek(i)
      if cand then
        if not bestCand or cand.score > bestCand.score or (cand.score == bestCand.score and cand.id > bestCand.id) then
          bestIdx = i
          bestCand = cand
        end
      end
    end
    if not bestIdx then break end

    local wasTail = heads[bestIdx].isTail
    pos[bestIdx] = pos[bestIdx] + 1
    if wasTail and pos[bestIdx] > #heads[bestIdx] then exhausted[bestIdx] = true end

    local id = bestCand.id
    local key = KEYS[2] .. id
    local state = redis.call('HGET', key, 'state')
    if not state and redis.call('EXISTS', key) == 0 then
      removeStaleId(stateKeys[bestIdx], id)
    else
      stateCursors[bestIdx] = stateCursors[bestIdx] + 1
      if not seen[id] and wanted[state or 'waiting'] and not isGraphNodeJob(key, id, skipGraphNodes) then
        seen[id] = true
        jobs[#jobs + 1] = redis.call('HGETALL', key)
      end
    end
  end

  local hasMore = false
  for i = 1, stateCount do
    if peek(i) then
      hasMore = true
      break
    end
  end
  return packResult(hasMore and 'more' or 'done', jobs)
end

-- Fallback: scan user_jobs index chunk-by-chunk until targetCount matched jobs or end of ZSET.
local reachedEnd = false
while #jobs < targetCount do
  local chunk = redis.call('ZREVRANGE', KEYS[1], userCursor, userCursor + BATCH - 1)
  if #chunk == 0 then
    reachedEnd = true
    break
  end
  for _, id in ipairs(chunk) do
    local key = KEYS[2] .. id
    local state = redis.call('HGET', key, 'state')
    if not state and redis.call('EXISTS', key) == 0 then
      removeStaleId(KEYS[1], id)
    else
      userCursor = userCursor + 1
      if wanted[state or 'waiting'] and not isGraphNodeJob(key, id, skipGraphNodes) then
        jobs[#jobs + 1] = redis.call('HGETALL', key)
        if #jobs >= targetCount then break end
      end
    end
  end
  if #jobs >= targetCount then break end
  if #chunk < BATCH then
    reachedEnd = true
    break
  end
end

local hasMore = not reachedEnd and (#redis.call('ZREVRANGE', KEYS[1], userCursor, userCursor) > 0)
return packResult(hasMore and 'more' or 'done', jobs)
`;

/**
 * Counts a user's jobs in the given states up to `cap` without transferring or parsing full job hashes (`HGETALL`).
 * KEYS[1]: user_jobs:<uid>  KEYS[2]: job key prefix
 * ARGV[1]: '1' to skip graph node jobs  ARGV[2]: cap (stop counting once reached)  ARGV[3..N]: optional wanted state names
 */
export const COUNT_USER_JOBS_LUA_SCRIPT = `
${USER_INDEX_LUA_HELPERS}
local skipGraphNodes = ARGV[1] == '1'
local cap = tonumber(ARGV[2]) or 100
if cap <= 0 then return 0 end

local userTotal = redis.call('ZCARD', KEYS[1])
if userTotal == 0 then return 0 end

local filtered = #ARGV > 2
local wanted = {}
local wantedStates = {}
if filtered then
  for i = 3, #ARGV do
    local st = ARGV[i]
    if not wanted[st] then
      wanted[st] = true
      wantedStates[#wantedStates + 1] = st
    end
  end
else
  for i, st in ipairs(ALL_STATES) do
    wanted[st] = true
    wantedStates[i] = st
  end
end

local seen = {}
local matched = 0
local BATCH = 64

local function countFromKey(zkey, verifyState)
  local cursor = 0
  while matched < cap do
    local chunk = redis.call('ZREVRANGE', zkey, cursor, cursor + BATCH - 1)
    if #chunk == 0 then break end
    for _, id in ipairs(chunk) do
      local key = KEYS[2] .. id
      local state = redis.call('HGET', key, 'state')
      if not state and redis.call('EXISTS', key) == 0 then
        removeStaleId(zkey, id)
      else
        cursor = cursor + 1
        local effective = state or 'waiting'
        if (not verifyState or wanted[effective]) and not seen[id] and not isGraphNodeJob(key, id, skipGraphNodes) then
          seen[id] = true
          matched = matched + 1
          if matched >= cap then return end
        end
      end
    end
    if #chunk < BATCH then break end
  end
end

local prefix, uid = string.match(KEYS[1], '^(.*):user_jobs:(.*)$')
if filtered and prefix and uid then
  local useByState, wantedTotal = canUseByStateIndex(KEYS[1], KEYS[2], prefix, uid, userTotal, wanted)
  if useByState then
    if wantedTotal == 0 then return 0 end
    for _, st in ipairs(wantedStates) do
      if matched >= cap then break end
      local bkey = prefix .. ':by_state:' .. uid .. ':' .. st
      if redis.call('ZCARD', bkey) > 0 then
        countFromKey(bkey, true)
      end
    end
    return matched
  end
end

countFromKey(KEYS[1], filtered)
return matched
`;

/** Ids the first window holds at least, the most a window holds, and how many times larger each window is than the one before. */
const MIN_WINDOW = 50;
const MAX_WINDOW = 500;
const WINDOW_GROWTH = 4;

export interface UserJobListOptions<J> {
  /** The user's job index (a sorted set of job ids by creation time). */
  indexKey: string;
  /** Key of a job hash without its id. */
  jobKeyPrefix: string;
  states?: readonly string[];
  limit: number;
  offset: number;
  /** Builds a job from a flat HGETALL reply. */
  toJob: (flat: string[]) => J;
  /** Leaves out the node jobs of graphs (those `exclude` rejects), before the offset and the limit apply. */
  excludeGraphNodes?: boolean;
  /** Whether a job is left out of the list; the exact test, where the script only saves the transfer of the jobs it can tell. */
  exclude?: (job: J) => boolean;
}

export interface UserJobCountOptions {
  indexKey: string;
  jobKeyPrefix: string;
  states?: readonly string[];
  cap: number;
  excludeGraphNodes?: boolean;
}

function normalizeStates(states?: readonly string[]): {
  filtered: boolean;
  known: string[];
  unknownOnly: boolean;
} {
  if (!states || states.length === 0) {
    return { filtered: false, known: [], unknownOnly: false };
  }
  const knownSet = new Set<string>(ALL_JOB_STATES);
  const deduped = [...new Set(states)];
  const known = deduped.filter((s) => knownSet.has(s));
  return {
    filtered: true,
    known,
    unknownOnly: known.length === 0,
  };
}

async function readZsetWindowed<J>(
  redis: Redis,
  zsetKey: string,
  firstChunk: string[],
  initialWindow: number,
  options: UserJobListOptions<J>,
  filterStates: readonly string[]
): Promise<J[]> {
  const wanted = Math.max(0, options.offset + options.limit);
  const matched: J[] = [];
  const seen = new Set<string>();
  let window = initialWindow;
  let cursor = 0;
  let rawChunk = firstChunk;

  for (;;) {
    if (rawChunk.length === 0) break;
    const chunk: string[] = [];
    for (const id of rawChunk) {
      if (!seen.has(id)) {
        seen.add(id);
        chunk.push(id);
      }
    }

    let flatsCount = 0;
    if (chunk.length > 0) {
      const flats = (await redis.eval(
        LIST_USER_JOBS_LUA_SCRIPT,
        2,
        zsetKey,
        options.jobKeyPrefix,
        String(chunk.length),
        options.excludeGraphNodes ? '1' : '0',
        ...chunk,
        ...filterStates
      )) as string[][];
      flatsCount = flats.length;
      for (const flat of flats) {
        const job = options.toJob(flat);
        if (!options.exclude?.(job)) matched.push(job);
      }
    }

    if (matched.length >= wanted || rawChunk.length < window) break;

    if (chunk.length === 0 || flatsCount === chunk.length) {
      cursor += rawChunk.length;
    } else if (typeof (redis as { zrevrank?: unknown }).zrevrank === 'function') {
      const lastRank = await redis.zrevrank(zsetKey, rawChunk[rawChunk.length - 1]);
      if (typeof lastRank === 'number') {
        cursor = lastRank + 1;
      }
    } else {
      cursor += rawChunk.length;
    }

    window = Math.min(MAX_WINDOW, window * WINDOW_GROWTH);
    rawChunk = await redis.zrevrange(zsetKey, cursor, cursor + window - 1);
  }
  return matched.slice(options.offset, wanted);
}

async function readViaByStateOrFallback<J>(
  redis: Redis,
  options: UserJobListOptions<J>,
  states: readonly string[]
): Promise<J[]> {
  const wanted = Math.max(0, options.offset + options.limit);
  const matched: J[] = [];
  let userCursor = 0;
  let stateCursors = states.map(() => 0);
  let targetCount = Math.min(
    MAX_WINDOW,
    options.exclude ? Math.max(MIN_WINDOW, wanted) : Math.max(1, wanted)
  );

  while (matched.length < wanted) {
    const reply = (await redis.eval(
      LIST_USER_JOBS_BY_STATE_LUA_SCRIPT,
      2,
      options.indexKey,
      options.jobKeyPrefix,
      options.excludeGraphNodes ? '1' : '0',
      String(targetCount),
      String(states.length),
      ...states,
      String(userCursor),
      ...stateCursors.map(String)
    )) as [string, string[][], number, ...number[]];

    const [status, flats, nextUserCursor, ...nextStateCursors] = reply;
    userCursor = Number(nextUserCursor) || 0;
    stateCursors = nextStateCursors.map((n) => Number(n) || 0);

    for (const flat of flats) {
      const job = options.toJob(flat);
      if (!options.exclude?.(job)) matched.push(job);
    }
    if (status === 'done') break;
    targetCount = Math.min(MAX_WINDOW, targetCount * WINDOW_GROWTH);
  }
  return matched.slice(options.offset, wanted);
}

/**
 * The jobs of a user in the given states, newest first, from `offset` for `limit` jobs. When filtering by state(s), uses the
 * per-state secondary index (`{queue}:by_state:{userId}:{state}`) with automatic fallback to the full user index for legacy data.
 */
export async function readUserJobs<J>(redis: Redis, options: UserJobListOptions<J>): Promise<J[]> {
  if (options.limit <= 0) return [];
  const { filtered, known, unknownOnly } = normalizeStates(options.states);
  if (unknownOnly) return [];

  const wanted = Math.max(0, options.offset + options.limit);
  const initialWindow = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, wanted));

  if (!filtered || known.length >= ALL_JOB_STATES.length) {
    const firstChunk = await redis.zrevrange(options.indexKey, 0, initialWindow - 1);
    return readZsetWindowed(redis, options.indexKey, firstChunk, initialWindow, options, []);
  }

  if (known.length === 1) {
    const byStateKey = userByStateKey(options.indexKey, known[0]);
    const firstChunk = await redis.zrevrange(byStateKey, 0, initialWindow - 1);
    if (firstChunk.length > 0) {
      return readZsetWindowed(redis, byStateKey, firstChunk, initialWindow, options, known);
    }
    return readViaByStateOrFallback(redis, options, known);
  }

  return readViaByStateOrFallback(redis, options, known);
}

/**
 * Counts jobs belonging to a user (optionally filtered by states and excluding graph node jobs) up to `options.cap`
 * without `HGETALL` transfer or JSON payload parsing.
 */
export async function countUserJobs(redis: Redis, options: UserJobCountOptions): Promise<number> {
  if (options.cap <= 0) return 0;
  const { filtered, known, unknownOnly } = normalizeStates(options.states);
  if (unknownOnly) return 0;

  const statesArg = filtered && known.length < ALL_JOB_STATES.length ? known : [];
  const raw = await redis.eval(
    COUNT_USER_JOBS_LUA_SCRIPT,
    2,
    options.indexKey,
    options.jobKeyPrefix,
    options.excludeGraphNodes ? '1' : '0',
    String(options.cap),
    ...statesArg
  );
  return Math.max(0, Number(raw) || 0);
}
