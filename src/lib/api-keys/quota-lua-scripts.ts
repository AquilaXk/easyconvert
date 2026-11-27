/**
 * The Lua scripts of the quota store (redis-key-store.ts, reservation-ledger.ts): each one reads and changes the keys of one
 * owner in one step, so concurrent requests never pass the daily limit together.
 */

/**
 * The credits of an owner, which these scripts reserve, charge and give back (docs/policy-decisions.md, entries 15, 285 and 374). An
 * account spends from three sources, in this order: the allowance of its window (the free plan's UTC day, or a subscription's billing
 * period), then its promotional grants (event credits), then its package balance, which has no window and never expires. A
 * reservation holds units of each: `held` has the units of the window, `qholds` those of the promotional grants (a JSON list of
 * grant and units, in the order they were drawn), `pholds` those of the package.
 *
 * The leases of an owner (reservation-ledger.ts), whose keys every script names once, in the order of `ReservationKeys`. Of the
 * window: `usage` is its count, `leases` a sorted set of the live reservations scored by the time their lease ends, `held` a hash of
 * the window units each one holds, `limits` a hash of the limit of the window each was made under. Of the owner, whatever window a
 * script is given: `pool` the package balance, `plist` a sorted set of the reservations that hold package units scored by the time
 * their lease ends, `pholds` a hash of those units, `debt` the package credits that a refund found held by a reservation and that are
 * taken back when those units return (see the revoke script). Then `extensions`, a hash of what each extension of one reservation
 * holds, and `log`, the list of recent charges; a script on the window alone is given the first eleven (the window's four, the
 * owner's package keys and the owner's promotional keys: `promo`, a hash of campaign id to the JSON of the grant, `qlist`, a sorted
 * set of the reservations that hold promotional units scored by the time their lease ends, and `qholds`, a hash of those units).
 * Promotional grants are spent in burn-down order (priority, the earlier expiry with none last, the earlier creation, the id: the
 * order of `compareGrantsByBurnDownOrder` in promo-grants.ts), skip a grant that ended or was voided, and are not part of the
 * package scripts below, so a refund never reaches them. Every script first gives back the units of
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
local function reclaimPackage()
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', plist, '-inf', now)) do
    local packed = tonumber(redis.call('HGET', pholds, id) or '0')
    redis.call('HDEL', pholds, id)
    redis.call('ZREM', plist, id)
    returnToPool(packed)
  end
end
`;

/**
 * The promotional grants of an owner (promo-grants.ts), for every script that spends them: it needs the locals `promo`, `qlist`,
 * `qholds` and `now`. A hold is a list of {campaign id, units} in the order the units were drawn; units that return go to the
 * grants drawn last first, and to no grant that was voided.
 */
const PROMO_FUNCTIONS = `
local function bytesBefore(a, b)
  for i = 1, math.min(#a, #b) do
    local x, y = string.byte(a, i), string.byte(b, i)
    if x ~= y then return x < y end
  end
  return #a < #b
end
local function burnsBefore(i, j)
  if i.priority ~= j.priority then return i.priority < j.priority end
  local iExp, jExp = i.expires_at, j.expires_at
  if iExp == nil and jExp ~= nil then return false end
  if iExp ~= nil and jExp == nil then return true end
  if iExp ~= nil and jExp ~= nil then
    local a, b = math.floor(iExp / 1000), math.floor(jExp / 1000)
    if a ~= b then return a < b end
  end
  if i.granted_at ~= j.granted_at then return i.granted_at < j.granted_at end
  return bytesBefore(i.grant_id, j.grant_id)
end
-- The grants that can be spent now (not voided, not ended, credits left), in burn-down order when asked, and the credits in them.
local function spendableGrants(sorted)
  local list, total = {}, 0
  if redis.call('HLEN', promo) == 0 then return list, total end
  for _, raw in ipairs(redis.call('HVALS', promo)) do
    local grant = cjson.decode(raw)
    if grant.voided_at == nil and grant.remaining > 0 and (grant.expires_at == nil or grant.expires_at > now) then
      list[#list + 1] = grant
      total = total + grant.remaining
    end
  end
  if sorted then table.sort(list, burnsBefore) end
  return list, total
end
local function drawPromo(units)
  local draws = {}
  for _, grant in ipairs(spendableGrants(true)) do
    if units <= 0 then break end
    local take = math.min(units, grant.remaining)
    grant.remaining = grant.remaining - take
    units = units - take
    redis.call('HSET', promo, grant.campaign_id, cjson.encode(grant))
    draws[#draws + 1] = {grant.campaign_id, take}
  end
  return draws
end
local function returnPromo(draws)
  for _, draw in ipairs(draws) do
    local raw = redis.call('HGET', promo, draw[1])
    if raw then
      local grant = cjson.decode(raw)
      if grant.voided_at == nil then
        grant.remaining = grant.remaining + draw[2]
        redis.call('HSET', promo, draw[1], cjson.encode(grant))
      end
    end
  end
end
local function promoHold(id)
  local raw = redis.call('HGET', qholds, id)
  if not raw then return {} end
  return cjson.decode(raw)
end
local function promoUnits(hold)
  local total = 0
  for _, entry in ipairs(hold) do total = total + entry[2] end
  return total
end
local function mergeDraws(hold, draws)
  for _, draw in ipairs(draws) do
    local merged = false
    for _, entry in ipairs(hold) do
      if entry[1] == draw[1] then entry[2] = entry[2] + draw[2]; merged = true; break end
    end
    if not merged then hold[#hold + 1] = draw end
  end
end
-- Takes \`units\` out of a hold, from the grants drawn last, and answers what was taken.
local function takeBack(hold, units)
  local back = {}
  for i = #hold, 1, -1 do
    if units <= 0 then break end
    local give = math.min(units, hold[i][2])
    hold[i][2] = hold[i][2] - give
    units = units - give
    back[#back + 1] = {hold[i][1], give}
  end
  return back
end
local function reclaimPromo()
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', qlist, '-inf', now)) do
    local raw = redis.call('HGET', qholds, id)
    if raw then returnPromo(cjson.decode(raw)) end
    redis.call('HDEL', qholds, id)
    redis.call('ZREM', qlist, id)
  end
end
`;

const LEASE_FUNCTIONS = `
local usage, leases, held, limits, pool, plist, pholds, debt, promo, qlist, qholds, extensions, log = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9], KEYS[10], KEYS[11], KEYS[12], KEYS[13]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
${PACKAGE_FUNCTIONS}
${PROMO_FUNCTIONS}
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
  reclaimPromo()
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
 * Reserves units, leased for ARGV[4] milliseconds: from the window's headroom under the limit first, then from the
 * promotional grants (in burn-down order) and then from the package balance. Nothing is taken when the three together do not cover them. The limit is kept with the reservation (`limits`),
 * since a charge on top at the end of it is held to the limit of the window it was made in. Answers {1 | 0, units left in both}.
 */
export const RESERVE_QUOTA_LUA_SCRIPT = `
-- ARGV[1]: units  ARGV[2]: window limit  ARGV[3]: reservation id  ARGV[4]: lease in ms  ARGV[5]: ms until the window ends
${LEASE_FUNCTIONS}
local units = tonumber(ARGV[1])
local free, balance = room(tonumber(ARGV[2]))
local _, promoLeft = spendableGrants(false)
local fromWindow = math.min(units, free)
local fromPromo = math.min(units - fromWindow, promoLeft)
local fromPackage = units - fromWindow - fromPromo
if fromPackage > balance then
  return {0, free + promoLeft + balance}
end
local leaseEnd = now + tonumber(ARGV[4])
if fromWindow > 0 then redis.call('INCRBY', usage, fromWindow) end
if fromPromo > 0 then
  redis.call('HSET', qholds, ARGV[3], cjson.encode(drawPromo(fromPromo)))
  redis.call('ZADD', qlist, leaseEnd, ARGV[3])
end
if fromPackage > 0 then redis.call('DECRBY', pool, fromPackage) end
redis.call('ZADD', leases, leaseEnd, ARGV[3])
redis.call('HSET', held, ARGV[3], fromWindow)
redis.call('HSET', limits, ARGV[3], ARGV[2])
if fromPackage > 0 then
  redis.call('HSET', pholds, ARGV[3], fromPackage)
  redis.call('ZADD', plist, leaseEnd, ARGV[3])
end
keepDay(math.max(leaseEnd, now + tonumber(ARGV[5])))
return {1, free + promoLeft + balance - units}
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
  if redis.call('ZSCORE', qlist, ARGV[1]) then
    redis.call('ZADD', qlist, newEnd, ARGV[1])
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
 * surcharge of a conversion that ran long): from the window's headroom under the limit the reservation was made under first, then from the
 * promotional grants, then from the package balance, and what none covers is not charged and is reported, since the work is done and the credits
 * are not there. A refund of units goes to the package first, then to the grants drawn last, the sources that were drawn last. ARGV[5] is a JSON object of what the charge was for, or '':
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
local hold = promoHold(ARGV[1])
local fromPromo = promoUnits(hold)
local limit = tonumber(redis.call('HGET', limits, ARGV[1]) or '0')
fromWindow = tonumber(fromWindow)
redis.call('HDEL', held, ARGV[1])
redis.call('HDEL', limits, ARGV[1])
redis.call('HDEL', pholds, ARGV[1])
redis.call('HDEL', qholds, ARGV[1])
redis.call('ZREM', leases, ARGV[1])
redis.call('ZREM', plist, ARGV[1])
redis.call('ZREM', qlist, ARGV[1])
redis.call('DEL', extensions)
local held_total = fromWindow + fromPromo + fromPackage
local target = held_total
if ARGV[2] ~= 'held' then
  target = tonumber(ARGV[2])
end
target = target + tonumber(ARGV[3])
local newWindow, newPromo, newPackage, short = fromWindow, fromPromo, fromPackage, 0
if target <= held_total then
  newWindow = math.min(fromWindow, target)
  newPromo = math.min(fromPromo, target - newWindow)
  newPackage = target - newWindow - newPromo
else
  local more = target - held_total
  local free, balance = room(limit)
  local _, promoLeft = spendableGrants(false)
  local addWindow = math.min(more, free)
  local addPromo = math.min(more - addWindow, promoLeft)
  local addPackage = math.min(more - addWindow - addPromo, balance)
  newWindow = fromWindow + addWindow
  newPromo = fromPromo + addPromo
  newPackage = fromPackage + addPackage
  short = more - addWindow - addPromo - addPackage
end
local dWindow = newWindow - fromWindow
local dPackage = newPackage - fromPackage
if dWindow ~= 0 and redis.call('EXISTS', usage) == 1 then
  redis.call('INCRBY', usage, dWindow)
end
if newPromo < fromPromo then
  returnPromo(takeBack(hold, fromPromo - newPromo))
elseif newPromo > fromPromo then
  drawPromo(newPromo - fromPromo)
end
if dPackage < 0 then
  returnToPool(-dPackage)
elseif dPackage > 0 and redis.call('EXISTS', pool) == 1 then
  redis.call('DECRBY', pool, dPackage)
end
if ARGV[4] ~= '' and newWindow + newPromo + newPackage > 0 then
  local entry = cjson.decode(ARGV[4])
  entry.at = now
  entry.credits = newWindow + newPromo + newPackage
  entry.fromPackage = newPackage
  if newPromo > 0 then entry.fromPromo = newPromo end
  if short > 0 then entry.uncharged = short end
  redis.call('LPUSH', log, cjson.encode(entry))
  redis.call('LTRIM', log, 0, 49)
end
return {1, newWindow + newPromo + newPackage - held_total, short}
`;

/**
 * The window's count, the package balance, the package credits held by reservations in flight that no refund claims, the credits
 * of the promotional grants that can be spent now and the earliest end among them (0 when none ends), once the leases that ended gave their units back.
 */
export const USED_QUOTA_LUA_SCRIPT = `
${LEASE_FUNCTIONS}
local owed = tonumber(redis.call('GET', debt) or '0')
local grants, promoTotal = spendableGrants(false)
local nextExpiry = 0
for _, grant in ipairs(grants) do
  if grant.expires_at ~= nil and (nextExpiry == 0 or grant.expires_at < nextExpiry) then nextExpiry = grant.expires_at end
end
return {tonumber(redis.call('GET', usage) or '0'), tonumber(redis.call('GET', pool) or '0'), math.max(0, heldPackage() - owed), promoTotal, nextExpiry}
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
 * Adds to a live reservation the units of one extension, from the window's headroom under the limit first, then from the promotional
 * grants and then from the package balance, once: ARGV[3] is what the extension holds in all, so a second call with the same extension adds only the
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
local _, promoLeft = spendableGrants(false)
local added = tonumber(ARGV[3]) - tonumber(redis.call('HGET', extensions, ARGV[2]) or '0')
if added <= 0 then
  return {1, free + promoLeft + balance}
end
if added > free + promoLeft + balance then
  return {0, free + promoLeft + balance}
end
local fromWindow = math.min(added, free)
local fromPromo = math.min(added - fromWindow, promoLeft)
local fromPackage = added - fromWindow - fromPromo
if fromWindow > 0 then
  redis.call('INCRBY', usage, fromWindow)
  redis.call('HINCRBY', held, ARGV[1], fromWindow)
end
if fromPromo > 0 then
  local hold = promoHold(ARGV[1])
  mergeDraws(hold, drawPromo(fromPromo))
  redis.call('HSET', qholds, ARGV[1], cjson.encode(hold))
  redis.call('ZADD', qlist, tonumber(leaseEnd), ARGV[1])
end
if fromPackage > 0 then
  redis.call('DECRBY', pool, fromPackage)
  redis.call('HINCRBY', pholds, ARGV[1], fromPackage)
  redis.call('ZADD', plist, tonumber(leaseEnd), ARGV[1])
end
redis.call('HSET', extensions, ARGV[2], ARGV[3])
keep(extensions, tonumber(leaseEnd))
return {1, free + promoLeft + balance - added}
`;

/**
 * Adds the credits of one paid package payment to the balance, once for each transaction id: the payment is written in the
 * account's hash of payments in the same step, so a second delivery of the same event, or the reconciliation that finds the
 * payment again, adds nothing. The balance has no expiry.
 */
export const GRANT_PACKAGE_LUA_SCRIPT = `
-- KEYS[1]: the package balance  KEYS[2]: the account's payments (a hash of transaction id to JSON)  KEYS[3]: the debt
-- ARGV[1]: transaction id  ARGV[2]: credits  ARGV[3]: what was paid (lowest unit, text)  ARGV[4]: when
-- Returns {1 credited | 0 already credited, the balance}
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  return {0, tonumber(redis.call('GET', KEYS[1]) or '0')}
end
local credits = tonumber(ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode({credits = credits, paid = ARGV[3], revoked = 0, at = tonumber(ARGV[4])}))
local owed = tonumber(redis.call('GET', KEYS[3]) or '0')
local paidDebt = math.min(credits, owed)
if paidDebt > 0 then
  if paidDebt == owed then redis.call('DEL', KEYS[3]) else redis.call('DECRBY', KEYS[3], paidDebt) end
end
local net = credits - paidDebt
if net > 0 then
  return {1, redis.call('INCRBY', KEYS[1], net)}
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], 0)
end
return {1, tonumber(redis.call('GET', KEYS[1]) or '0')}
`;

/**
 * Takes back the credits of a refunded or charged-back package payment, once for each adjustment id: a full refund takes back
 * all that is left of the payment's credits, a partial one the share of them that the amount is of what was paid (rounded down). A
 * payment's credits are never taken back twice and never push the spendable balance below zero. Any portion of `want` not currently
 * sitting in `pool` (whether held by an in-flight reservation or already spent) is booked to `debt`: returning held units pay `debt`
 * first via `returnToPool`, and any remainder stays as account debt deducted automatically from subsequent package grants.
 */
export const REVOKE_PACKAGE_LUA_SCRIPT = `
-- KEYS[1]: the package balance  KEYS[2]: the account's payments  KEYS[3]: the adjustments already applied (a hash of adjustment id to credits revoked)
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
local short = want - take
local deferred = math.min(short, math.max(0, heldPackage() - tonumber(redis.call('GET', debt) or '0')))
if short > 0 then
  redis.call('INCRBY', debt, short)
end
payment.revoked = payment.revoked + want
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(payment))
redis.call('HSET', KEYS[3], ARGV[2], want)
return {1, take, short - deferred, deferred}
`;

/**
 * Writes the promotional grant of one campaign to the account, once: the hash of grants is keyed by campaign id, so a second call
 * for the same campaign finds the grant, also after it was voided, and adds nothing (policy-decisions.md, entry 374).
 */
export const GRANT_PROMO_LUA_SCRIPT = `
-- KEYS[1]: the account's promotional grants (a hash of campaign id to the grant as JSON)
-- ARGV[1]: campaign id  ARGV[2]: the grant as JSON
-- Returns 1 written | 0 the account already has a grant of the campaign
return redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
`;

/**
 * Takes the credits of one promotional grant out of the account, once. Credits spent stay spent and the credits that reservations in
 * flight hold are not taken back; when such a reservation ends, the units that would return to a voided grant are dropped.
 */
export const VOID_PROMO_LUA_SCRIPT = `
-- KEYS[1]: the account's promotional grants
-- ARGV[1]: campaign id  ARGV[2]: now in ms
-- Returns {1 voided | 0 already voided | -1 no grant, credits taken out}
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return {-1, 0}
end
local grant = cjson.decode(raw)
if grant.voided_at ~= nil then
  return {0, 0}
end
local taken = grant.remaining
grant.voided_at = tonumber(ARGV[2])
grant.voided_remaining = taken
grant.remaining = 0
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(grant))
return {1, taken}
`;

/**
 * Counts one account's grant against the budget of its campaign, once for each account, before the grant is written to the account
 * (the two keys are of two slots, so the grant is a second step; an account the campaign already counts goes on to the second step
 * without being counted again, which repairs a first step that was not followed by the second, and a second step that finds the grant
 * written leaves the count alone: another call, running at the same moment, counted the account and wrote it).
 */
export const RESERVE_PROMO_BUDGET_LUA_SCRIPT = `
-- KEYS[1]: the campaign (a hash: budget, granted, count, created_at, voided_at)  KEYS[2]: the accounts the campaign counts (a set)
-- ARGV[1]: account  ARGV[2]: credits  ARGV[3]: budget in credits or ''  ARGV[4]: now in ms
-- Returns {1 counted | 0 already counted | -1 the campaign was voided (checked first, so a voided campaign grants nobody) | -2 over the budget, credits of the budget left}
if redis.call('HEXISTS', KEYS[1], 'voided_at') == 1 then
  return {-1, 0}
end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
  return {0, 0}
end
if ARGV[3] ~= '' then
  redis.call('HSET', KEYS[1], 'budget', ARGV[3])
end
local credits = tonumber(ARGV[2])
local granted = tonumber(redis.call('HGET', KEYS[1], 'granted') or '0')
local budget = tonumber(redis.call('HGET', KEYS[1], 'budget') or '')
if budget ~= nil and granted + credits > budget then
  return {-2, math.max(0, budget - granted)}
end
redis.call('HINCRBY', KEYS[1], 'granted', credits)
redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HSETNX', KEYS[1], 'created_at', ARGV[4])
redis.call('SADD', KEYS[2], ARGV[1])
return {1, 0}
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

export const SYNC_ACTIVE_API_KEYS_LUA_SCRIPT = `
-- KEYS[1]: user_active_keys:<userId>  KEYS[2]: user_active_keys_init:<userId>  KEYS[3]: user_keys:<userId>
-- KEYS[4..3+#ARGV]: apikeys:<keyId> matching ARGV[1..#ARGV]
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 'OK'
end
if redis.call('SCARD', KEYS[3]) ~= #ARGV then
  return 'RETRY'
end
redis.call('DEL', KEYS[1])
for i = 1, #ARGV do
  if redis.call('HGET', KEYS[3 + i], 'status') == 'active' then
    redis.call('SADD', KEYS[1], ARGV[i])
  end
end
redis.call('SET', KEYS[2], '1')
return 'SYNCED'
`;

export const CREATE_API_KEY_LUA_SCRIPT = `
-- KEYS[1]: apikeys:<keyId>  KEYS[2]: apikey_hashes  KEYS[3]: user_keys:<userId>  KEYS[4]: user_active_keys:<userId>  KEYS[5]: user_active_keys_init:<userId>
-- ARGV[1]: id  ARGV[2]: userId  ARGV[3]: status  ARGV[4]: keyHash  ARGV[5]: previousKeyHash  ARGV[6]: dataJson  ARGV[7]: maxActiveKeys
local maxActive = tonumber(ARGV[7] or '0')
if maxActive and maxActive > 0 and ARGV[3] == 'active' then
  if KEYS[5] and redis.call('EXISTS', KEYS[5]) == 0 and redis.call('SCARD', KEYS[3]) > 0 then
    return 'NEEDS_SYNC'
  end
  if KEYS[4] and redis.call('SCARD', KEYS[4]) >= maxActive then
    return 'LIMIT_REACHED'
  end
end
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'userId', ARGV[2], 'status', ARGV[3], 'keyHash', ARGV[4], 'previousKeyHash', ARGV[5], 'data', ARGV[6])
redis.call('HSET', KEYS[2], ARGV[4], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[1])
if KEYS[4] and ARGV[3] == 'active' then
  redis.call('SADD', KEYS[4], ARGV[1])
end
if KEYS[5] and redis.call('EXISTS', KEYS[5]) == 0 and redis.call('SCARD', KEYS[3]) <= 1 then
  redis.call('SET', KEYS[5], '1')
end
return 'CREATED'
`;

export const DELETE_API_KEY_LUA_SCRIPT = `
-- KEYS[1]: apikeys:<keyId>  KEYS[2]: apikey_hashes  KEYS[3]: user_keys:<userId>  KEYS[4]: rate:apikey:<keyId>  KEYS[5]: user_active_keys:<userId> (optional)
-- ARGV[1]: userId  ARGV[2]: keyId  ARGV[3]: localOwnerId
local ownerId = redis.call('HGET', KEYS[1], 'userId')
local effectiveOwner = ownerId or (ARGV[3] ~= '' and ARGV[3] or false)
if effectiveOwner ~= ARGV[1] then
  return 'FORBIDDEN'
end
local keyHash = redis.call('HGET', KEYS[1], 'keyHash')
local prevHash = redis.call('HGET', KEYS[1], 'previousKeyHash')
if keyHash and keyHash ~= '' then
  redis.call('HDEL', KEYS[2], keyHash)
end
if prevHash and prevHash ~= '' then
  redis.call('HDEL', KEYS[2], prevHash)
end
redis.call('SREM', KEYS[3], ARGV[2])
if KEYS[5] then
  redis.call('SREM', KEYS[5], ARGV[2])
end
redis.call('DEL', KEYS[1], KEYS[4])
return ownerId and 'DELETED' or 'MISSING'
`;

