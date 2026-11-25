import crypto from 'node:crypto';
import type Redis from 'ioredis';
import type { ChainableCommander } from 'ioredis';
import { isClusterRedis } from '../redis/cluster-ops';
import { whenReady } from '../redis/when-ready';

const sha1ByScript = new Map<string, string>();
const loadedByClient = new WeakMap<object, Set<string>>();
const preloadedClusterMastersByClient = new WeakMap<object, Set<string>>();

type EvalCapableClient = Pick<Redis, 'eval'> & {
  evalsha?: (...args: unknown[]) => Promise<unknown>;
  script?: (...args: unknown[]) => Promise<unknown>;
  pipeline?: () => ChainableCommander;
};

type ClusterCapableClient = EvalCapableClient & {
  nodes?: (role: 'master' | 'slave' | 'all') => Redis[] | Promise<Redis[]>;
};

/**
 * Returns the lowercase hex SHA-1 digest Redis assigns to `script` in its Lua script cache
 * (`src/eval.c` `sha1hex`), memoized per distinct script string.
 */
export function luaScriptSha1(script: string): string {
  const cached = sha1ByScript.get(script);
  if (cached) return cached;
  const digest = crypto.createHash('sha1').update(script, 'utf8').digest('hex');
  sha1ByScript.set(script, digest);
  return digest;
}

/** True when a Redis error reports a missing script cache entry (`NOSCRIPT`). */
export function isNoScriptError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('NOSCRIPT');
}

function hasLoadedSha(cache: WeakMap<object, Set<string>>, client: object, sha: string): boolean {
  return Boolean(cache.get(client)?.has(sha));
}

function markLoadedSha(cache: WeakMap<object, Set<string>>, client: object, sha: string): void {
  let loaded = cache.get(client);
  if (!loaded) {
    loaded = new Set<string>();
    cache.set(client, loaded);
  }
  loaded.add(sha);
}

function clearLoadedSha(client: object, sha: string): void {
  loadedByClient.get(client)?.delete(sha);
  preloadedClusterMastersByClient.get(client)?.delete(sha);
}

/**
 * Executes a queue Lua script via `EVALSHA` first and falls back to `EVAL` on `NOSCRIPT`
 * (populating Redis's script cache atomically for subsequent `EVALSHA` calls). Unit-test doubles
 * that stub only `eval` continue via `client.eval`.
 */
export async function evalQueueLua(
  client: Redis,
  script: string,
  numKeys: number,
  ...args: (string | number)[]
): Promise<unknown> {
  const target = client as unknown as EvalCapableClient;
  if (typeof target.evalsha !== 'function') {
    return target.eval(script, numKeys, ...args);
  }
  const sha = luaScriptSha1(script);
  try {
    const result = await target.evalsha(sha, numKeys, ...args);
    markLoadedSha(loadedByClient, target, sha);
    return result;
  } catch (err) {
    if (!isNoScriptError(err)) {
      throw err;
    }
    clearLoadedSha(target, sha);
    const result = await target.eval(script, numKeys, ...args);
    markLoadedSha(loadedByClient, target, sha);
    return result;
  }
}

/**
 * Ensures `script` has been loaded into Redis before a multi-command pipeline runs `EVALSHA`
 * batches, avoiding `N` parallel `NOSCRIPT` replies on a cold connection.
 */
export async function ensureQueueLuaLoaded(client: Redis, script: string): Promise<string> {
  const sha = luaScriptSha1(script);
  const target = client as unknown as ClusterCapableClient;
  if (typeof target.evalsha !== 'function') {
    return sha;
  }
  if (isClusterRedis(client)) {
    if (hasLoadedSha(preloadedClusterMastersByClient, target, sha)) {
      return sha;
    }
    const c = client as { once?: unknown; off?: unknown; status?: unknown; connect?: unknown };
    if (
      typeof c.once === 'function' &&
      typeof c.off === 'function' &&
      typeof c.status === 'string' &&
      (c.status !== 'wait' || typeof c.connect === 'function')
    ) {
      await whenReady(client);
    }
    if (typeof target.nodes === 'function') {
      const masters = await Promise.resolve(target.nodes('master'));
      const loaders = masters.filter((node) => typeof (node as unknown as EvalCapableClient).script === 'function');
      if (loaders.length > 0) {
        await Promise.all(loaders.map((node) => (node as unknown as EvalCapableClient).script!('LOAD', script)));
        markLoadedSha(preloadedClusterMastersByClient, target, sha);
      }
      return sha;
    }
  }
  if (!hasLoadedSha(loadedByClient, target, sha) && typeof target.script === 'function') {
    await target.script('LOAD', script);
    markLoadedSha(loadedByClient, target, sha);
  }
  return sha;
}

export interface PipelineLuaCall {
  numKeys: number;
  args: (string | number)[];
}

export interface PipelineEvalQueueLuaOptions {
  script: string;
  prefix?: (pipeline: ChainableCommander) => number;
  calls: readonly PipelineLuaCall[];
}

type PipelineWithEval = ChainableCommander & {
  evalsha: (...args: unknown[]) => unknown;
  eval: (...args: unknown[]) => unknown;
};

/**
 * Executes optional prefix commands plus a batch of identical-script Lua calls in one Redis
 * pipeline using `EVALSHA`, recovering automatically via `EVAL` if Redis flushed its
 * script cache between `SCRIPT LOAD` and pipeline execution.
 */
export async function execPipelineEvalQueueLua(
  client: Redis,
  options: PipelineEvalQueueLuaOptions
): Promise<unknown[]> {
  const { script, prefix, calls } = options;
  if (calls.length === 0 && !prefix) return [];

  const target = client as unknown as EvalCapableClient;
  const canEvalsha = typeof target.evalsha === 'function';
  const sha = canEvalsha && calls.length > 0 ? await ensureQueueLuaLoaded(client, script) : '';

  const pipeline = client.pipeline() as PipelineWithEval;
  const prefixCount = prefix ? prefix(pipeline) : 0;
  for (const call of calls) {
    if (canEvalsha) {
      pipeline.evalsha(sha, call.numKeys, ...call.args);
    } else {
      pipeline.eval(script, call.numKeys, ...call.args);
    }
  }

  const raw = (await pipeline.exec()) ?? [];
  const expectedReplies = prefixCount + calls.length;
  if (raw.length !== expectedReplies) {
    throw new Error(`Redis EVALSHA pipeline returned ${raw.length} replies for ${expectedReplies} commands.`);
  }
  for (let i = 0; i < prefixCount; i++) {
    const [err] = raw[i] ?? [];
    if (err) throw err;
  }

  const answers: unknown[] = new Array(calls.length);
  const missedIndices: number[] = [];
  for (let i = 0; i < calls.length; i++) {
    const [err, reply] = raw[prefixCount + i] ?? [];
    if (err) {
      if (canEvalsha && isNoScriptError(err)) {
        missedIndices.push(i);
      } else {
        throw err;
      }
    } else {
      answers[i] = reply;
    }
  }

  if (missedIndices.length > 0) {
    clearLoadedSha(target, sha);
    const retry = client.pipeline() as PipelineWithEval;
    for (const callIdx of missedIndices) {
      const call = calls[callIdx];
      retry.eval(script, call.numKeys, ...call.args);
    }
    const retryRaw = (await retry.exec()) ?? [];
    if (retryRaw.length !== missedIndices.length) {
      throw new Error(`Redis EVALSHA retry pipeline returned ${retryRaw.length} replies for ${missedIndices.length} commands.`);
    }
    missedIndices.forEach((callIdx, pos) => {
      const [err, reply] = retryRaw[pos] ?? [];
      if (err) throw err;
      answers[callIdx] = reply;
    });
    if (!isClusterRedis(client)) {
      markLoadedSha(loadedByClient, target, sha);
    }
  }

  return answers;
}
