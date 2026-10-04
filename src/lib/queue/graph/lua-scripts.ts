/**
 * Distributed Atomic Lua Scripts for JobGraph Orchestration.
 * Ensures total linearizability and race-free execution of DAG workflows,
 * fan-out/fan-in synchronization, and atomic failure/cancellation propagation.
 */

export const INIT_GRAPH_LUA_SCRIPT = `
-- KEYS[1]: graphKey (graph:{gid})
-- KEYS[2]: depsKey (graph:{gid}:deps)
-- KEYS[3]: childrenKey (graph:{gid}:children)
-- KEYS[4]: nodesKey (graph:{gid}:nodes)
-- KEYS[5]: outputsKey (graph:{gid}:outputs)
-- KEYS[6]: waitingKey (bull:{easyconvert-jobs}:waiting)
-- KEYS[7]: jobKeyPrefix (bull:{easyconvert-jobs}:job:)
-- ARGV[1]: gid (graphId)
-- ARGV[2]: policy ('fail_fast' or 'continue')
-- ARGV[3]: owner (userId or 'anonymous')
-- ARGV[4]: createdAt timestamp ms
-- ARGV[5]: totalNodes count
-- ARGV[6]: JSON encoded nodes array [{ id, op, inDegree, children, jobData }]
-- ARGV[7]: reservationId (optional)
-- ARGV[8]: graphJson (full JobGraph JSON string)

local status = redis.call('HGET', KEYS[1], 'status')
if status then
  return redis.error_reply('Graph already exists: ' .. ARGV[1])
end

redis.call('HSET', KEYS[1],
  'graphId', ARGV[1],
  'status', 'running',
  'policy', ARGV[2],
  'owner', ARGV[3],
  'createdAt', ARGV[4],
  'totalNodes', ARGV[5],
  'completedNodes', '0',
  'failedNodes', '0',
  'reservationId', ARGV[7] or '',
  'graph', ARGV[8] or '{}'
)

local nodes = cjson.decode(ARGV[6])
local readyJobs = {}

for _, n in ipairs(nodes) do
  local nodeId = n.id
  redis.call('HSET', KEYS[2], nodeId, tostring(n.inDegree))
  redis.call('HSET', KEYS[3], nodeId, cjson.encode(n.children or {}))
  
  local initialStatus = (n.inDegree == 0) and 'waiting' or 'pending'
  local nodeState = {
    id = nodeId,
    op = n.op,
    status = initialStatus,
    outputs = {},
    createdAt = tonumber(ARGV[4])
  }
  redis.call('HSET', KEYS[4], nodeId, cjson.encode(nodeState))
  
  -- Create Job hash in queue
  local jobId = ARGV[1] .. ':' .. nodeId
  local jobKey = KEYS[7] .. jobId
  
  redis.call('HSET', jobKey,
    'id', jobId,
    'name', 'graph-node',
    'data', n.jobData,
    'opts', cjson.encode({ attempts = 3 }),
    'progress', '0',
    'state', initialStatus,
    'attemptsMade', '0',
    'timestamp', ARGV[4],
    'processedOn', '',
    'finishedOn', '',
    'returnvalue', '',
    'failedReason', '',
    'stacktrace', '[]',
    'logs', '[]'
  )
  
  if n.inDegree == 0 then
    redis.call('RPUSH', KEYS[6], jobId)
    table.insert(readyJobs, jobId)
  end
end

return { ARGV[1], cjson.encode(readyJobs) }
`;

export const NODE_STARTED_LUA_SCRIPT = `
-- KEYS[1]: graphKey
-- KEYS[2]: nodesKey
-- ARGV[1]: nodeId
-- ARGV[2]: startedAt timestamp ms

local rawNode = redis.call('HGET', KEYS[2], ARGV[1])
if rawNode then
  local ok, state = pcall(cjson.decode, rawNode)
  if ok and type(state) == 'table' then
    state.status = 'active'
    state.startedAt = tonumber(ARGV[2])
    redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(state))
  end
end
return 1
`;

export const NODE_COMPLETED_LUA_SCRIPT = `
-- KEYS[1]: graphKey
-- KEYS[2]: depsKey
-- KEYS[3]: childrenKey
-- KEYS[4]: nodesKey
-- KEYS[5]: outputsKey
-- KEYS[6]: waitingKey
-- KEYS[7]: jobKeyPrefix
-- ARGV[1]: gid
-- ARGV[2]: nodeId
-- ARGV[3]: outputs JSON string array
-- ARGV[4]: finishedAt timestamp ms

local graphStatus = redis.call('HGET', KEYS[1], 'status')
if graphStatus ~= 'running' then
  return { 0, graphStatus or 'missing', '[]' }
end

-- 1. Store node outputs in graph:{gid}:outputs
redis.call('HSET', KEYS[5], ARGV[2], ARGV[3])

-- 2. Update node status in graph:{gid}:nodes
local rawNode = redis.call('HGET', KEYS[4], ARGV[2])
local nodeState = {}
if rawNode then
  local ok, dec = pcall(cjson.decode, rawNode)
  if ok and type(dec) == 'table' then nodeState = dec end
end
nodeState.status = 'completed'
nodeState.finishedAt = tonumber(ARGV[4])
nodeState.outputs = cjson.decode(ARGV[3])
redis.call('HSET', KEYS[4], ARGV[2], cjson.encode(nodeState))

local completedCount = redis.call('HINCRBY', KEYS[1], 'completedNodes', 1)
local totalNodes = tonumber(redis.call('HGET', KEYS[1], 'totalNodes') or '0')

-- 3. Decrement deps for each child node
local readyNodeIds = {}
local rawChildren = redis.call('HGET', KEYS[3], ARGV[2])
if rawChildren then
  local ok, children = pcall(cjson.decode, rawChildren)
  if ok and type(children) == 'table' then
    for _, childId in ipairs(children) do
      local remaining = redis.call('HINCRBY', KEYS[2], childId, -1)
      if remaining == 0 then
        -- Child is ready!
        local childJobId = ARGV[1] .. ':' .. childId
        local childJobKey = KEYS[7] .. childJobId
        redis.call('HSET', childJobKey, 'state', 'waiting')
        redis.call('RPUSH', KEYS[6], childJobId)
        
        local rawChildNode = redis.call('HGET', KEYS[4], childId)
        local childState = {}
        if rawChildNode then
          local ok2, dec2 = pcall(cjson.decode, rawChildNode)
          if ok2 and type(dec2) == 'table' then childState = dec2 end
        end
        childState.status = 'waiting'
        redis.call('HSET', KEYS[4], childId, cjson.encode(childState))
        
        table.insert(readyNodeIds, childId)
      end
    end
  end
end

local unitsConsumed = tonumber(ARGV[5] or '1')
local totalUnits = redis.call('HINCRBY', KEYS[1], 'accumulatedUnits', unitsConsumed)

-- 4. Check if entire graph completed
local isComplete = false
if completedCount >= totalNodes then
  redis.call('HSET', KEYS[1], 'status', 'completed', 'finishedOn', ARGV[4])
  isComplete = true
else
  local allNodes = redis.call('HGETALL', KEYS[4])
  local allTerminal = true
  for i = 1, #allNodes, 2 do
    local ok, nState = pcall(cjson.decode, allNodes[i + 1])
    if ok and nState then
      if nState.status == 'waiting' or nState.status == 'pending' or nState.status == 'active' then
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

return { 1, isComplete and 'completed' or 'running', cjson.encode(readyNodeIds), tostring(totalUnits) }
`;

export const NODE_FAILED_LUA_SCRIPT = `
-- KEYS[1]: graphKey
-- KEYS[2]: depsKey
-- KEYS[3]: childrenKey
-- KEYS[4]: nodesKey
-- KEYS[5]: outputsKey
-- KEYS[6]: waitingKey
-- KEYS[7]: jobKeyPrefix
-- ARGV[1]: gid
-- ARGV[2]: nodeId
-- ARGV[3]: error message
-- ARGV[4]: finishedAt timestamp ms

local policy = redis.call('HGET', KEYS[1], 'policy') or 'fail_fast'
redis.call('HINCRBY', KEYS[1], 'failedNodes', 1)

-- Update failed node state
local rawNode = redis.call('HGET', KEYS[4], ARGV[2])
local nodeState = {}
if rawNode then
  local ok, dec = pcall(cjson.decode, rawNode)
  if ok and type(dec) == 'table' then nodeState = dec end
end
nodeState.status = 'failed'
nodeState.error = ARGV[3]
nodeState.finishedAt = tonumber(ARGV[4])
redis.call('HSET', KEYS[4], ARGV[2], cjson.encode(nodeState))

if policy == 'fail_fast' then
  redis.call('HSET', KEYS[1], 'status', 'failed', 'failedReason', ARGV[3], 'finishedOn', ARGV[4])
  
  -- Cancel all non-terminal nodes
  local allNodes = redis.call('HGETALL', KEYS[4])
  local cancelledJobs = {}
  for i = 1, #allNodes, 2 do
    local nid = allNodes[i]
    local nDataRaw = allNodes[i + 1]
    local ok, nState = pcall(cjson.decode, nDataRaw)
    if ok and nState and nState.status ~= 'completed' and nState.status ~= 'failed' then
      nState.status = 'cancelled'
      redis.call('HSET', KEYS[4], nid, cjson.encode(nState))
      
      local jid = ARGV[1] .. ':' .. nid
      local jKey = KEYS[7] .. jid
      redis.call('HSET', jKey, 'state', 'cancelled', 'failedReason', 'Graph failed due to node ' .. ARGV[2])
      redis.call('LREM', KEYS[6], 0, jid)
      table.insert(cancelledJobs, jid)
    end
  end
  return { 1, 'failed', cjson.encode(cancelledJobs), '[]' }
else
  -- continue policy: recursively mark all descendants of nodeId as 'skipped'
  local queue = { ARGV[2] }
  local skippedNodes = {}
  local visited = {}
  visited[ARGV[2]] = true
  
  while #queue > 0 do
    local curr = table.remove(queue, 1)
    local rawChildren = redis.call('HGET', KEYS[3], curr)
    if rawChildren then
      local ok, children = pcall(cjson.decode, rawChildren)
      if ok and type(children) == 'table' then
        for _, childId in ipairs(children) do
          if not visited[childId] then
            visited[childId] = true
            table.insert(queue, childId)
            
            local rawChildNode = redis.call('HGET', KEYS[4], childId)
            local childState = {}
            if rawChildNode then
              local ok2, dec2 = pcall(cjson.decode, rawChildNode)
              if ok2 and type(dec2) == 'table' then childState = dec2 end
            end
            if childState.status ~= 'completed' and childState.status ~= 'failed' then
              childState.status = 'skipped'
              redis.call('HSET', KEYS[4], childId, cjson.encode(childState))
              
              local cJid = ARGV[1] .. ':' .. childId
              local cKey = KEYS[7] .. cJid
              redis.call('HSET', cKey, 'state', 'cancelled', 'failedReason', 'Skipped because upstream node ' .. ARGV[2] .. ' failed')
              redis.call('LREM', KEYS[6], 0, cJid)
              table.insert(skippedNodes, childId)
            end
          end
        end
      end
    end
  end
  
  -- Check if all nodes are now terminal
  local allNodes = redis.call('HGETALL', KEYS[4])
  local allTerminal = true
  for i = 1, #allNodes, 2 do
    local nDataRaw = allNodes[i + 1]
    local ok, nState = pcall(cjson.decode, nDataRaw)
    if ok and nState then
      if nState.status == 'waiting' or nState.status == 'pending' or nState.status == 'active' then
        allTerminal = false
        break
      end
    end
  end
  
  local finalStatus = allTerminal and 'completed' or 'running'
  if allTerminal then
    redis.call('HSET', KEYS[1], 'status', 'completed', 'finishedOn', ARGV[4])
  end
  
  return { 1, finalStatus, '[]', cjson.encode(skippedNodes) }
end
`;

export const CANCEL_GRAPH_LUA_SCRIPT = `
-- KEYS[1]: graphKey
-- KEYS[2]: nodesKey
-- KEYS[3]: waitingKey
-- KEYS[4]: jobKeyPrefix
-- ARGV[1]: gid
-- ARGV[2]: cancellation reason
-- ARGV[3]: finishedAt timestamp ms

local status = redis.call('HGET', KEYS[1], 'status')
if status == 'completed' or status == 'failed' or status == 'cancelled' then
  return { 0, status or 'terminal', '[]' }
end

redis.call('HSET', KEYS[1], 'status', 'cancelled', 'failedReason', ARGV[2], 'finishedOn', ARGV[3])

local allNodes = redis.call('HGETALL', KEYS[2])
local cancelledJobs = {}
for i = 1, #allNodes, 2 do
  local nid = allNodes[i]
  local nDataRaw = allNodes[i + 1]
  local ok, nState = pcall(cjson.decode, nDataRaw)
  if ok and nState and nState.status ~= 'completed' and nState.status ~= 'failed' and nState.status ~= 'skipped' then
    nState.status = 'cancelled'
    redis.call('HSET', KEYS[2], nid, cjson.encode(nState))
    
    local jid = ARGV[1] .. ':' .. nid
    local jKey = KEYS[4] .. jid
    redis.call('HSET', jKey, 'state', 'cancelled', 'failedReason', ARGV[2])
    redis.call('LREM', KEYS[3], 0, jid)
    table.insert(cancelledJobs, jid)
  end
end

return { 1, 'cancelled', cjson.encode(cancelledJobs) }
`;
