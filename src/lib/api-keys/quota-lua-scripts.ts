/**
 * The Lua scripts of the quota store (redis-key-store.ts): each one reads and changes the keys of one owner in one step,
 * so concurrent requests never pass the daily limit together.
 */
export const RESERVE_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: usage key (e.g. easyconvert:usage:{userId}:YYYY-MM-DD)
-- KEYS[2]: reservation key (e.g. easyconvert:res:{userId}:reservationId)
-- ARGV[1]: units requested
-- ARGV[2]: max daily limit
-- ARGV[3]: seconds until the day of the usage key ends (midnight UTC); the reservation lives as long, so it can be
--          given back for as long as the count it was charged to exists
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local units = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

if current + units <= limit then
  redis.call('INCRBY', KEYS[1], units)
  if current == 0 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  end
  redis.call('SET', KEYS[2], units, 'EX', tonumber(ARGV[3]))
  return {1, limit - (current + units)}
else
  return {0, limit - current}
end
`;

/**
 * Gives the reserved units back once. A reservation that is gone (committed, settled, rolled back, or its day over)
 * changes nothing, and a count that is gone (its day over) is not made again.
 */
export const ROLLBACK_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: usage key
-- KEYS[2]: reservation key
local units = tonumber(redis.call('GET', KEYS[2]) or '0')
if units <= 0 then
  return 0
end
redis.call('DEL', KEYS[2])
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('DECRBY', KEYS[1], units)
end
return 1
`;

export const COMMIT_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: reservation key
return redis.call('DEL', KEYS[1])
`;

/** Charges the units a request used in place of those it reserved, once, under the same rules as the rollback. */
export const SETTLE_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: usage key (e.g. easyconvert:usage:{userId}:YYYY-MM-DD)
-- KEYS[2]: reservation key (e.g. easyconvert:res:{userId}:reservationId)
-- ARGV[1]: actual units consumed
local reserved = redis.call('GET', KEYS[2])
if not reserved then
  return {0, 0}
end
local diff = tonumber(ARGV[1]) - tonumber(reserved)
redis.call('DEL', KEYS[2])
if diff ~= 0 and redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('INCRBY', KEYS[1], diff)
end
return {1, diff}
`;

export const DEDUCT_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: usage key (e.g. easyconvert:usage:userId:YYYY-MM-DD)
-- ARGV[1]: units requested
-- ARGV[2]: max daily limit
-- ARGV[3]: usage key TTL in seconds (until midnight UTC)
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local units = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

if current + units <= limit then
  redis.call('INCRBY', KEYS[1], units)
  if current == 0 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  end
  return {1, limit - (current + units)}
else
  return {0, limit - current}
end
`;

export const TOKEN_BUCKET_RATE_LIMIT_LUA_SCRIPT = `
-- KEYS[1]: rate limit key (e.g. easyconvert:rate:keyId)
-- ARGV[1]: bucket capacity (max burst tokens)
-- ARGV[2]: refill rate (tokens added per second)
-- ARGV[3]: cost (tokens required for this request)
-- ARGV[4]: key TTL in seconds
-- ARGV[5]: fallback timestamp in milliseconds (if TIME fails in mock environments)
local now = nil
local ok, rtime = pcall(redis.call, 'TIME')
if ok and rtime and type(rtime) == 'table' then
  now = (tonumber(rtime[1]) * 1000) + math.floor(tonumber(rtime[2]) / 1000)
else
  now = tonumber(ARGV[5] or '0')
end

local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3] or '1')
local ttl = tonumber(ARGV[4] or '3600')

local data = redis.call('HMGET', KEYS[1], 'tokens', 'lastRefill')
local currentTokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if not currentTokens or not lastRefill then
  currentTokens = capacity
  lastRefill = now
else
  local elapsed = math.max(0, now - lastRefill)
  local replenished = 0
  if refillRate > 0 then
    replenished = (elapsed / 1000.0) * refillRate
  end
  currentTokens = math.min(capacity, currentTokens + replenished)
  lastRefill = now
end

if currentTokens >= cost then
  currentTokens = currentTokens - cost
  redis.call('HMSET', KEYS[1], 'tokens', tostring(currentTokens), 'lastRefill', tostring(lastRefill))
  redis.call('EXPIRE', KEYS[1], ttl)
  return {1, math.floor(currentTokens), 0}
else
  local needed = cost - currentTokens
  local retryAfterMs = 0
  if refillRate > 0 then
    retryAfterMs = math.ceil((needed / refillRate) * 1000.0)
  else
    retryAfterMs = ttl * 1000
  end
  redis.call('HMSET', KEYS[1], 'tokens', tostring(currentTokens), 'lastRefill', tostring(lastRefill))
  redis.call('EXPIRE', KEYS[1], ttl)
  return {0, math.floor(currentTokens), retryAfterMs}
end
`;

/**
 * Adds to a live reservation the units of one extension, under the owner's daily limit, once: ARGV[1] is what the extension
 * holds in all, so a second call with the same extension adds only the difference and a retried step never adds twice.
 * The extension is counted in the reservation, so a settle or a rollback ends it with the reservation.
 */
export const EXTEND_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: usage key  KEYS[2]: reservation key  KEYS[3]: extension key (the reservation key and the extension id)
-- ARGV[1]: units the extension holds in all  ARGV[2]: max daily limit
-- Returns { 1 added or already held | 0 does not fit | -1 the reservation or the count of its day is gone, units left today }
-- A count that is gone (its day over) is never made again, as in the settle and the rollback.
if redis.call('EXISTS', KEYS[2]) == 0 or redis.call('EXISTS', KEYS[1]) == 0 then
  return {-1, 0}
end
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[2])
local added = tonumber(ARGV[1]) - tonumber(redis.call('GET', KEYS[3]) or '0')
if added <= 0 then
  return {1, limit - current}
end
if current + added > limit then
  return {0, limit - current}
end
redis.call('INCRBY', KEYS[1], added)
redis.call('INCRBY', KEYS[2], added)
redis.call('SET', KEYS[3], ARGV[1], 'EX', math.max(1, redis.call('TTL', KEYS[2])))
return {1, limit - current - added}
`;
