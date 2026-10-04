/**
 * Atomic Lua scripts for job graph state.
 *
 * Every script touches only keys of one graph, which share the `{gid}` hash tag, so each EVAL
 * stays in one Redis Cluster slot. Scripts never write queue keys: nodes that become ready are
 * appended to the graph outbox (`graph:{gid}:outbox`), and the scheduler moves them onto the
 * resource-class queues through the queue engine afterwards (transactional outbox).
 *
 * Node transitions are guarded, so a repeated completion or failure of the same node is a no-op.
 */

export const INIT_GRAPH_LUA_SCRIPT = `
-- KEYS[1]: graphKey    KEYS[2]: depsKey    KEYS[3]: childrenKey
-- KEYS[4]: nodesKey    KEYS[5]: outputsKey KEYS[6]: outboxKey
-- ARGV[1]: gid
-- ARGV[2]: JSON graph fields to store on the graph hash
-- ARGV[3]: JSON nodes array [{ id, op, inDegree, children }]
-- ARGV[4]: createdAt timestamp ms

if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.error_reply('Graph already exists: ' .. ARGV[1])
end

local fields = cjson.decode(ARGV[2])
for k, v in pairs(fields) do
  redis.call('HSET', KEYS[1], k, tostring(v))
end
redis.call('HSET', KEYS[1], 'graphId', ARGV[1], 'status', 'running', 'completedNodes', '0', 'failedNodes', '0')

local ready = {}
for _, n in ipairs(cjson.decode(ARGV[3])) do
  redis.call('HSET', KEYS[2], n.id, tostring(n.inDegree))
  redis.call('HSET', KEYS[3], n.id, cjson.encode(n.children or {}))
  local initialStatus = (n.inDegree == 0) and 'waiting' or 'pending'
  redis.call('HSET', KEYS[4], n.id, cjson.encode({
    id = n.id, op = n.op, status = initialStatus, outputs = {}, createdAt = tonumber(ARGV[4])
  }))
  if n.inDegree == 0 then
    redis.call('RPUSH', KEYS[6], n.id)
    table.insert(ready, n.id)
  end
end

return cjson.encode(ready)
`;

export const NODE_STARTED_LUA_SCRIPT = `
-- KEYS[1]: graphKey  KEYS[2]: nodesKey
-- ARGV[1]: nodeId    ARGV[2]: startedAt timestamp ms

if redis.call('HGET', KEYS[1], 'status') ~= 'running' then
  return 0
end
local rawNode = redis.call('HGET', KEYS[2], ARGV[1])
if not rawNode then
  return 0
end
local state = cjson.decode(rawNode)
if state.status ~= 'waiting' and state.status ~= 'active' then
  return 0
end
state.status = 'active'
state.startedAt = tonumber(ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(state))
return 1
`;

/** Shared tail: marks the graph completed when no node can still run. */
const COMPLETE_WHEN_ALL_TERMINAL = `
local function allTerminal(nodesKey)
  local all = redis.call('HGETALL', nodesKey)
  for i = 2, #all, 2 do
    local s = cjson.decode(all[i]).status
    if s == 'pending' or s == 'waiting' or s == 'active' then
      return false
    end
  end
  return true
end
`;

export const NODE_COMPLETED_LUA_SCRIPT = `
-- KEYS[1]: graphKey    KEYS[2]: depsKey    KEYS[3]: childrenKey
-- KEYS[4]: nodesKey    KEYS[5]: outputsKey KEYS[6]: outboxKey
-- ARGV[1]: nodeId  ARGV[2]: outputs JSON array  ARGV[3]: finishedAt ms  ARGV[4]: units
-- Returns { applied(0|1), graphStatus, readyNodeIds JSON, accumulatedUnits }
${COMPLETE_WHEN_ALL_TERMINAL}
local graphStatus = redis.call('HGET', KEYS[1], 'status')
if graphStatus ~= 'running' then
  return { 0, graphStatus or 'missing', '[]', '0' }
end
local rawNode = redis.call('HGET', KEYS[4], ARGV[1])
if not rawNode then
  return { 0, graphStatus, '[]', '0' }
end
local nodeState = cjson.decode(rawNode)
-- A node completes once: a repeated completion leaves counters and child in-degrees unchanged.
if nodeState.status ~= 'waiting' and nodeState.status ~= 'active' then
  return { 0, graphStatus, '[]', redis.call('HGET', KEYS[1], 'accumulatedUnits') or '0' }
end

nodeState.status = 'completed'
nodeState.finishedAt = tonumber(ARGV[3])
nodeState.outputs = cjson.decode(ARGV[2])
redis.call('HSET', KEYS[4], ARGV[1], cjson.encode(nodeState))
redis.call('HSET', KEYS[5], ARGV[1], ARGV[2])
redis.call('HINCRBY', KEYS[1], 'completedNodes', 1)
local units = redis.call('HINCRBY', KEYS[1], 'accumulatedUnits', tonumber(ARGV[4]) or 1)

local ready = {}
for _, childId in ipairs(cjson.decode(redis.call('HGET', KEYS[3], ARGV[1]) or '[]')) do
  local childState = cjson.decode(redis.call('HGET', KEYS[4], childId))
  if childState.status == 'pending' then
    local remaining = redis.call('HINCRBY', KEYS[2], childId, -1)
    if remaining == 0 then
      childState.status = 'waiting'
      redis.call('HSET', KEYS[4], childId, cjson.encode(childState))
      redis.call('RPUSH', KEYS[6], childId)
      table.insert(ready, childId)
    end
  end
end

local status = 'running'
if allTerminal(KEYS[4]) then
  status = 'completed'
  redis.call('HSET', KEYS[1], 'status', status, 'finishedOn', ARGV[3])
end
return { 1, status, cjson.encode(ready), tostring(units) }
`;

export const NODE_FAILED_LUA_SCRIPT = `
-- KEYS[1]: graphKey  KEYS[2]: childrenKey  KEYS[3]: nodesKey  KEYS[4]: outboxKey
-- ARGV[1]: nodeId  ARGV[2]: error message  ARGV[3]: finishedAt ms
-- Returns { applied(0|1), graphStatus, cancelledNodeIds JSON, skippedNodeIds JSON }
${COMPLETE_WHEN_ALL_TERMINAL}
local graphStatus = redis.call('HGET', KEYS[1], 'status')
if graphStatus ~= 'running' then
  return { 0, graphStatus or 'missing', '[]', '[]' }
end
local rawNode = redis.call('HGET', KEYS[3], ARGV[1])
if not rawNode then
  return { 0, graphStatus, '[]', '[]' }
end
local nodeState = cjson.decode(rawNode)
if nodeState.status ~= 'waiting' and nodeState.status ~= 'active' then
  return { 0, graphStatus, '[]', '[]' }
end

nodeState.status = 'failed'
nodeState.error = ARGV[2]
nodeState.finishedAt = tonumber(ARGV[3])
redis.call('HSET', KEYS[3], ARGV[1], cjson.encode(nodeState))
redis.call('HINCRBY', KEYS[1], 'failedNodes', 1)

if (redis.call('HGET', KEYS[1], 'policy') or 'fail_fast') == 'fail_fast' then
  redis.call('HSET', KEYS[1], 'status', 'failed', 'failedReason', ARGV[2], 'finishedOn', ARGV[3])
  local cancelled = {}
  local all = redis.call('HGETALL', KEYS[3])
  for i = 1, #all, 2 do
    local s = cjson.decode(all[i + 1])
    if s.status == 'pending' or s.status == 'waiting' or s.status == 'active' then
      s.status = 'cancelled'
      redis.call('HSET', KEYS[3], all[i], cjson.encode(s))
      redis.call('LREM', KEYS[4], 0, all[i])
      table.insert(cancelled, all[i])
    end
  end
  return { 1, 'failed', cjson.encode(cancelled), '[]' }
end

-- continue policy: skip every descendant that has not run yet.
local skipped = {}
local queue = { ARGV[1] }
local visited = { [ARGV[1]] = true }
while #queue > 0 do
  local curr = table.remove(queue, 1)
  for _, childId in ipairs(cjson.decode(redis.call('HGET', KEYS[2], curr) or '[]')) do
    if not visited[childId] then
      visited[childId] = true
      table.insert(queue, childId)
      local s = cjson.decode(redis.call('HGET', KEYS[3], childId))
      if s.status == 'pending' or s.status == 'waiting' then
        s.status = 'skipped'
        redis.call('HSET', KEYS[3], childId, cjson.encode(s))
        redis.call('LREM', KEYS[4], 0, childId)
        table.insert(skipped, childId)
      end
    end
  end
end

local status = 'running'
if allTerminal(KEYS[3]) then
  status = 'completed'
  redis.call('HSET', KEYS[1], 'status', status, 'finishedOn', ARGV[3])
end
return { 1, status, '[]', cjson.encode(skipped) }
`;

export const CANCEL_GRAPH_LUA_SCRIPT = `
-- KEYS[1]: graphKey  KEYS[2]: nodesKey  KEYS[3]: outboxKey
-- ARGV[1]: reason  ARGV[2]: finishedAt ms
-- Returns { applied(0|1), graphStatus, cancelledNodeIds JSON }

local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'running' then
  return { 0, status or 'missing', '[]' }
end
redis.call('HSET', KEYS[1], 'status', 'cancelled', 'failedReason', ARGV[1], 'finishedOn', ARGV[2])
redis.call('DEL', KEYS[3])
local cancelled = {}
local all = redis.call('HGETALL', KEYS[2])
for i = 1, #all, 2 do
  local s = cjson.decode(all[i + 1])
  if s.status == 'pending' or s.status == 'waiting' or s.status == 'active' then
    s.status = 'cancelled'
    redis.call('HSET', KEYS[2], all[i], cjson.encode(s))
    table.insert(cancelled, all[i])
  end
end
return { 1, 'cancelled', cjson.encode(cancelled) }
`;
