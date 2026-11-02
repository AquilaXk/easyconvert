/**
 * The Lua scripts of the quota store (redis-key-store.ts, reservation-ledger.ts): each one reads and changes the keys of one
 * owner in one step, so concurrent requests never pass the daily limit together.
 */

/**
 * The leases of an owner's day (reservation-ledger.ts): KEYS[1] is the day's count, KEYS[2] a sorted set of the live
 * reservations scored by the time their lease ends, KEYS[3] a hash of the units each one holds. Every script first gives back
 * the units of each lease that ended (`reclaim`), so a reservation whose holder died stops counting once its lease ends, and
 * no script acts on a lease that ended. `keep` makes a key live at least until a time, never shorter, so the keys of a day
 * live as long as its day or its longest lease, and a reservation that outlives midnight still ends on its own day.
 * ARGV[1] of every lease script is the current time in milliseconds.
 */
const LEASE_FUNCTIONS = `
local now = tonumber(ARGV[1])
local function reclaim()
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)) do
    local units = tonumber(redis.call('HGET', KEYS[3], id) or '0')
    redis.call('HDEL', KEYS[3], id)
    redis.call('ZREM', KEYS[2], id)
    if units > 0 and redis.call('EXISTS', KEYS[1]) == 1 then
      redis.call('DECRBY', KEYS[1], units)
    end
  end
end
local function keep(key, untilMs)
  if redis.call('PTTL', key) < untilMs - now then
    redis.call('PEXPIRE', key, math.max(1, untilMs - now))
  end
end
local function keepDay(untilMs)
  for i = 1, 3 do keep(KEYS[i], untilMs) end
end
reclaim()
`;

/** Reserves units under the daily limit, leased until ARGV[5]. */
export const RESERVE_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: now  ARGV[2]: units  ARGV[3]: daily limit  ARGV[4]: reservation id  ARGV[5]: lease end  ARGV[6]: end of the day
${LEASE_FUNCTIONS}
local units = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current + units > limit then
  return {0, limit - current}
end
redis.call('INCRBY', KEYS[1], units)
redis.call('ZADD', KEYS[2], tonumber(ARGV[5]), ARGV[4])
redis.call('HSET', KEYS[3], ARGV[4], units)
keepDay(math.max(tonumber(ARGV[5]), tonumber(ARGV[6])))
return {1, limit - (current + units)}
`;

/** Moves the lease of a live reservation to end at ARGV[3] when that is later; 0 when the reservation is gone. */
export const RENEW_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: now  ARGV[2]: reservation id  ARGV[3]: lease end
${LEASE_FUNCTIONS}
local leaseEnd = redis.call('ZSCORE', KEYS[2], ARGV[2])
if not leaseEnd then
  return 0
end
if tonumber(ARGV[3]) > tonumber(leaseEnd) then
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[2])
  keepDay(tonumber(ARGV[3]))
end
return 1
`;

/** Ends a live reservation and keeps its units charged; 0 when it is gone (committed, ended or its lease over). */
export const COMMIT_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: now  ARGV[2]: reservation id
${LEASE_FUNCTIONS}
if redis.call('HEXISTS', KEYS[3], ARGV[2]) == 0 then
  return 0
end
redis.call('HDEL', KEYS[3], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[2])
return 1
`;

/** Gives the units of a live reservation back to its day once; a count that is gone is not made again. */
export const ROLLBACK_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: now  ARGV[2]: reservation id
${LEASE_FUNCTIONS}
local reserved = redis.call('HGET', KEYS[3], ARGV[2])
if not reserved then
  return 0
end
local units = tonumber(reserved)
redis.call('HDEL', KEYS[3], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[2])
if units > 0 and redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('DECRBY', KEYS[1], units)
end
return 1
`;

/** Charges the units a request used in place of those it reserved, once, under the same rules as the rollback. */
export const SETTLE_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: now  ARGV[2]: reservation id  ARGV[3]: units used
-- Returns {1 settled | 0 no live reservation, units charged more (fewer when negative)}
${LEASE_FUNCTIONS}
local reserved = redis.call('HGET', KEYS[3], ARGV[2])
if not reserved then
  return {0, 0}
end
local diff = tonumber(ARGV[3]) - tonumber(reserved)
redis.call('HDEL', KEYS[3], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[2])
if diff ~= 0 and redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('INCRBY', KEYS[1], diff)
end
return {1, diff}
`;

/** The day's count once the leases that ended gave their units back. */
export const USED_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: now
${LEASE_FUNCTIONS}
return tonumber(redis.call('GET', KEYS[1]) or '0')
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
 * Adds to a live reservation the units of one extension, under the owner's daily limit, once: ARGV[3] is what the extension
 * holds in all, so a second call with the same extension adds only the difference and a retried step never adds twice.
 * The extension is counted in the reservation, so a settle or a rollback ends it with the reservation; KEYS[4] remembers
 * what the extension holds for as long as the lease lasts.
 */
export const EXTEND_QUOTA_LUA_SCRIPT = `
-- KEYS[4]: extension key
-- ARGV[1]: now  ARGV[2]: reservation id  ARGV[3]: units the extension holds in all  ARGV[4]: daily limit
-- Returns { 1 added or already held | 0 does not fit | -1 the reservation or the count of its day is gone, units left today }
-- A count that is gone is never made again, as in the settle and the rollback.
${LEASE_FUNCTIONS}
local leaseEnd = redis.call('ZSCORE', KEYS[2], ARGV[2])
if not leaseEnd or redis.call('EXISTS', KEYS[1]) == 0 then
  return {-1, 0}
end
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[4])
local added = tonumber(ARGV[3]) - tonumber(redis.call('GET', KEYS[4]) or '0')
if added <= 0 then
  return {1, limit - current}
end
if current + added > limit then
  return {0, limit - current}
end
redis.call('INCRBY', KEYS[1], added)
redis.call('HINCRBY', KEYS[3], ARGV[2], added)
redis.call('SET', KEYS[4], ARGV[3], 'PX', math.max(1, tonumber(leaseEnd) - now))
return {1, limit - current - added}
`;
