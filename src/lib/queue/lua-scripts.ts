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
 * Lua functions that keep the index of the dead-letter list, shared by the scripts that add a letter to the list or take one out
 * (BullMQ shares its removal steps the same way: `includes/removeJob.lua` and `includes/removeJobKeys.lua` are included in the scripts
 * that remove jobs). The index is a set of the raw letters of each job (`jobPrefix .. jobId`) and a set of the ids of the jobs of each
 * user that have a letter (`userPrefix .. userId`), as BullMQ keeps the keys of a job beside its hash and removes them with it. A
 * letter that has neither a job id nor a user is not indexed: nothing can look it up. A letter whose job id is missing, with a user, is
A letter that Lua's `cjson` cannot decode but
 * `JSON.parse` can (a lone surrogate escape, which `JSON.stringify` writes; nesting past a thousand levels) cannot be looked up by job or
 * user here, so its raw text goes into one set per queue (`unparsed`), which the removals in the process read and parse themselves.
 */
const DEAD_LETTER_INDEX_LUA_FUNCTIONS = `
-- Answers the job id and the user id of a letter (nil when nothing can look it up), and true as the third value when it cannot be decoded.
local function deadLetterOwners(raw)
  local ok, letter = pcall(cjson.decode, raw)
  if not ok then
    return nil, nil, true
  end
  if type(letter) ~= 'table' then
    return nil, nil, false
  end
  local jobId = ''
  if type(letter.jobId) == 'string' then
    jobId = letter.jobId
  end
  local userId = nil
  if type(letter.data) == 'table' and type(letter.data.userId) == 'string' and letter.data.userId ~= '' then
    userId = letter.data.userId
  end
  if jobId == '' and not userId then
    return nil, nil, false
  end
  return jobId, userId, false
end

local function indexDeadLetter(jobPrefix, userPrefix, unparsedKey, raw)
  local jobId, userId, undecodable = deadLetterOwners(raw)
  if undecodable then
    redis.call('SADD', unparsedKey, raw)
  elseif jobId then
    redis.call('SADD', jobPrefix .. jobId, raw)
    if userId then
      redis.call('SADD', userPrefix .. userId, jobId)
    end
  end
end

-- The id leaves the set of the user when no other letter of the job names that user (a set that loses its last member is deleted by Redis).
local function unindexDeadLetter(jobPrefix, userPrefix, unparsedKey, raw)
  local jobId, userId, undecodable = deadLetterOwners(raw)
  if undecodable then
    redis.call('SREM', unparsedKey, raw)
  elseif jobId then
    local jobKey = jobPrefix .. jobId
    redis.call('SREM', jobKey, raw)
    if userId then
      for _, other in ipairs(redis.call('SMEMBERS', jobKey)) do
        local _, otherUserId = deadLetterOwners(other)
        if otherUserId == userId then
          return
        end
      end
      redis.call('SREM', userPrefix .. userId, jobId)
    end
  end
end
`;

/** Appends a dead letter and indexes it in one step. It never sets the flag that says the index covers the list: only the backfill does. */
export const ADD_DEAD_LETTER_LUA_SCRIPT = `
-- KEYS[1]: dead-letter list
-- KEYS[2]: prefix of the keys of the letter sets of a job
-- KEYS[3]: prefix of the keys of the job sets of a user
-- KEYS[4]: set of the letters that cannot be decoded here
-- ARGV[1]: the letter, as JSON
${DEAD_LETTER_INDEX_LUA_FUNCTIONS}
redis.call('RPUSH', KEYS[1], ARGV[1])
indexDeadLetter(KEYS[2], KEYS[3], KEYS[4], ARGV[1])
return 1
`;

/** Empties the dead-letter list and its index and answers how many entries it held, in one step, so an entry added meanwhile is never lost uncounted. */
export const PURGE_DEAD_LETTERS_LUA_SCRIPT = `
-- KEYS[1]: dead-letter list
-- KEYS[2], KEYS[3], KEYS[4]: prefixes of the job sets and the user sets, and the set of undecodable letters, as in ADD_DEAD_LETTER_LUA_SCRIPT
-- The flag that says the index covers the list is left as it is: an empty list does not show that no older build still writes letters.
${DEAD_LETTER_INDEX_LUA_FUNCTIONS}
local count = redis.call('LLEN', KEYS[1])
for _, raw in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
  unindexDeadLetter(KEYS[2], KEYS[3], KEYS[4], raw)
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[4])
return count
`;

/**
 * Removes the letters in ARGV from the list and the index, as one step with the index. Answers how many entries it took out of the list.
 */
export const REMOVE_DEAD_LETTERS_LUA_SCRIPT = `
-- KEYS[1]: dead-letter list
-- KEYS[2], KEYS[3], KEYS[4]: prefixes of the job sets and the user sets, and the set of undecodable letters, as in ADD_DEAD_LETTER_LUA_SCRIPT
-- ARGV[1..N]: the letters to remove, as they are stored; a letter that is not in the list only leaves the index
${DEAD_LETTER_INDEX_LUA_FUNCTIONS}
local removed = 0
for _, raw in ipairs(ARGV) do
  removed = removed + redis.call('LREM', KEYS[1], 0, raw)
  unindexDeadLetter(KEYS[2], KEYS[3], KEYS[4], raw)
end
return removed
`;

/**
 * Indexes every letter of the list and sets the flag, in one step: a letter added or removed meanwhile cannot be missed, which is what
 * lets the flag say that the index covers the whole list. This is the only step that sets the flag. Answers { letters, indexed, covered,
 * unparsed }; when the flag is set already it changes nothing and answers covered 1. The step reads the list once, so it holds Redis for
 * the time of a read of the list.
 */
export const BACKFILL_DEAD_LETTER_INDEX_LUA_SCRIPT = `
-- KEYS[1]: dead-letter list
-- KEYS[2], KEYS[3], KEYS[4]: prefixes of the job sets and the user sets, and the set of undecodable letters, as in ADD_DEAD_LETTER_LUA_SCRIPT
-- KEYS[5]: flag that the index covers every letter of the list
-- ARGV[1]: '1' to write, '0' to only count (the answer is the same; nothing is written)
${DEAD_LETTER_INDEX_LUA_FUNCTIONS}
local letters = redis.call('LLEN', KEYS[1])
if redis.call('EXISTS', KEYS[5]) == 1 then
  return { letters, 0, 1, 0 }
end
local indexed = 0
local unparsed = 0
for _, raw in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
  local jobId, _, undecodable = deadLetterOwners(raw)
  if undecodable then
    unparsed = unparsed + 1
  elseif jobId then
    indexed = indexed + 1
  end
  if ARGV[1] == '1' then
    indexDeadLetter(KEYS[2], KEYS[3], KEYS[4], raw)
  end
end
if ARGV[1] == '1' then
  redis.call('SET', KEYS[5], '1')
end
return { letters, indexed, 0, unparsed }
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

/** Removes the dead letters recorded at or before a time, with their index. Letters are appended as jobs fail, so the oldest are at the head. */
export const TRIM_DEAD_LETTERS_LUA_SCRIPT = `
-- KEYS[1]: dead-letter list, oldest first
-- KEYS[2], KEYS[3], KEYS[4]: prefixes of the job sets and the user sets, and the set of undecodable letters, as in ADD_DEAD_LETTER_LUA_SCRIPT
-- ARGV[1]: time in milliseconds
-- A letter that is not readable counts as the oldest. Returns how many letters were removed.
${DEAD_LETTER_INDEX_LUA_FUNCTIONS}
local cutoff = tonumber(ARGV[1])
local removed = 0
while true do
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
  unindexDeadLetter(KEYS[2], KEYS[3], KEYS[4], head)
  removed = removed + 1
end
`;

/**
 * Removes a job that is not active from every state it can be in, as BullMQ's removeJob-2.lua does, and with the dead-letter keys
 * (KEYS[9..12]) the letters of the job from the list and the index.
 */
export const REMOVE_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2..7]: waiting, delayed, active, completed, failed and cancelled keys
-- KEYS[8]: the index of the job's user (a placeholder key when it has none)
-- KEYS[9]: dead-letter list (optional)
-- KEYS[10], KEYS[11], KEYS[12]: with KEYS[9], the prefixes of the job sets and the user sets and the set of undecodable letters, as in ADD_DEAD_LETTER_LUA_SCRIPT
-- KEYS[13]: with KEYS[9], the flag that the index covers every letter of the list
-- ARGV[1]: job id
-- ARGV[2..N]: letters of the job that cannot be decoded here, which the caller found in the set of undecodable letters
-- Returns 1 after removing the job, 0 when it is active (its attempt is still running) or unknown.
${DEAD_LETTER_INDEX_LUA_FUNCTIONS}
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'active' then
  return 0
end
if KEYS[9] and KEYS[9] ~= '' then
  for _, raw in ipairs(redis.call('SMEMBERS', KEYS[10] .. ARGV[1])) do
    redis.call('LREM', KEYS[9], 0, raw)
    unindexDeadLetter(KEYS[10], KEYS[11], KEYS[12], raw)
  end
  for i = 2, #ARGV do
    redis.call('LREM', KEYS[9], 0, ARGV[i])
    unindexDeadLetter(KEYS[10], KEYS[11], KEYS[12], ARGV[i])
  end
  -- Until the index covers the whole list, a letter written before it is found by reading the list.
  if redis.call('EXISTS', KEYS[13]) == 0 then
    for _, raw in ipairs(redis.call('LRANGE', KEYS[9], 0, -1)) do
      local ok, letter = pcall(cjson.decode, raw)
      if ok and type(letter) == 'table' and letter.jobId == ARGV[1] then
        redis.call('LREM', KEYS[9], 0, raw)
        unindexDeadLetter(KEYS[10], KEYS[11], KEYS[12], raw)
      end
    end
  end
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
