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
-- ARGV[10]: refusal code of the failure's error class, or ''
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
  if ARGV[10] ~= '' then
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
