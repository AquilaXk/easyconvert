/**
 * The Lua scripts of the quota store (redis-key-store.ts, reservation-ledger.ts): each one reads and changes the keys of one
 * owner in one step, so concurrent requests never pass the daily limit together.
 */

/**
 * The credits of an owner, which these scripts reserve, charge and give back (docs/policy-decisions.md, entries 15 and 285). An
 * account spends from two sources, in this order: the allowance of its window (the free plan's UTC day, or a subscription's billing
 * period), then its package balance, which has no window and never expires. A reservation holds units of each: `held` has the units
 * of the window, `pholds` those of the package.
 *
 * The leases of an owner (reservation-ledger.ts), whose keys every script names once, in the order of `ReservationKeys`. Of the
 * window: `usage` is its count, `leases` a sorted set of the live reservations scored by the time their lease ends, `held` a hash of
 * the window units each one holds, `limits` a hash of the limit of the window each was made under. Of the owner, whatever window a
 * script is given: `pool` the package balance, `plist` a sorted set of the reservations that hold package units scored by the time
 * their lease ends, `pholds` a hash of those units, `debt` the package credits that a refund found held by a reservation and that are
 * taken back when those units return (see the revoke script). Then `extensions`, a hash of what each extension of one reservation
 * holds, and `log`, the list of recent charges; a script on the window alone is given the first eight. Every script first gives back the units of
 * each lease that ended (`reclaim`): the window's from the window it was given, the package's from the owner's own list, so the
 * package units of a holder that died come back at the first script that touches the owner's balance, also when the window of its
 * reservation is not the window of that script (midnight, a new subscription period). No script acts on a lease that ended. `now` is the clock of
 * the Redis server (`TIME`, which a script may call since scripts are replicated by their effects), so every web and worker
 * process ends a lease at the same moment whatever its own clock says; callers pass durations, never times. `keep` makes a key
 * live at least until a time, never shorter, so the keys of a window live as long as its window or its longest lease, and a
 * reservation that outlives midnight still ends on its own window. A count that is gone (its window ended) and a balance that was
 * never made are not made again by a refund. Every key of an owner carries the owner's hash tag, so each script stays in one slot.
 */
/**
 * The package side of the leases, for every script that touches the balance: it needs the locals `pool`, `plist`, `pholds`, `debt`
 * and `now`. Units that return to the balance (a lease that ended, a rollback, a settle to fewer credits) first pay the debt of a
 * refund that found them held, and only the rest is spendable again.
 */
const PACKAGE_FUNCTIONS = `
local function heldPackage()
  local total = 0
  for _, packed in ipairs(redis.call('HVALS', pholds)) do total = total + tonumber(packed) end
  return total
end
local function returnToPool(units)
  local owed = tonumber(redis.call('GET', debt) or '0')
  if owed > 0 and units > 0 then
    local paid = math.min(owed, units)
    if paid == owed then redis.call('DEL', debt) else redis.call('DECRBY', debt, paid) end
    units = units - paid
  end
  if units > 0 and redis.call('EXISTS', pool) == 1 then
    redis.call('INCRBY', pool, units)
  end
end
-- Units that stay charged are not returned, so the debt cannot be more than what the live reservations still hold.
local function capDebt()
  local owed = tonumber(redis.call('GET', debt) or '0')
  if owed > 0 then
    local held = heldPackage()
    if owed > held then
      if held > 0 then redis.call('SET', debt, held) else redis.call('DEL', debt) end
    end
  end
end
local function reclaimPackage()
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', plist, '-inf', now)) do
    local packed = tonumber(redis.call('HGET', pholds, id) or '0')
    redis.call('HDEL', pholds, id)
    redis.call('ZREM', plist, id)
    returnToPool(packed)
  end
end
`;

const LEASE_FUNCTIONS = `
local usage, leases, held, limits, pool, plist, pholds, debt, extensions, log = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9], KEYS[10]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
${PACKAGE_FUNCTIONS}
local function reclaim()
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', leases, '-inf', now)) do
    local units = tonumber(redis.call('HGET', held, id) or '0')
    redis.call('HDEL', held, id)
    redis.call('HDEL', limits, id)
    redis.call('ZREM', leases, id)
    if units > 0 and redis.call('EXISTS', usage) == 1 then
      redis.call('DECRBY', usage, units)
    end
  end
  reclaimPackage()
end
local function keep(key, untilMs)
  if redis.call('PTTL', key) < untilMs - now then
    redis.call('PEXPIRE', key, math.max(1, untilMs - now))
  end
end
local function keepDay(untilMs)
  for _, key in ipairs({usage, leases, held, limits}) do keep(key, untilMs) end
end
-- Splits what an owner can still spend: the window's headroom under the limit, and the package balance.
local function room(limit)
  local free = math.max(0, limit - tonumber(redis.call('GET', usage) or '0'))
  return free, tonumber(redis.call('GET', pool) or '0')
end
reclaim()
`;

/**
 * Reserves units, leased for ARGV[4] milliseconds: from the window's headroom under the limit first, the rest from the package
 * balance. Nothing is taken when the two together do not cover them. The limit is kept with the reservation (`limits`),
 * since a charge on top at the end of it is held to the limit of the window it was made in. Answers {1 | 0, units left in both}.
 */
export const RESERVE_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: units  ARGV[2]: window limit  ARGV[3]: reservation id  ARGV[4]: lease in ms  ARGV[5]: ms until the window ends
${LEASE_FUNCTIONS}
local units = tonumber(ARGV[1])
local free, balance = room(tonumber(ARGV[2]))
local fromWindow = math.min(units, free)
local fromPackage = units - fromWindow
if fromPackage > balance then
  return {0, free + balance}
end
local leaseEnd = now + tonumber(ARGV[4])
if fromWindow > 0 then redis.call('INCRBY', usage, fromWindow) end
if fromPackage > 0 then redis.call('DECRBY', pool, fromPackage) end
redis.call('ZADD', leases, leaseEnd, ARGV[3])
redis.call('HSET', held, ARGV[3], fromWindow)
redis.call('HSET', limits, ARGV[3], ARGV[2])
if fromPackage > 0 then
  redis.call('HSET', pholds, ARGV[3], fromPackage)
  redis.call('ZADD', plist, leaseEnd, ARGV[3])
end
keepDay(math.max(leaseEnd, now + tonumber(ARGV[5])))
return {1, free + balance - units}
`;

/**
 * Moves the lease of a live reservation to end ARGV[2] milliseconds from now, when that is later. The extensions of the
 * reservation live as long as its lease. 0 when it is gone.
 */
export const RENEW_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: reservation id  ARGV[2]: lease in ms
${LEASE_FUNCTIONS}
local leaseEnd = redis.call('ZSCORE', leases, ARGV[1])
if not leaseEnd then
  return 0
end
local newEnd = now + tonumber(ARGV[2])
if newEnd > tonumber(leaseEnd) then
  redis.call('ZADD', leases, newEnd, ARGV[1])
  if redis.call('ZSCORE', plist, ARGV[1]) then
    redis.call('ZADD', plist, newEnd, ARGV[1])
  end
  keepDay(newEnd)
  if redis.call('EXISTS', extensions) == 1 then
    keep(extensions, newEnd)
  end
end
return 1
`;

/**
 * Ends a live reservation once, charging ARGV[2] units in place of those it held, or keeping them with ARGV[2] = 'held': a
 * commit keeps them, a rollback charges 0, and a settle charges what was used. ARGV[3] units more are charged on top (the minute
 * surcharge of a conversion that ran long): from the window's headroom under the limit the reservation was made under first, then from the package
 * balance, and what neither covers is not charged and is reported, since the work is done and the credits are not there. A refund
 * of units goes to the package first, the source that was drawn last. ARGV[5] is a JSON object of what the charge was for, or '':
 * it joins the list of recent charges with the credits charged in all and the time. A count that is gone is not made again. The
 * extensions of the reservation end with it.
 */
export const SETTLE_TO_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: reservation id  ARGV[2]: units charged in its place, or 'held'  ARGV[3]: units charged on top  ARGV[4]: charge entry JSON or ''
-- Returns {1 ended | 0 no live reservation, units charged more (fewer when negative), units that could not be charged}
${LEASE_FUNCTIONS}
local fromWindow = redis.call('HGET', held, ARGV[1])
if not fromWindow then
  return {0, 0, 0}
end
local fromPackage = tonumber(redis.call('HGET', pholds, ARGV[1]) or '0')
local limit = tonumber(redis.call('HGET', limits, ARGV[1]) or '0')
fromWindow = tonumber(fromWindow)
redis.call('HDEL', held, ARGV[1])
redis.call('HDEL', limits, ARGV[1])
redis.call('HDEL', pholds, ARGV[1])
redis.call('ZREM', leases, ARGV[1])
redis.call('ZREM', plist, ARGV[1])
redis.call('DEL', extensions)
local held_total = fromWindow + fromPackage
local target = held_total
if ARGV[2] ~= 'held' then
  target = tonumber(ARGV[2])
end
target = target + tonumber(ARGV[3])
local newWindow, newPackage, short = fromWindow, fromPackage, 0
if target <= held_total then
  newWindow = math.min(fromWindow, target)
  newPackage = target - newWindow
else
  local more = target - held_total
  local free, balance = room(limit)
  local addWindow = math.min(more, free)
  local addPackage = math.min(more - addWindow, balance)
  newWindow = fromWindow + addWindow
  newPackage = fromPackage + addPackage
  short = more - addWindow - addPackage
end
local dWindow = newWindow - fromWindow
local dPackage = newPackage - fromPackage
if dWindow ~= 0 and redis.call('EXISTS', usage) == 1 then
  redis.call('INCRBY', usage, dWindow)
end
if dPackage < 0 then
  returnToPool(-dPackage)
elseif dPackage > 0 and redis.call('EXISTS', pool) == 1 then
  redis.call('DECRBY', pool, dPackage)
end
capDebt()
if ARGV[4] ~= '' and newWindow + newPackage > 0 then
  local entry = cjson.decode(ARGV[4])
  entry.at = now
  entry.credits = newWindow + newPackage
  entry.fromPackage = newPackage
  if short > 0 then entry.uncharged = short end
  redis.call('LPUSH', log, cjson.encode(entry))
  redis.call('LTRIM', log, 0, 49)
end
return {1, newWindow + newPackage - held_total, short}
`;

/**
 * The window's count, the package balance and the package credits held by reservations in flight that no refund claims, once the
 * leases that ended gave their units back.
 */
export const USED_QUOTA_LUA_SCRIPT = `
${LEASE_FUNCTIONS}
local owed = tonumber(redis.call('GET', debt) or '0')
return {tonumber(redis.call('GET', usage) or '0'), tonumber(redis.call('GET', pool) or '0'), math.max(0, heldPackage() - owed)}
`;

/** The package balance and the package credits held in flight that no refund claims, once the leases that ended gave their units back. */
export const PACKAGE_STANDING_LUA_SCRIPT = `
-- KEYS[1]: the package balance  KEYS[2]: the leases that hold package units  KEYS[3]: the units they hold  KEYS[4]: the debt
local pool, plist, pholds, debt = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
${PACKAGE_FUNCTIONS}
reclaimPackage()
local owed = tonumber(redis.call('GET', debt) or '0')
return {tonumber(redis.call('GET', pool) or '0'), math.max(0, heldPackage() - owed)}
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
 * Adds to a live reservation the units of one extension, from the window's headroom under the limit first and then from the
 * package balance, once: ARGV[3] is what the extension holds in all, so a second call with the same extension adds only the
 * difference and a retried step never adds twice. The extension is counted in the reservation, so a settle or a rollback ends it
 * with the reservation; `extensions` lives as long as its lease, which a renewal moves with it.
 */
export const EXTEND_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: reservation id  ARGV[2]: extension id  ARGV[3]: units the extension holds in all  ARGV[4]: window limit
-- Returns { 1 added or already held | 0 does not fit | -1 the reservation or the count of its window is gone, units left }
-- A count that is gone is never made again, as in the settle and the rollback.
${LEASE_FUNCTIONS}
local leaseEnd = redis.call('ZSCORE', leases, ARGV[1])
if not leaseEnd or redis.call('EXISTS', usage) == 0 then
  return {-1, 0}
end
local free, balance = room(tonumber(ARGV[4]))
local added = tonumber(ARGV[3]) - tonumber(redis.call('HGET', extensions, ARGV[2]) or '0')
if added <= 0 then
  return {1, free + balance}
end
if added > free + balance then
  return {0, free + balance}
end
local fromWindow = math.min(added, free)
local fromPackage = added - fromWindow
if fromWindow > 0 then
  redis.call('INCRBY', usage, fromWindow)
  redis.call('HINCRBY', held, ARGV[1], fromWindow)
end
if fromPackage > 0 then
  redis.call('DECRBY', pool, fromPackage)
  redis.call('HINCRBY', pholds, ARGV[1], fromPackage)
  redis.call('ZADD', plist, tonumber(leaseEnd), ARGV[1])
end
redis.call('HSET', extensions, ARGV[2], ARGV[3])
keep(extensions, tonumber(leaseEnd))
return {1, free + balance - added}
`;

/**
 * Adds the credits of one paid package payment to the balance, once for each transaction id: the payment is written in the
 * account's hash of payments in the same step, so a second delivery of the same event, or the reconciliation that finds the
 * payment again, adds nothing. The balance has no expiry.
 */
export const GRANT_PACKAGE_LUA_SCRIPT = `
-- KEYS[1]: the package balance  KEYS[2]: the account's payments (a hash of transaction id to JSON)
-- ARGV[1]: transaction id  ARGV[2]: credits  ARGV[3]: what was paid (lowest unit, text)  ARGV[4]: when
-- Returns {1 credited | 0 already credited, the balance}
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  return {0, tonumber(redis.call('GET', KEYS[1]) or '0')}
end
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode({credits = tonumber(ARGV[2]), paid = ARGV[3], revoked = 0, at = tonumber(ARGV[4])}))
return {1, redis.call('INCRBY', KEYS[1], tonumber(ARGV[2]))}
`;

/**
 * Takes back the unused credits of a refunded or charged-back package payment, once for each adjustment id: a full refund takes back
 * all that is left of the payment's credits, a partial one the share of them that the amount is of what was paid (rounded down). A
 * payment's credits are never taken back twice and never more than the balance holds, so the balance does not go below zero. What the
 * balance does not hold is either held by a reservation in flight or spent. The held part, up to the units the reservations still
 * hold beyond the debt of earlier refunds, is recorded as a debt of the account and the payment counts it as taken back: those units
 * pay it when they return to the balance (a rollback, a lease that ended, a settle to fewer credits), so a refund during a
 * reservation that then rolls back does not leave the refunded credits spendable. The rest was spent and is reported as unrecovered.
 */
export const REVOKE_PACKAGE_LUA_SCRIPT = `
-- KEYS[1]: the package balance  KEYS[2]: the account's payments  KEYS[3]: the adjustments already applied (a hash of adjustment id to credits taken)
-- KEYS[4]: the leases that hold package units  KEYS[5]: the units they hold  KEYS[6]: the debt
-- ARGV[1]: transaction id  ARGV[2]: adjustment id  ARGV[3]: the amount returned (lowest unit, text)  ARGV[4]: 1 for a full refund, else 0
-- Returns {1 applied | 0 adjustment already applied | -1 payment unknown, credits taken back now, credits owed and already spent, credits taken back when held units return}
local pool, plist, pholds, debt = KEYS[1], KEYS[4], KEYS[5], KEYS[6]
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then
  return {-1, 0, 0, 0}
end
if redis.call('HEXISTS', KEYS[3], ARGV[2]) == 1 then
  return {0, 0, 0, 0}
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
${PACKAGE_FUNCTIONS}
reclaimPackage()
local payment = cjson.decode(raw)
local left = payment.credits - payment.revoked
local paid = tonumber(payment.paid) or 0
local want = left
if ARGV[4] ~= '1' then
  want = 0
  if paid > 0 then want = math.min(left, math.floor(payment.credits * (tonumber(ARGV[3]) or 0) / paid)) end
end
local take = math.min(want, tonumber(redis.call('GET', pool) or '0'))
if take > 0 then
  redis.call('DECRBY', pool, take)
end
local deferred = math.min(want - take, math.max(0, heldPackage() - tonumber(redis.call('GET', debt) or '0')))
if deferred > 0 then
  redis.call('INCRBY', debt, deferred)
end
payment.revoked = payment.revoked + take + deferred
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(payment))
redis.call('HSET', KEYS[3], ARGV[2], take + deferred)
return {1, take, want - take - deferred, deferred}
`;

export const RECORD_VERIFIED_KEY_LUA_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if redis.call('HGET', KEYS[1], 'status') == 'revoked' then
  return 0
end
if ARGV[3] ~= '' then
  local hashField = (ARGV[6] ~= nil and ARGV[6] ~= '') and ARGV[6] or 'keyHash'
  redis.call('HSET', KEYS[1], hashField, ARGV[3], 'data', ARGV[2], 'lastUsedAt', ARGV[1])
  redis.call('HSET', KEYS[2], ARGV[3], ARGV[5])
  if ARGV[4] ~= '' and ARGV[4] ~= ARGV[3] then
    redis.call('HDEL', KEYS[2], ARGV[4])
  end
elseif ARGV[2] ~= '' then
  redis.call('HSET', KEYS[1], 'data', ARGV[2], 'lastUsedAt', ARGV[1])
else
  redis.call('HSET', KEYS[1], 'lastUsedAt', ARGV[1])
end
return 1
`;

export const REVOKE_API_KEY_LUA_SCRIPT = `
-- KEYS[1]: apikeys:<keyId>
-- ARGV[1]: userId  ARGV[2]: expectedKeyHash  ARGV[3]: revokedDataJson
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
local ownerId = redis.call('HGET', KEYS[1], 'userId')
if ownerId and ownerId ~= ARGV[1] then
  return 'FORBIDDEN'
end
if ARGV[3] ~= '' and redis.call('HGET', KEYS[1], 'keyHash') == ARGV[2] then
  redis.call('HSET', KEYS[1], 'status', 'revoked', 'data', ARGV[3])
else
  redis.call('HSET', KEYS[1], 'status', 'revoked')
end
return 'REVOKED'
`;

export const UPDATE_API_KEY_LUA_SCRIPT = `
-- KEYS[1]: apikeys:<keyId>
-- ARGV[1]: userId  ARGV[2]: expectedKeyHash  ARGV[3]: updatedDataJson
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'INACTIVE'
end
if redis.call('HGET', KEYS[1], 'userId') ~= ARGV[1] then
  return 'INACTIVE'
end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then
  return 'INACTIVE'
end
if redis.call('HGET', KEYS[1], 'keyHash') ~= ARGV[2] then
  return 'RETRY'
end
redis.call('HSET', KEYS[1], 'data', ARGV[3])
return 'OK'
`;

export const ROTATE_API_KEY_LUA_SCRIPT = `
-- KEYS[1]: apikeys:<keyId>  KEYS[2]: apikey_hashes
-- ARGV[1]: userId  ARGV[2]: expectedKeyHash  ARGV[3]: newKeyHash  ARGV[4]: previousKeyHash
-- ARGV[5]: outgoingPreviousHash  ARGV[6]: graceExpiresAt  ARGV[7]: updatedDataJson  ARGV[8]: keyId
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'INACTIVE'
end
if redis.call('HGET', KEYS[1], 'userId') ~= ARGV[1] then
  return 'INACTIVE'
end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then
  return 'INACTIVE'
end
if redis.call('HGET', KEYS[1], 'keyHash') ~= ARGV[2] then
  return 'RETRY'
end
redis.call('HSET', KEYS[1], 'data', ARGV[7], 'keyHash', ARGV[3], 'previousKeyHash', ARGV[4], 'graceExpiresAt', ARGV[6])
redis.call('HSET', KEYS[2], ARGV[3], ARGV[8])
if ARGV[4] ~= '' then
  redis.call('HSET', KEYS[2], ARGV[4], ARGV[8])
end
if ARGV[5] ~= '' and ARGV[5] ~= ARGV[3] and ARGV[5] ~= ARGV[4] then
  redis.call('HDEL', KEYS[2], ARGV[5])
end
return 'OK'
`;

