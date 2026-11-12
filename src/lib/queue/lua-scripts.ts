/**
 * Atomic Lua scripts for the job hashes and state sets of a Redis queue (src/lib/queue/bullmq-engine.ts). Each script takes
 * its keys in KEYS and its values in ARGV, as the comment at its top lists them.
 */

export const ADD_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: waitingKey (ZSET)
-- KEYS[3]: delayedKey (ZSET)
-- KEYS[4]: userJobsKey (ZSET, or placeholder if none)
-- ARGV[1]: jobId
-- ARGV[2]: isDelayed ('1' or '0')
-- ARGV[3]: delayUntil timestamp in ms
-- ARGV[4]: priorityScore (score for waiting ZSET)
-- ARGV[5]: timestamp in ms (score for userJobsKey)
-- ARGV[6]: userId (empty string if none)
-- ARGV[7]: eventsChannel ({queue}:events)
-- ARGV[8]: jobEventsChannel ({queue}:job:{id}:events)
-- ARGV[9..N]: flat key-value pairs for HSET

if redis.call('EXISTS', KEYS[1]) == 1 then
  return { 0, redis.call('HGETALL', KEYS[1]) }
end

for i = 9, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end

if ARGV[2] == '1' then
  redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[1])
else
  local t = redis.call('TYPE', KEYS[2])
  local typeName = (type(t) == 'table' and t.ok) or t
  if typeName == 'list' then
    local items = redis.call('LRANGE', KEYS[2], 0, -1)
    redis.call('DEL', KEYS[2])
    for idx, itemId in ipairs(items) do
      redis.call('ZADD', KEYS[2], 1000000000000000 + idx, itemId)
    end
  end
  redis.call('ZADD', KEYS[2], tonumber(ARGV[4]), ARGV[1])
  local waitingPayload = cjson.encode({ event = 'waiting', jobId = ARGV[1] })
  redis.call('PUBLISH', ARGV[7], waitingPayload)
  redis.call('PUBLISH', ARGV[8], waitingPayload)
end

if ARGV[6] ~= '' and KEYS[4] ~= '' then
  redis.call('ZADD', KEYS[4], tonumber(ARGV[5]), ARGV[1])
end

return { 1 }
`;

export const PROMOTE_DELAYED_JOBS_LUA_SCRIPT = `
-- KEYS[1]: delayedKey
-- KEYS[2]: waitingKey
-- KEYS[3]: jobPrefix (e.g. prefix:job:)
-- ARGV[1]: current timestamp in milliseconds
-- ARGV[2]: max batch size
-- ARGV[3]: eventsChannel (optional)
local due = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1], 'LIMIT', 0, tonumber(ARGV[2] or 50))
local promoted = {}

local t = redis.call('TYPE', KEYS[2])
local typeName = (type(t) == 'table' and t.ok) or t
if typeName == 'list' then
  local items = redis.call('LRANGE', KEYS[2], 0, -1)
  redis.call('DEL', KEYS[2])
  for _, itemId in ipairs(items) do
    local rawOpts = redis.call('HGET', KEYS[3] .. itemId, 'opts')
    local prioRank = 1000
    if rawOpts and rawOpts ~= '' then
      local ok, opts = pcall(cjson.decode, rawOpts)
      if ok and type(opts) == 'table' and tonumber(opts.priority) and tonumber(opts.priority) > 0 then
        prioRank = tonumber(opts.priority)
      end
    end
    local rawTs = redis.call('HGET', KEYS[3] .. itemId, 'timestamp')
    local ts = tonumber(rawTs) or tonumber(ARGV[1])
    local score = prioRank * 1000000000000 + (ts % 1000000000000)
    redis.call('ZADD', KEYS[2], score, itemId)
  end
end

if due and #due > 0 then
  for i, id in ipairs(due) do
    if redis.call('ZREM', KEYS[1], id) > 0 then
      local rawOpts = redis.call('HGET', KEYS[3] .. id, 'opts')
      local prioRank = 1000
      if rawOpts and rawOpts ~= '' then
        local ok, opts = pcall(cjson.decode, rawOpts)
        if ok and type(opts) == 'table' and tonumber(opts.priority) and tonumber(opts.priority) > 0 then
          prioRank = tonumber(opts.priority)
        end
      end
      local score = prioRank * 1000000000000 + (tonumber(ARGV[1]) % 1000000000000)
      redis.call('ZADD', KEYS[2], score, id)
      redis.call('HSET', KEYS[3] .. id, 'state', 'waiting')
      table.insert(promoted, id)
      if ARGV[3] and ARGV[3] ~= '' then
        local waitingPayload = cjson.encode({ event = 'waiting', jobId = id })
        redis.call('PUBLISH', ARGV[3], waitingPayload)
      end
    end
  end
end
return #promoted
`;

export const POP_NEXT_WAITING_JOB_LUA_SCRIPT = `
-- KEYS[1]: waitingKey
-- KEYS[2]: activeKey
-- KEYS[3]: job key prefix (e.g. prefix:{queue}:job:)
-- KEYS[4]: heartbeat key prefix (e.g. prefix:{queue}:heartbeat:)
-- ARGV[1]: processedOn timestamp in milliseconds
-- ARGV[2]: heartbeat TTL in milliseconds
-- ARGV[3]: attempt token of the new attempt

-- Auto-migrate waitingKey from list to zset if needed
local t = redis.call('TYPE', KEYS[1])
local typeName = (type(t) == 'table' and t.ok) or t
if typeName == 'list' then
  local items = redis.call('LRANGE', KEYS[1], 0, -1)
  redis.call('DEL', KEYS[1])
  for _, itemId in ipairs(items) do
    local rawOpts = redis.call('HGET', KEYS[3] .. itemId, 'opts')
    local prioRank = 1000
    if rawOpts and rawOpts ~= '' then
      local ok, opts = pcall(cjson.decode, rawOpts)
      if ok and type(opts) == 'table' and tonumber(opts.priority) and tonumber(opts.priority) > 0 then
        prioRank = tonumber(opts.priority)
      end
    end
    local rawTs = redis.call('HGET', KEYS[3] .. itemId, 'timestamp')
    local ts = tonumber(rawTs) or tonumber(ARGV[1])
    local score = prioRank * 1000000000000 + (ts % 1000000000000)
    redis.call('ZADD', KEYS[1], score, itemId)
  end
end

while true do
  local popped = redis.call('ZPOPMIN', KEYS[1])
  if not popped or #popped == 0 then
    return false
  end
  local jobId = popped[1]
  local jobKey = KEYS[3] .. jobId
  if redis.call('HGET', jobKey, 'state') == 'waiting' then
    redis.call('SADD', KEYS[2], jobId)
    redis.call('HSET', jobKey, 'state', 'active', 'processedOn', ARGV[1], 'attemptToken', ARGV[3])
    redis.call('SET', KEYS[4] .. jobId, ARGV[1], 'PX', ARGV[2])
    return redis.call('HGETALL', jobKey)
  end
end
`;

export const CANCEL_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: waitingKey
-- KEYS[3]: delayedKey
-- KEYS[4]: activeKey
-- KEYS[5]: cancelledKey
-- KEYS[6]: heartbeat key
-- ARGV[1]: job id
-- ARGV[2]: cancellation reason
-- ARGV[3]: finishedOn timestamp in milliseconds
-- ARGV[4]: log line to append
-- Returns 0 unless the job is waiting, delayed, or active; otherwise { previousState, job hash }.
local state = redis.call('HGET', KEYS[1], 'state')
if state ~= 'waiting' and state ~= 'delayed' and state ~= 'active' then
  return 0
end
local t = redis.call('TYPE', KEYS[2])
local typeName = (type(t) == 'table' and t.ok) or t
if typeName == 'list' then
  redis.call('LREM', KEYS[2], 0, ARGV[1])
else
  redis.call('ZREM', KEYS[2], ARGV[1])
end
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('SREM', KEYS[4], ARGV[1])
redis.call('DEL', KEYS[6])
redis.call('SADD', KEYS[5], ARGV[1])
local logs = {}
local rawLogs = redis.call('HGET', KEYS[1], 'logs')
if rawLogs and rawLogs ~= '' then
  local ok, decoded = pcall(cjson.decode, rawLogs)
  if ok and type(decoded) == 'table' then
    logs = decoded
  end
end
table.insert(logs, ARGV[4])
redis.call('HSET', KEYS[1], 'state', 'cancelled', 'failedReason', ARGV[2], 'finishedOn', ARGV[3], 'logs', cjson.encode(logs))
return { state, redis.call('HGETALL', KEYS[1]) }
`;

export const REQUEUE_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: activeKey
-- KEYS[3]: waitingKey
-- KEYS[4]: delayedKey
-- KEYS[5]: heartbeat key
-- ARGV[1]: job id
-- ARGV[2]: attemptsMade
-- ARGV[3]: failedReason of the attempt
-- ARGV[4]: retry delay in milliseconds
-- ARGV[5]: current timestamp in milliseconds
-- ARGV[6]: attempt token of the caller
-- ARGV[7]: priorityScore (score for waiting ZSET)
-- Returns 1 after moving the job from active to waiting/delayed, or 0 when it is no longer active
-- or another attempt owns it.
if redis.call('HGET', KEYS[1], 'state') ~= 'active' or redis.call('HGET', KEYS[1], 'attemptToken') ~= ARGV[6] then
  return 0
end
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[5])
local delayMs = tonumber(ARGV[4])
if delayMs > 0 then
  redis.call('ZADD', KEYS[4], tonumber(ARGV[5]) + delayMs, ARGV[1])
  redis.call('HSET', KEYS[1], 'state', 'delayed', 'attemptsMade', ARGV[2], 'failedReason', ARGV[3])
else
  local t = redis.call('TYPE', KEYS[3])
  local typeName = (type(t) == 'table' and t.ok) or t
  if typeName == 'list' then
    local items = redis.call('LRANGE', KEYS[3], 0, -1)
    redis.call('DEL', KEYS[3])
    for idx, itemId in ipairs(items) do
      redis.call('ZADD', KEYS[3], 1000000000000000 + idx, itemId)
    end
  end
  local score = tonumber(ARGV[7]) or 1000000000000000
  redis.call('ZADD', KEYS[3], score, ARGV[1])
  redis.call('HSET', KEYS[1], 'state', 'waiting', 'attemptsMade', ARGV[2], 'failedReason', ARGV[3])
end
return 1
`;

export const CLAIM_DEADLINE_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- ARGV[1]: candidate deadline (absolute time in milliseconds)
-- Records the deadline on an existing job hash only if none is recorded, and returns the recorded one. A job hash
-- that does not exist is never created (HSETNX alone would write a hash holding only this field): returns -1.
if redis.call('EXISTS', KEYS[1]) == 0 then
  return -1
end
redis.call('HSETNX', KEYS[1], 'deadlineAt', ARGV[1])
return redis.call('HGET', KEYS[1], 'deadlineAt')
`;

export const COMPLETE_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: activeKey
-- KEYS[3]: completedKey
-- KEYS[4]: heartbeat key
-- ARGV[1]: job id
-- ARGV[2]: finishedOn timestamp in milliseconds
-- ARGV[3]: JSON return value ('' when undefined)
-- ARGV[4]: attemptsMade
-- ARGV[5]: '1' to delete the job hash (removeOnComplete)
-- ARGV[6]: attempt token of the caller
-- Returns 1 after moving the job from active to completed, or 0 when it is no longer active
-- or another attempt owns it. A retry by the attempt that already completed the job also
-- returns 1, so a commit whose reply was lost is not reported as refused.
local state = redis.call('HGET', KEYS[1], 'state')
local ownsAttempt = redis.call('HGET', KEYS[1], 'attemptToken') == ARGV[6]
if state == 'completed' and ownsAttempt then
  return 1
end
if state ~= 'active' or not ownsAttempt then
  return 0
end
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[4])
if ARGV[5] == '1' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SADD', KEYS[3], ARGV[1])
  redis.call('HSET', KEYS[1], 'state', 'completed', 'finishedOn', ARGV[2], 'progress', '100', 'returnvalue', ARGV[3], 'attemptsMade', ARGV[4])
end
return 1
`;

export const FAIL_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: activeKey
-- KEYS[3]: failedKey
-- KEYS[4]: heartbeat key
-- ARGV[1]: job id
-- ARGV[2]: finishedOn timestamp in milliseconds
-- ARGV[3]: failedReason
-- ARGV[4]: JSON stacktrace
-- ARGV[5]: attemptsMade
-- ARGV[6]: '1' to delete the job hash (removeOnFail)
-- ARGV[7]: attempt token of the caller
-- ARGV[8]: error class of a typed failure, or '' for an untyped one
-- ARGV[9]: HTTP status of a typed failure, or ''
-- ARGV[10]: refusal code of the failure's error class, or '' (absent from a caller older than the field)
-- Returns 1 after moving the job from active to failed, or 0 when it is no longer active
-- or another attempt owns it.
if redis.call('HGET', KEYS[1], 'state') ~= 'active' or redis.call('HGET', KEYS[1], 'attemptToken') ~= ARGV[7] then
  return 0
end
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[4])
if ARGV[6] == '1' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SADD', KEYS[3], ARGV[1])
  local fields = { 'state', 'failed', 'finishedOn', ARGV[2], 'failedReason', ARGV[3], 'stacktrace', ARGV[4], 'attemptsMade', ARGV[5] }
  if ARGV[8] ~= '' then
    table.insert(fields, 'failedCode')
    table.insert(fields, ARGV[8])
    table.insert(fields, 'failedStatus')
    table.insert(fields, ARGV[9])
  end
  if ARGV[10] and ARGV[10] ~= '' then
    table.insert(fields, 'failedRefusalCode')
    table.insert(fields, ARGV[10])
  end
  redis.call('HSET', KEYS[1], unpack(fields))
end
return 1
`;

export const REFRESH_HEARTBEAT_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: heartbeat key
-- ARGV[1]: current timestamp in milliseconds
-- ARGV[2]: heartbeat TTL in milliseconds
-- ARGV[3]: attempt token of the caller
-- Returns { 'refreshed', '' } after refreshing the heartbeat of the caller's own active attempt,
-- { 'cancelled', failedReason } when the job was cancelled, or { 'lost', state } when the caller
-- no longer owns the job. Only the owning attempt refreshes the heartbeat.
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'cancelled' then
  return { 'cancelled', redis.call('HGET', KEYS[1], 'failedReason') or '' }
end
if state ~= 'active' or redis.call('HGET', KEYS[1], 'attemptToken') ~= ARGV[3] then
  return { 'lost', state or '' }
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
return { 'refreshed', '' }
`;

export const UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- ARGV[1]: attempt token of the caller
-- ARGV[2]: progress
-- ARGV[3]: JSON logs
-- Returns 1 after writing progress and logs for the owning active attempt, or 0 otherwise.
if redis.call('HGET', KEYS[1], 'state') ~= 'active' or redis.call('HGET', KEYS[1], 'attemptToken') ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'progress', ARGV[2], 'logs', ARGV[3])
return 1
`;

export const RECOVER_STALLED_JOBS_LUA_SCRIPT = `
-- KEYS[1]: activeKey
-- KEYS[2]: waitingKey
-- KEYS[3]: failedKey
-- KEYS[4]: job key prefix (e.g. prefix:{queue}:job:)
-- KEYS[5]: heartbeat key prefix (e.g. prefix:{queue}:heartbeat:)
-- ARGV[1]: current timestamp in milliseconds
-- ARGV[2]: stalled failure reason
-- Active jobs without a live heartbeat lost their worker. The stalled attempt counts as made:
-- the job returns to waiting while attempts remain, otherwise it fails.
-- Returns { requeued ids, failed ids }.
local requeued = {}
local failed = {}

local t = redis.call('TYPE', KEYS[2])
local typeName = (type(t) == 'table' and t.ok) or t
if typeName == 'list' then
  local items = redis.call('LRANGE', KEYS[2], 0, -1)
  redis.call('DEL', KEYS[2])
  for _, itemId in ipairs(items) do
    redis.call('ZADD', KEYS[2], 1000000000000000, itemId)
  end
end

local activeIds = redis.call('SMEMBERS', KEYS[1])
for _, jobId in ipairs(activeIds) do
  if redis.call('EXISTS', KEYS[5] .. jobId) == 0 then
    local jobKey = KEYS[4] .. jobId
    redis.call('SREM', KEYS[1], jobId)
    if redis.call('HGET', jobKey, 'state') == 'active' then
      local attemptsMade = (tonumber(redis.call('HGET', jobKey, 'attemptsMade')) or 0) + 1
      local maxAttempts = 1
      local rawOpts = redis.call('HGET', jobKey, 'opts')
      local prioRank = 1000
      if rawOpts then
        local ok, opts = pcall(cjson.decode, rawOpts)
        if ok and type(opts) == 'table' then
          if tonumber(opts.attempts) and tonumber(opts.attempts) > 0 then
            maxAttempts = tonumber(opts.attempts)
          end
          if tonumber(opts.priority) and tonumber(opts.priority) > 0 then
            prioRank = tonumber(opts.priority)
          end
        end
      end
      -- The stalled attempt loses ownership: clearing its token fences any write it still tries.
      redis.call('HDEL', jobKey, 'attemptToken')
      if attemptsMade < maxAttempts then
        redis.call('HSET', jobKey, 'state', 'waiting', 'attemptsMade', attemptsMade, 'failedReason', ARGV[2])
        local rawTs = redis.call('HGET', jobKey, 'timestamp')
        local ts = tonumber(rawTs) or tonumber(ARGV[1])
        local score = prioRank * 1000000000000 + (ts % 1000000000000)
        redis.call('ZADD', KEYS[2], score, jobId)
        table.insert(requeued, jobId)
      else
        redis.call('HSET', jobKey, 'state', 'failed', 'attemptsMade', attemptsMade, 'failedReason', ARGV[2], 'finishedOn', ARGV[1])
        redis.call('SADD', KEYS[3], jobId)
        table.insert(failed, jobId)
      end
    end
  end
end
return { requeued, failed }
`;

/**
 * Lua functions that keep the dead letters, shared by the scripts that add a letter or take one out (BullMQ shares its removal steps the
 * same way: `includes/removeJob.lua` and `includes/removeJobKeys.lua` are included in the scripts that remove jobs). A letter is a hash
 * of its own, as BullMQ keeps a job (`<key>:letter:<id>`: `raw`, and `job` and `user` when something can look it up), under an id from a
 * counter (`<key>:seq`, written zero-padded so letters of one millisecond keep their order), in a sorted set scored by the time of the
 * letter (`<key>:order`, as BullMQ's completed and failed sets are scored by finish time), and in a set of ids per job
 * (`<key>:by-job:<jobId>`) and per user (`<key>:by-user:<userId>`). Removing a letter by id is `DEL`, `ZREM` and two `SREM`s. The job
 * and the user of a letter come from the process (`dead-letters.ts` reads them with the same parser as the erasure), so no script
 * decodes a letter and a letter that Lua's `cjson` cannot read (a lone surrogate escape, nesting past a thousand levels) is indexed
 * like any other. The list `<key>` itself is the store of the letters written before this layout: a script reads it only while it holds
 * letters, and the migration empties it.
 */
const DEAD_LETTER_LUA_FUNCTIONS = `
local function letterKey(base, id)
  return base .. ':letter:' .. id
end

-- Stores a letter. A letter with neither a job id nor a user has nothing to look it up by and is only in the order set. A letter that
-- names a user but no job is indexed under the empty job id, as the erasure found it before.
local function addLetter(base, raw, timestamp, jobId, userId)
  local id = string.format('%016d', redis.call('INCR', base .. ':seq'))
  local key = letterKey(base, id)
  if jobId == '' and userId == '' then
    redis.call('HSET', key, 'raw', raw)
  else
    redis.call('HSET', key, 'raw', raw, 'job', jobId)
    redis.call('SADD', base .. ':by-job:' .. jobId, id)
    if userId ~= '' then
      redis.call('HSET', key, 'user', userId)
      redis.call('SADD', base .. ':by-user:' .. userId, id)
    end
  end
  redis.call('ZADD', base .. ':order', timestamp, id)
end

-- Takes a letter out of its hash, the order set and the sets of its job and user (a hash that is gone leaves only the order entry).
local function removeLetter(base, id)
  local key = letterKey(base, id)
  local owners = redis.call('HMGET', key, 'job', 'user')
  redis.call('DEL', key)
  redis.call('ZREM', base .. ':order', id)
  if owners[1] then
    redis.call('SREM', base .. ':by-job:' .. owners[1], id)
    if owners[2] then
      redis.call('SREM', base .. ':by-user:' .. owners[2], id)
    end
  end
end

-- Removes every letter of a job, and the set of the job with them (an id of a lost hash goes with it).
local function removeLettersOfJob(base, jobId)
  local setKey = base .. ':by-job:' .. jobId
  for _, id in ipairs(redis.call('SMEMBERS', setKey)) do
    removeLetter(base, id)
  end
  redis.call('DEL', setKey)
end

-- Removes the letters of a job that are still in the list of the earlier layout. Nothing to read when the list is empty, which is all that the migration leaves.
local function removeListedLettersOfJob(base, jobId)
  if redis.call('LLEN', base) == 0 then
    return
  end
  for _, raw in ipairs(redis.call('LRANGE', base, 0, -1)) do
    local ok, letter = pcall(cjson.decode, raw)
    if ok and type(letter) == 'table' and letter.jobId == jobId then
      redis.call('LREM', base, 0, raw)
    end
  end
end
`;

/** Stores a dead letter in one step. */
export const ADD_DEAD_LETTER_LUA_SCRIPT = `
-- KEYS[1]: dead-letter key (the list of the earlier layout; the other keys are derived from it)
-- ARGV[1]: the letter, as JSON
-- ARGV[2]: the time of the letter, in milliseconds
-- ARGV[3]: the job id of the letter ('' when it has none)
-- ARGV[4]: the user id of the letter ('' when it has none)
${DEAD_LETTER_LUA_FUNCTIONS}
addLetter(KEYS[1], ARGV[1], ARGV[2], ARGV[3], ARGV[4])
return 1
`;

/** Removes every dead letter, of both layouts, in one step, so a letter added meanwhile is never lost uncounted; answers how many it removed. */
export const PURGE_DEAD_LETTERS_LUA_SCRIPT = `
-- KEYS[1]: dead-letter key
${DEAD_LETTER_LUA_FUNCTIONS}
local count = redis.call('LLEN', KEYS[1])
redis.call('DEL', KEYS[1])
for _, id in ipairs(redis.call('ZRANGE', KEYS[1] .. ':order', 0, -1)) do
  removeLetter(KEYS[1], id)
  count = count + 1
end
redis.call('DEL', KEYS[1] .. ':seq')
return count
`;

/** Removes the letters with the ids in ARGV, and answers how many it was given. A damaged index (an id whose hash is gone) leaves the order set too. */
export const REMOVE_DEAD_LETTERS_LUA_SCRIPT = `
-- KEYS[1]: dead-letter key
-- ARGV[1..N]: letter ids
${DEAD_LETTER_LUA_FUNCTIONS}
for _, id in ipairs(ARGV) do
  removeLetter(KEYS[1], id)
end
return #ARGV
`;

/** Removes every letter of the jobs in ARGV, in one step per call, so a letter added to a job meanwhile is removed or kept whole. */
export const REMOVE_JOB_DEAD_LETTERS_LUA_SCRIPT = `
-- KEYS[1]: dead-letter key
-- ARGV[1..N]: job ids
${DEAD_LETTER_LUA_FUNCTIONS}
for _, jobId in ipairs(ARGV) do
  removeLettersOfJob(KEYS[1], jobId)
end
return #ARGV
`;

/**
 * Moves a batch of letters from the list of the earlier layout to the new one, one step per batch. Each letter leaves the list with
 * `LREM` and is stored in the same step, so a letter another process removes between the read of the batch and this step is not stored
 * again, and one that is moved is never in both. Answers how many it moved.
 */
export const MIGRATE_DEAD_LETTERS_LUA_SCRIPT = `
-- KEYS[1]: dead-letter key (the list is the source)
-- ARGV: groups of four: the letter, its time in milliseconds, its job id and its user id ('' for none), as ADD_DEAD_LETTER_LUA_SCRIPT takes them
${DEAD_LETTER_LUA_FUNCTIONS}
local moved = 0
for at = 1, #ARGV, 4 do
  if redis.call('LREM', KEYS[1], 1, ARGV[at]) == 1 then
    addLetter(KEYS[1], ARGV[at], ARGV[at + 1], ARGV[at + 2], ARGV[at + 3])
    moved = moved + 1
  end
end
return moved
`;

/** Gives an ended job the data it keeps (`removeDataOnFinish`), checking inside the step that the job is still there and ended. */
export const REPLACE_ENDED_JOB_DATA_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- ARGV[1]: JSON data the ended job keeps
-- Returns 1 after replacing the data, or 0 when the job is gone or has not ended, so no hash is ever created here.
local state = redis.call('HGET', KEYS[1], 'state')
if state ~= 'completed' and state ~= 'failed' and state ~= 'cancelled' then
  return 0
end
redis.call('HSET', KEYS[1], 'data', ARGV[1])
return 1
`;

/**
 * Removes up to ARGV[2] dead letters recorded at or before a time, with their index, and answers how many it removed (a caller that got
 * the limit asks again, so one step never holds Redis for long). The sorted set is read by score, as BullMQ's cleanJobsInSet reads a
 * state set by finish time; the list of the earlier layout is trimmed from its head as it was.
 */
export const TRIM_DEAD_LETTERS_LUA_SCRIPT = `
-- KEYS[1]: dead-letter key
-- ARGV[1]: time in milliseconds
-- ARGV[2]: the most letters to remove in this step
-- A letter of the list that is not readable counts as the oldest.
${DEAD_LETTER_LUA_FUNCTIONS}
local cutoff = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local removed = 0
for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1] .. ':order', '-inf', ARGV[1], 'LIMIT', 0, limit)) do
  removeLetter(KEYS[1], id)
  removed = removed + 1
end
while removed < limit do
  local head = redis.call('LINDEX', KEYS[1], 0)
  if not head then
    return removed
  end
  local ok, letter = pcall(cjson.decode, head)
  local recordedAt = 0
  if ok and type(letter) == 'table' then
    recordedAt = tonumber(letter.timestamp) or 0
  end
  if recordedAt > cutoff then
    return removed
  end
  redis.call('LPOP', KEYS[1])
  removed = removed + 1
end
return removed
`;

/**
 * Removes a job that is not active from every state it can be in, as BullMQ's removeJob-2.lua does, and with the dead-letter key
 * (KEYS[9]) the letters of the job.
 */
export const REMOVE_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2..7]: waiting, delayed, active, completed, failed and cancelled keys
-- KEYS[8]: the index of the job's user (a placeholder key when it has none)
-- KEYS[9]: dead-letter key (optional)
-- ARGV[1]: job id
-- Returns 1 after removing the job, 0 when it is active (its attempt is still running) or unknown.
${DEAD_LETTER_LUA_FUNCTIONS}
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'active' then
  return 0
end
if KEYS[9] and KEYS[9] ~= '' then
  removeLettersOfJob(KEYS[9], ARGV[1])
  removeListedLettersOfJob(KEYS[9], ARGV[1])
end
if not state then
  return 0
end
local t = redis.call('TYPE', KEYS[2])
local typeName = (type(t) == 'table' and t.ok) or t
if typeName == 'list' then
  redis.call('LREM', KEYS[2], 0, ARGV[1])
else
  redis.call('ZREM', KEYS[2], ARGV[1])
end
redis.call('ZREM', KEYS[3], ARGV[1])
for i = 4, 7 do
  redis.call('SREM', KEYS[i], ARGV[1])
end
redis.call('ZREM', KEYS[8], ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`;
