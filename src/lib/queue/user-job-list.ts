import type Redis from 'ioredis';

/**
 * The job hashes of a window of a user's job ids, only of the jobs in one of the states given after the ids (all of them when no
 * state is given), so a job of another state costs one `HGET` and no transfer. An id whose job is gone leaves the index, checked
 * here in the same step, so an id that a new job took meanwhile stays.
 * KEYS[1]: the user's job index  KEYS[2]: job key prefix (e.g. prefix:{queue}:job:)
 * ARGV[1]: how many ids follow  ARGV[2]: '1' to skip the node jobs of graphs  then the ids  then the states wanted.
 * Returns the flat hashes of the jobs wanted, in the order of the ids.
 *
 * A node job of a graph has the id `<graph id>:<node id>` and a `"graphId":"` in its data; a job that has both is skipped when the
 * caller leaves graph nodes out, without its hash being read, so a user with thousands of graph nodes does not pay for them.
 * The caller leaves out the node jobs that get through, so this only saves the transfer.
 */
export const LIST_USER_JOBS_LUA_SCRIPT = `
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
    redis.call('ZREM', KEYS[1], id)
  elseif not filtered or wanted[state or 'waiting'] then
    local graphNode = false
    if skipGraphNodes and string.find(id, ':', 1, true) then
      local data = redis.call('HGET', key, 'data')
      graphNode = data ~= false and string.find(data, '"graphId":"', 1, true) ~= nil
    end
    if not graphNode then
      jobs[#jobs + 1] = redis.call('HGETALL', key)
    end
  end
end
return jobs
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

/**
 * The jobs of a user in the given states, newest first, from `offset` for `limit` jobs. The ids of the user come in one read and
 * their jobs a window at a time, until the page is full, so the cost follows the page (and, for a state that few jobs have, the
 * jobs the user has), never the jobs of other users, and a job that is not wanted is never transferred.
 */
export async function readUserJobs<J>(redis: Redis, options: UserJobListOptions<J>): Promise<J[]> {
  const ids = await redis.zrevrange(options.indexKey, 0, -1);
  const states = options.states ?? [];
  const wanted = options.offset + options.limit;
  const matched: J[] = [];
  // The first window is the page, so a page that most jobs match is read in one call; a state few jobs have takes larger windows.
  let window = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, wanted));
  for (let at = 0; at < ids.length && matched.length < wanted; window = Math.min(MAX_WINDOW, window * WINDOW_GROWTH)) {
    const chunk = ids.slice(at, at + window);
    at += chunk.length;
    const flats = (await redis.eval(LIST_USER_JOBS_LUA_SCRIPT, 2, options.indexKey, options.jobKeyPrefix, String(chunk.length), options.excludeGraphNodes ? '1' : '0', ...chunk, ...states)) as string[][];
    for (const flat of flats) {
      const job = options.toJob(flat);
      if (!options.exclude?.(job)) matched.push(job);
    }
  }
  return matched.slice(options.offset, wanted);
}
