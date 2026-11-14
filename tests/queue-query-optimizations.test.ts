import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import type Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import { DistributedBullMQAdapter, Queue } from '../src/lib/queue/bullmq-engine';
import { acquireSyncSlot, mayEnqueue } from '../src/lib/queue/concurrency-limit';
import { cancelJobAcrossQueues, conversionQueue, getJobAcrossQueues, resourceQueues } from '../src/lib/queue/conversion-queue';
import { forgetUserJobs, type QueueKeySpace } from '../src/lib/queue/ended-jobs';
import { CANCEL_GRAPH_LUA_SCRIPT, INIT_GRAPH_LUA_SCRIPT, NODE_COMPLETED_LUA_SCRIPT, NODE_FAILED_LUA_SCRIPT } from '../src/lib/queue/graph/lua-scripts';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { RedisGraphScheduler } from '../src/lib/queue/graph/redis-scheduler';
import {
  ADD_JOB_LUA_SCRIPT,
  CANCEL_JOB_LUA_SCRIPT,
  COMPLETE_JOB_LUA_SCRIPT,
  FAIL_JOB_LUA_SCRIPT,
  OLDEST_WAITING_SINCE_LUA_SCRIPT,
  POP_NEXT_WAITING_JOB_LUA_SCRIPT,
  PROMOTE_DELAYED_JOBS_LUA_SCRIPT,
  RECOVER_STALLED_JOBS_LUA_SCRIPT,
  REMOVE_JOB_LUA_SCRIPT,
  REQUEUE_JOB_LUA_SCRIPT,
} from '../src/lib/queue/lua-scripts';
import {
  ALL_JOB_STATES,
  COUNT_USER_JOBS_LUA_SCRIPT,
  LIST_USER_JOBS_BY_STATE_LUA_SCRIPT,
  LIST_USER_JOBS_LUA_SCRIPT,
  countUserJobs,
  readUserJobs,
  userByStateKey,
  userByStateKeys,
} from '../src/lib/queue/user-job-list';
import { PayloadTooLargeForMemoryError } from '../src/lib/storage/errors';
import { REMOTE_INLINE_OBJECT_MAX_BYTES, REMOTE_STAGED_OBJECT_MAX_BYTES, RemoteStorageBackend } from '../src/lib/storage/remote-storage-backend';
import { StorageAdapterError } from '../src/lib/storage/adapters/adapter-interface';
import { S3ObjectClient } from '../src/lib/storage/s3-object-client';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { QueueUnavailableError } from '../src/lib/types';
import { clusterKeySlot } from './helpers/redis-cluster-slot';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';

interface RecordedCommand {
  name: string;
  args: unknown[];
}

interface PipelineEntry {
  name: string;
  args: unknown[];
  run: () => unknown;
}

function makeFakePipeline(
  executeCommand: (name: string, ...args: unknown[]) => unknown,
  calls: RecordedCommand[],
  pipelineCalls: { count: number }
) {
  const entries: PipelineEntry[] = [];
  const pipe = {
    zrevrange: (...args: unknown[]) => {
      entries.push({ name: 'zrevrange', args, run: () => executeCommand('zrevrange', ...args) });
      return pipe;
    },
    zrange: (...args: unknown[]) => {
      entries.push({ name: 'zrange', args, run: () => executeCommand('zrange', ...args) });
      return pipe;
    },
    zcard: (...args: unknown[]) => {
      entries.push({ name: 'zcard', args, run: () => executeCommand('zcard', ...args) });
      return pipe;
    },
    zrem: (...args: unknown[]) => {
      entries.push({ name: 'zrem', args, run: () => executeCommand('zrem', ...args) });
      return pipe;
    },
    scard: (...args: unknown[]) => {
      entries.push({ name: 'scard', args, run: () => executeCommand('scard', ...args) });
      return pipe;
    },
    smembers: (...args: unknown[]) => {
      entries.push({ name: 'smembers', args, run: () => executeCommand('smembers', ...args) });
      return pipe;
    },
    hget: (...args: unknown[]) => {
      entries.push({ name: 'hget', args, run: () => executeCommand('hget', ...args) });
      return pipe;
    },
    hgetall: (...args: unknown[]) => {
      entries.push({ name: 'hgetall', args, run: () => executeCommand('hgetall', ...args) });
      return pipe;
    },
    hmget: (...args: unknown[]) => {
      entries.push({ name: 'hmget', args, run: () => executeCommand('hmget', ...args) });
      return pipe;
    },
    hset: (...args: unknown[]) => {
      entries.push({ name: 'hset', args, run: () => executeCommand('hset', ...args) });
      return pipe;
    },
    srem: (...args: unknown[]) => {
      entries.push({ name: 'srem', args, run: () => executeCommand('srem', ...args) });
      return pipe;
    },
    del: (...args: unknown[]) => {
      entries.push({ name: 'del', args, run: () => executeCommand('del', ...args) });
      return pipe;
    },
    lrem: (...args: unknown[]) => {
      entries.push({ name: 'lrem', args, run: () => executeCommand('lrem', ...args) });
      return pipe;
    },
    publish: (...args: unknown[]) => {
      entries.push({ name: 'publish', args, run: () => executeCommand('publish', ...args) });
      return pipe;
    },
    eval: (...args: unknown[]) => {
      entries.push({ name: 'eval', args, run: () => executeCommand('eval', ...args) });
      return pipe;
    },
    exec: async () => {
      pipelineCalls.count += 1;
      return entries.map((entry) => {
        calls.push({ name: `pipe:${entry.name}`, args: entry.args });
        try {
          return [null, entry.run()] as [null, unknown];
        } catch (err) {
          return [err as Error, null] as [Error, null];
        }
      });
    },
  };
  return pipe;
}

// 1x1 transparent PNG bytes valid at magic/image inspectors.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Q-1: user job state secondary index & lightweight user job queries', () => {
  it('derives cluster-slot-aligned by_state keys even when userId contains colons', () => {
    const userIndex = 'ec:{easyconvert-jobs}:user_jobs:tenant:u_123';
    const expectedSlot = clusterKeySlot(userIndex);

    for (const state of ALL_JOB_STATES) {
      const stateKey = userByStateKey(userIndex, state);
      expect(stateKey).toBe(`ec:{easyconvert-jobs}:by_state:tenant:u_123:${state}`);
      expect(clusterKeySlot(stateKey)).toBe(expectedSlot);
    }

    expect(userByStateKeys(userIndex)).toHaveLength(ALL_JOB_STATES.length);
  });

  it('maintains by_state index in queue Lua scripts without expanding REMOVE_JOB_LUA_SCRIPT 8-key signature', () => {
    for (const script of [
      ADD_JOB_LUA_SCRIPT,
      PROMOTE_DELAYED_JOBS_LUA_SCRIPT,
      POP_NEXT_WAITING_JOB_LUA_SCRIPT,
      CANCEL_JOB_LUA_SCRIPT,
      REQUEUE_JOB_LUA_SCRIPT,
      COMPLETE_JOB_LUA_SCRIPT,
      FAIL_JOB_LUA_SCRIPT,
      RECOVER_STALLED_JOBS_LUA_SCRIPT,
      REMOVE_JOB_LUA_SCRIPT,
    ]) {
      expect(script).toMatch(/by_state/);
    }
    expect(REMOVE_JOB_LUA_SCRIPT).toContain("queuePrefixFromSuffixKey(KEYS[2], ':waiting')");
    expect(REMOVE_JOB_LUA_SCRIPT).not.toContain('KEYS[10]');
  });

  it('reads single-state non-empty by_state in ["zrevrange", "eval"] and multi-state in a single eval', async () => {
    const calls: RecordedCommand[] = [];
    const pipelineCalls = { count: 0 };
    const flatJob = ['id', 'j1', 'name', 'convert', 'data', '{"userId":"u1"}', 'state', 'waiting', 'timestamp', '100'];

    const execute = (name: string, ...args: unknown[]): unknown => {
      if (name === 'zrevrange') {
        const key = String(args[0]);
        if (key.includes(':by_state:u1:waiting')) return ['j1'];
        return [];
      }
      if (name === 'eval') {
        const script = String(args[0]);
        if (script === LIST_USER_JOBS_LUA_SCRIPT) return [flatJob];
        if (script === LIST_USER_JOBS_BY_STATE_LUA_SCRIPT) {
          return ['done', [flatJob], 1, 1, 0];
        }
        if (script === COUNT_USER_JOBS_LUA_SCRIPT) return 2;
      }
      return null;
    };

    const redis = {
      zrevrange: async (...args: unknown[]) => {
        calls.push({ name: 'zrevrange', args });
        return execute('zrevrange', ...args);
      },
      eval: async (...args: unknown[]) => {
        calls.push({ name: 'eval', args });
        return execute('eval', ...args);
      },
      pipeline: () => makeFakePipeline(execute, calls, pipelineCalls),
    } as unknown as Redis;

    // Single state present in by_state: only zrevrange(by_state) + LIST_USER_JOBS_LUA_SCRIPT
    const waitingJobs = await readUserJobs(redis, {
      indexKey: 'ec:{q}:user_jobs:u1',
      jobKeyPrefix: 'ec:{q}:job:',
      states: ['waiting'],
      limit: 5,
      offset: 0,
      toJob: (flat) => ({ id: flat[1] }),
    });
    expect(waitingJobs).toEqual([{ id: 'j1' }]);
    expect(calls.map((c) => c.name)).toEqual(['zrevrange', 'eval']);
    expect(calls[0].args[0]).toBe('ec:{q}:by_state:u1:waiting');

    calls.length = 0;
    // Multi-state filter skips JS-side zrevrange completely and runs 1 LIST_USER_JOBS_BY_STATE_LUA_SCRIPT eval
    const endedJobs = await readUserJobs(redis, {
      indexKey: 'ec:{q}:user_jobs:u1',
      jobKeyPrefix: 'ec:{q}:job:',
      states: ['completed', 'failed'],
      limit: 5,
      offset: 0,
      toJob: (flat) => ({ id: flat[1] }),
    });
    expect(endedJobs).toEqual([{ id: 'j1' }]);
    expect(calls.map((c) => c.name)).toEqual(['eval']);
    expect(calls[0].args[0]).toBe(LIST_USER_JOBS_BY_STATE_LUA_SCRIPT);

    calls.length = 0;
    // Unknown state or zero limit short-circuits before hitting Redis
    expect(
      await readUserJobs(redis, {
        indexKey: 'ec:{q}:user_jobs:u1',
        jobKeyPrefix: 'ec:{q}:job:',
        states: ['bogus'],
        limit: 5,
        offset: 0,
        toJob: (flat) => ({ id: flat[1] }),
      })
    ).toEqual([]);
    expect(
      await readUserJobs(redis, {
        indexKey: 'ec:{q}:user_jobs:u1',
        jobKeyPrefix: 'ec:{q}:job:',
        states: ['waiting'],
        limit: 0,
        offset: 0,
        toJob: (flat) => ({ id: flat[1] }),
      })
    ).toEqual([]);
    expect(calls).toHaveLength(0);

    // countUserJobs sends COUNT_USER_JOBS_LUA_SCRIPT in 1 eval call with no HGETALL
    const total = await countUserJobs(redis, {
      indexKey: 'ec:{q}:user_jobs:u1',
      jobKeyPrefix: 'ec:{q}:job:',
      states: ['waiting', 'active', 'delayed'],
      cap: 10,
      excludeGraphNodes: true,
    });
    expect(total).toBe(2);
    expect(calls.map((c) => c.name)).toEqual(['eval']);
    expect(calls[0].args[0]).toBe(COUNT_USER_JOBS_LUA_SCRIPT);
  });

  it('forgetUserJobs keeps 8-key REMOVE_JOB_LUA_SCRIPT contract and deletes all by_state keys when emptied', async () => {
    const calls: RecordedCommand[] = [];
    const pipelineCalls = { count: 0 };
    const execute = (name: string, ...args: unknown[]): unknown => {
      if (name === 'zrange') return ['job_done'];
      if (name === 'hmget') return [['{"userId":"u_del"}', 'completed']];
      if (name === 'eval') return 1;
      if (name === 'lrange') return [];
      if (name === 'del') return 7;
      return null;
    };

    const redis = {
      zrange: async (...args: unknown[]) => {
        calls.push({ name: 'zrange', args });
        return execute('zrange', ...args);
      },
      lrange: async (...args: unknown[]) => {
        calls.push({ name: 'lrange', args });
        return execute('lrange', ...args);
      },
      llen: async () => 0,
      smembers: async () => [],
      eval: async (...args: unknown[]) => {
        calls.push({ name: 'eval', args });
        return execute('eval', ...args);
      },
      del: async (...args: unknown[]) => {
        calls.push({ name: 'del', args });
        return execute('del', ...args);
      },
      pipeline: () => {
        const pipe = makeFakePipeline(execute, calls, pipelineCalls);
        // Adapt hmget inside readUserJobs/removeProcessedJobs where 1 job triggers 1 hmget in pipeline
        pipe.hmget = (...args: unknown[]) => {
          calls.push({ name: 'hmget-queued', args });
          return pipe;
        };
        const origExec = pipe.exec;
        pipe.exec = async () => {
          if (calls.some((c) => c.name === 'hmget-queued')) {
            pipelineCalls.count += 1;
            calls.length = 0;
            return [[null, ['{"userId":"u_del"}', 'completed']]] as Array<[null, unknown]>;
          }
          return origExec();
        };
        return pipe;
      },
    } as unknown as Redis;

    const keys: QueueKeySpace = {
      jobKey: (id) => `ec:{q}:job:${id}`,
      userJobsKey: (userId) => `ec:{q}:user_jobs:${userId ?? 'none'}`,
      dlqKey: 'ec:{q}:dlq',
      stateKeys: ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'].map((s) => `ec:{q}:${s}`) as unknown as QueueKeySpace['stateKeys'],
    };

    const left = await forgetUserJobs(redis, keys, 'u_del', new Set(['job_done']));
    expect(left).toEqual([]);

    const removeEval = calls.find((c) => c.name === 'pipe:eval' && c.args[0] === REMOVE_JOB_LUA_SCRIPT);
    expect(removeEval?.args[1]).toBe(8);

    const delCall = calls.find((c) => c.name === 'del');
    expect(delCall?.args).toEqual([
      'ec:{q}:user_jobs:u_del',
      ...ALL_JOB_STATES.map((st) => `ec:{q}:by_state:u_del:${st}`),
    ]);
  });

  it('DistributedBullMQAdapter.countJobsByUser fails closed when disconnected and matches Queue counting', async () => {
    const fakeDisconnected = {
      status: 'reconnecting',
      on: vi.fn(),
      eval: vi.fn(),
    } as unknown as Redis;
    const adapter = new DistributedBullMQAdapter('test-count', { redisClient: fakeDisconnected, keyPrefix: 'ec:' });
    await expect(adapter.countJobsByUser('u1', ['waiting', 'active'], 5)).rejects.toBeInstanceOf(QueueUnavailableError);
    await adapter.close();

    const memQueue = new Queue<{ userId: string; graphId?: string }, string>('mem-count');
    for (let i = 0; i < 6; i++) {
      await memQueue.add('c', { userId: 'u1', ...(i % 2 === 0 ? { graphId: 'g1' } : {}) });
    }
    expect(await memQueue.countJobsByUser('u1', ['waiting'], 10)).toBe(6);
    expect(await memQueue.countJobsByUser('u1', ['waiting'], 4)).toBe(4);
    expect(await memQueue.countJobsByUser('u1', ['waiting'], 10, { excludeGraphNodes: true })).toBe(3);
  });
});

describe('Q-3b: graph O(1) remainingNodes Lua transitions & drainOutbox batching', () => {
  it('dispatches O(1) remainingNodes graph Lua transitions with legacy allTerminal fallback and exact KEYS contracts', async () => {
    const evalCalls: Array<{ script: string; numKeys: number }> = [];
    const graphObj = {
      nodes: {
        a: { op: 'import.upload' as const, storageKey: 's/a.png' },
        b: { op: 'convert' as const, input: 'a', targetFormat: 'webp' },
      },
    };
    const redis = {
      eval: async (script: string, numKeys: number) => {
        evalCalls.push({ script, numKeys });
        if (script === INIT_GRAPH_LUA_SCRIPT) return 1;
        if (script === NODE_COMPLETED_LUA_SCRIPT) return [1, 'completed', '[]', '10', '', '[]'];
        if (script === NODE_FAILED_LUA_SCRIPT) return [1, 'failed', '["b"]', '["c"]', '5', '', '[]'];
        if (script === CANCEL_GRAPH_LUA_SCRIPT) return [1, 'cancelled', '["b"]', '', '[]'];
        return null;
      },
      lrange: async () => [],
      hgetall: async (key: string) =>
        key.endsWith(':nodes')
          ? {
              a: JSON.stringify({ id: 'a', op: 'import.upload', status: 'completed', outputs: ['out/a.png'] }),
              b: JSON.stringify({ id: 'b', op: 'convert', status: 'waiting', outputs: [] }),
            }
          : {
              graphId: 'g1',
              status: 'completed',
              policy: 'fail_fast',
              owner: 'u1',
              reservationId: '',
              webhookUrl: '',
              webhookSecret: '',
              originalFilename: '',
              sourceStorageKey: '',
              totalNodes: '2',
              completedNodes: '2',
              failedNodes: '0',
              createdAt: '1000',
              graph: JSON.stringify(graphObj),
            },
      hget: async () => null,
      hmget: async () => [],
      srem: async () => 1,
      del: async () => 1,
      zrem: async () => 1,
    } as unknown as Redis;

    const scheduler = new RedisGraphScheduler({ redisClient: redis, keyPrefix: 'ec:' });
    await scheduler.initGraph('g1', sealGraph('g1', graphObj), { ownerUserId: 'u1' });
    const completed = await scheduler.onNodeCompleted('g1', 'a', ['out/a.png'], 10);
    const failed = await scheduler.onNodeFailed('g1', 'a', 'boom', 'ERR');
    const cancelled = await scheduler.cancelGraph('g1', 'user stop');

    expect(completed.graphStatus).toBe('completed');
    expect(failed.graphStatus).toBe('failed');
    expect(cancelled).toBe(true);
    const lifecycleScripts = new Set([
      INIT_GRAPH_LUA_SCRIPT,
      NODE_COMPLETED_LUA_SCRIPT,
      NODE_FAILED_LUA_SCRIPT,
      CANCEL_GRAPH_LUA_SCRIPT,
    ]);
    expect(evalCalls.filter((c) => lifecycleScripts.has(c.script)).map((c) => c.numKeys)).toEqual([6, 6, 4, 3]);
    expect(INIT_GRAPH_LUA_SCRIPT.match(/'remainingNodes',\s*tostring\(#nodes\)/g)).toHaveLength(1);
    expect(NODE_COMPLETED_LUA_SCRIPT.match(/HINCRBY',\s*KEYS\[1\],\s*'remainingNodes',\s*-1/g)).toHaveLength(1);
    expect(NODE_COMPLETED_LUA_SCRIPT.match(/allTerminal\(KEYS\[4\]\)/g)).toHaveLength(1);
    expect(NODE_FAILED_LUA_SCRIPT.match(/'remainingNodes',\s*'0'/g)).toHaveLength(1);
    expect(NODE_FAILED_LUA_SCRIPT.match(/HINCRBY',\s*KEYS\[1\],\s*'remainingNodes',\s*-terminalDelta/g)).toHaveLength(1);
    expect(NODE_FAILED_LUA_SCRIPT.match(/allTerminal\(KEYS\[3\]\)/g)).toHaveLength(1);
    expect(CANCEL_GRAPH_LUA_SCRIPT.match(/'remainingNodes',\s*'0'/g)).toHaveLength(1);
  });

  it('drainOutbox hoists output hmget across ready nodes and pipelines lrem outbox cleanup', async () => {
    const calls: RecordedCommand[] = [];
    const pipelineCalls = { count: 0 };
    const enqueuedNodes: string[] = [];

    const graphDef = {
      nodes: {
        p1: { op: 'import.upload', storageKey: 's/p1.png' },
        p2: { op: 'import.upload', storageKey: 's/p2.png' },
        n1: { op: 'import.upload', storageKey: 's/1.pdf' },
        n2: { op: 'convert', input: 'p1', targetFormat: 'webp' },
        n3: { op: 'convert', input: ['p1', 'p2'], targetFormat: 'avif' },
      },
    };
    const meta = {
      graphId: 'g_drain',
      status: 'running',
      policy: 'fail_fast',
      owner: 'u1',
      reservationId: '',
      webhookUrl: '',
      webhookSecret: '',
      originalFilename: '',
      sourceStorageKey: '',
      totalNodes: '5',
      completedNodes: '2',
      failedNodes: '0',
      createdAt: '1000',
      graph: JSON.stringify(graphDef),
    };
    const outputs: Record<string, string> = {
      p1: JSON.stringify(['out/p1.png']),
      p2: JSON.stringify(['out/p2.png']),
    };

    const execute = (name: string, ...args: unknown[]): unknown => {
      if (name === 'lrange') return ['n1', 'n2', 'n3'];
      if (name === 'hmget') {
        const key = String(args[0]);
        const fields = args.slice(1).map(String);
        if (key.endsWith(':outputs')) return fields.map((f) => outputs[f] ?? null);
        return fields.map(() => null);
      }
      if (name === 'hgetall') return meta;
      if (name === 'lrem') return 1;
      return null;
    };

    const redis = {
      lrange: async (...args: unknown[]) => {
        calls.push({ name: 'lrange', args });
        return execute('lrange', ...args);
      },
      hmget: async (...args: unknown[]) => {
        calls.push({ name: 'hmget', args });
        return execute('hmget', ...args);
      },
      hgetall: async (...args: unknown[]) => {
        calls.push({ name: 'hgetall', args });
        return execute('hgetall', ...args);
      },
      lrem: async (...args: unknown[]) => {
        calls.push({ name: 'lrem', args });
        return execute('lrem', ...args);
      },
      pipeline: () => makeFakePipeline(execute, calls, pipelineCalls),
    } as unknown as Redis;

    const scheduler = new RedisGraphScheduler({
      redisClient: redis,
      keyPrefix: 'ec:',
      enqueueNode: async (_g, nodeId) => {
        enqueuedNodes.push(nodeId);
      },
    });

    const count = await scheduler.drainOutbox('g_drain');
    expect(count).toBe(3);
    expect(enqueuedNodes).toEqual(['n1', 'n2', 'n3']);

    // Outputs HMGET happened exactly once with deduplicated input IDs [p1, p2], not per-node
    const outputHmgets = calls.filter((c) => c.name === 'hmget' && String(c.args[0]).endsWith(':outputs'));
    expect(outputHmgets).toHaveLength(1);
    expect(outputHmgets[0].args.slice(1)).toEqual(['p1', 'p2']);

    // Outbox removals went in 1 batched pipeline instead of 3 sequential lrems
    expect(pipelineCalls.count).toBe(1);
    expect(calls.filter((c) => c.name === 'lrem')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'pipe:lrem').map((c) => c.args[2])).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('Q-4 & Q-5: queue pipeline round trips, oldestWaitingSince Lua, cross-queue lookup, concurrency count', () => {
  it('DistributedBullMQAdapter pipelines getJobCounts, getJobs, publishEvent, and batches oldestWaitingSince + _recoverStalledJobs', async () => {
    const calls: RecordedCommand[] = [];
    const pipelineCalls = { count: 0 };
    const hashes: Record<string, Record<string, string>> = {
      'ec:{q}:job:j1': {
        id: 'j1',
        name: 'convert',
        data: '{"userId":"u1"}',
        opts: '{}',
        state: 'waiting',
        timestamp: '1000',
        attemptsMade: '0',
        progress: '0',
      },
      'ec:{q}:job:dead1': {
        id: 'dead1',
        name: 'convert',
        data: '{"userId":"u1"}',
        opts: '{"attempts":1}',
        state: 'failed',
        timestamp: '1000',
        attemptsMade: '1',
        progress: '0',
      },
      'ec:{q}:job:dead2': {
        id: 'dead2',
        name: 'convert',
        data: '{"userId":"u2"}',
        opts: '{"attempts":1}',
        state: 'failed',
        timestamp: '1001',
        attemptsMade: '1',
        progress: '0',
      },
    };

    const execute = (name: string, ...args: unknown[]): unknown => {
      if (name === 'zcard') return String(args[0]).includes('delayed') ? 2 : 5;
      if (name === 'scard') return String(args[0]).includes('completed') ? 9 : 1;
      if (name === 'zrange') return ['j1'];
      if (name === 'smembers') return [];
      if (name === 'hgetall') return hashes[String(args[0])] ?? {};
      if (name === 'publish') return 1;
      if (name === 'rpush' || name === 'ltrim') return 1;
      if (name === 'eval') {
        const script = String(args[0]);
        if (script === OLDEST_WAITING_SINCE_LUA_SCRIPT) return 42_000;
        if (script === RECOVER_STALLED_JOBS_LUA_SCRIPT) return [[], ['dead1', 'dead2']];
      }
      return null;
    };

    const redis = {
      status: 'ready',
      on: vi.fn(),
      eval: async (...args: unknown[]) => {
        calls.push({ name: 'eval', args });
        return execute('eval', ...args);
      },
      hgetall: async (...args: unknown[]) => {
        calls.push({ name: 'hgetall', args });
        return execute('hgetall', ...args);
      },
      rpush: async (...args: unknown[]) => {
        calls.push({ name: 'rpush', args });
        return 1;
      },
      ltrim: async (...args: unknown[]) => {
        calls.push({ name: 'ltrim', args });
        return 1;
      },
      publish: async (...args: unknown[]) => {
        calls.push({ name: 'publish', args });
        return 1;
      },
      pipeline: () => makeFakePipeline(execute, calls, pipelineCalls),
    } as unknown as Redis;

    const adapter = new DistributedBullMQAdapter<{ userId: string }, unknown>('q', {
      redisClient: redis,
      keyPrefix: 'ec:',
    });

    // getJobCounts: 1 pipeline trip
    const counts = await adapter.getJobCounts();
    expect(counts).toEqual({ waiting: 5, active: 1, completed: 9, failed: 1, delayed: 2, cancelled: 1 });
    expect(pipelineCalls.count).toBe(1);

    // getJobs: 1 pipeline for member sets + 1 pipeline for readJobHashes
    calls.length = 0;
    pipelineCalls.count = 0;
    const jobs = await adapter.getJobs(['waiting', 'delayed', 'completed']);
    expect(jobs.map((j) => j.id)).toEqual(['j1']);
    expect(pipelineCalls.count).toBe(2);

    // oldestWaitingSince: 1 Lua eval call
    calls.length = 0;
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(await adapter.oldestWaitingSince()).toBe(1_000_000 - 42_000);
    expect(calls.map((c) => c.name)).toEqual(['eval']);

    // _recoverStalledJobs: 1 readJobHashes pipeline instead of 2 sequential hgetalls
    calls.length = 0;
    const dlqSpy = vi.spyOn(adapter, 'moveToDlq').mockResolvedValue(undefined);
    const recovered = await adapter._recoverStalledJobs();
    expect(recovered.map((j) => j.id)).toEqual(['dead1', 'dead2']);
    expect(dlqSpy).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.name === 'hgetall')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'pipe:hgetall')).toHaveLength(2);
    // publishEvent pipelined (2 pipe:publish per job instead of 2 sequential awaits)
    expect(calls.filter((c) => c.name === 'publish')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'pipe:publish')).toHaveLength(4);

    await adapter.close();
  });

  it('conversionQueue cross-queue getJob/cancelJob and concurrency checks avoid duplicate sequential scans and HGETALL', async () => {
    const getCalls: string[] = [];
    vi.spyOn(conversionQueue, 'getJob');
    const lightSpy = vi.spyOn(resourceQueues.light, 'getJob').mockImplementation(async () => {
      getCalls.push('light');
      return undefined;
    });
    const cpuSpy = vi.spyOn(resourceQueues.cpu, 'getJob').mockImplementation(async () => {
      getCalls.push('cpu');
      return undefined;
    });
    const memorySpy = vi.spyOn(resourceQueues.memory, 'getJob').mockImplementation(async () => {
      getCalls.push('memory');
      return undefined;
    });
    const gpuJob = { id: 'gpu-1', name: 'convert', data: {} as never, state: 'waiting' as const, timestamp: 1, attemptsMade: 0, progress: 0 };
    const gpuSpy = vi.spyOn(resourceQueues.gpu, 'getJob').mockImplementation(async () => {
      getCalls.push('gpu');
      return gpuJob as never;
    });

    const found = await getJobAcrossQueues('gpu-1');
    expect(found?.id).toBe('gpu-1');
    // Each resource queue queried once, not twice through nested allConversionQueues + conversionQueue.getJob
    expect(lightSpy).toHaveBeenCalledTimes(1);
    expect(cpuSpy).toHaveBeenCalledTimes(1);
    expect(memorySpy).toHaveBeenCalledTimes(1);
    expect(gpuSpy).toHaveBeenCalledTimes(1);
    expect(getCalls).toHaveLength(4);

    const cancelLight = vi.spyOn(resourceQueues.light, 'cancelJob').mockResolvedValue(false);
    const cancelCpu = vi.spyOn(resourceQueues.cpu, 'cancelJob').mockResolvedValue(false);
    const cancelMem = vi.spyOn(resourceQueues.memory, 'cancelJob').mockResolvedValue(false);
    const cancelGpu = vi.spyOn(resourceQueues.gpu, 'cancelJob').mockResolvedValue(true);
    expect(await cancelJobAcrossQueues('gpu-1', 'stop')).toBe(true);
    expect(cancelLight).toHaveBeenCalledTimes(1);
    expect(cancelCpu).toHaveBeenCalledTimes(1);
    expect(cancelMem).toHaveBeenCalledTimes(1);
    expect(cancelGpu).toHaveBeenCalledTimes(1);

    // Concurrency checks use countJobsByUser without hydrating full payloads via getJobsByUser
    const countSpy = vi.spyOn(conversionQueue, 'countJobsByUser').mockResolvedValue(1);
    const listSpy = vi.spyOn(conversionQueue, 'getJobsByUser');
    expect(await mayEnqueue('u-conc', 'free')).toEqual({ allowed: true });
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).not.toHaveBeenCalled();

    const slot = await acquireSyncSlot('u-conc', 'free');
    expect(slot.granted).toBe(true);
    if (slot.granted) slot.release();
    expect(countSpy).toHaveBeenCalledTimes(2);
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe('Q-6: storage stat deduplication in POST /api/v1/jobs and single-GET RemoteStorageBackend.getObject', () => {
  let server: S3StubServer;
  let scratchDir: string;
  let backend: RemoteStorageBackend;

  beforeAll(async () => {
    server = await startS3StubServer({
      bucket: 'opt-bucket',
      credentials: { AKIAOPT0001: 'secret/opt/EXAMPLEKEY0000000001' },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.objects.clear();
    server.uploads.clear();
    server.requests.length = 0;
    server.faults.length = 0;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-q6-opt-'));
    const client = new S3ObjectClient({
      endpoint: server.url,
      region: 'ap-seoul-1',
      bucket: 'opt-bucket',
      accessKeyId: 'AKIAOPT0001',
      secretAccessKey: 'secret/opt/EXAMPLEKEY0000000001',
      providerName: 'oci',
      retryBaseDelayMs: 0,
      requestTimeoutMs: 10_000,
    });
    backend = new RemoteStorageBackend(client, {
      signingSecret: 'q6-signing-secret-0001',
      scratchDir,
    });
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('RemoteStorageBackend.getObject issues 1 GET and 0 HEAD requests for both inline and staged objects', async () => {
    await backend.saveObject('inline/tiny.png', TINY_PNG, 'image/png', 'tiny.png');
    server.requests.length = 0;

    const inlineObj = await backend.getObject('inline/tiny.png');
    expect(inlineObj?.size).toBe(TINY_PNG.length);
    expect(inlineObj?.buffer).toEqual(TINY_PNG);
    expect(server.requests.map((r) => r.method)).toEqual(['GET']);

    // Staged object (> REMOTE_INLINE_OBJECT_MAX_BYTES)
    const stagedSize = REMOTE_INLINE_OBJECT_MAX_BYTES + 4096;
    const stagedPayload = Buffer.alloc(stagedSize, 0x41);
    await backend.saveObject('staged/big.bin', stagedPayload, 'application/octet-stream', 'big.bin');
    server.requests.length = 0;

    const stagedObj = await backend.getObject('staged/big.bin');
    try {
      expect(stagedObj?.size).toBe(stagedSize);
      expect(stagedObj?.filePath).toBeTruthy();
      expect(fs.statSync(stagedObj!.filePath!).size).toBe(stagedSize);
      expect(server.requests.map((r) => r.method)).toEqual(['GET']);
    } finally {
      await stagedObj?.release?.();
    }
  });

  it('RemoteStorageBackend.getObject cleans up stream on expired objects and rejects oversized inline read', async () => {
    await backend.saveObject('ttl/exp.txt', Buffer.from('bye'), 'text/plain', 'exp.txt', 60_000);
    server.objects.get('ttl/exp.txt')!.metadata!['expires-at'] = String(Date.now() - 10_000);
    server.requests.length = 0;

    expect(await backend.getObject('ttl/exp.txt')).toBeUndefined();
    expect(server.requests.map((r) => r.method)).toEqual(['GET', 'DELETE']);

    const oversizedStream = Readable.from([Buffer.from('chunk')]);
    const destroySpy = vi.spyOn(oversizedStream, 'destroy');
    const fakeClient = {
      getObject: vi.fn().mockResolvedValue({
        key: 'huge.bin',
        size: REMOTE_STAGED_OBJECT_MAX_BYTES + 1,
        contentType: 'application/octet-stream',
        etag: '"abc"',
        metadata: {},
        stream: oversizedStream,
      }),
    } as unknown as S3ObjectClient;
    const rejectingBackend = new RemoteStorageBackend(fakeClient, {
      signingSecret: 'q6-signing-secret-0001',
      scratchDir,
    });
    await expect(rejectingBackend.getObject('huge.bin')).rejects.toBeInstanceOf(StorageAdapterError);
    expect(destroySpy).toHaveBeenCalled();

    // Ensure PayloadTooLargeForMemoryError class remains reachable for inline-limit callers while staging handles >16MiB safely.
    expect(PayloadTooLargeForMemoryError.name).toBe('PayloadTooLargeForMemoryError');
  });

  it('POST /api/v1/jobs stats each pre-uploaded storageKey at most once and 0 times for multipart uploads', async () => {
    const email = `q6_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@opt.test`;
    const user = userStore.sanitizeUser(await userStore.createUser({ emailVerified: true, email, name: 'Q6', tier: 'paid' }));
    const cookie = `easyconvert_session=${createSessionToken(user)}`;
    const storageKey = `conversions/${user.id}/${Date.now()}_sample.png`;

    await s3Storage.saveObject(storageKey, TINY_PNG, 'image/png', 'sample.png');
    const statSpy = vi.spyOn(s3Storage, 'stat');
    const addSpy = vi.spyOn(resourceQueues.light, 'add').mockResolvedValue({
      id: 'job_q6_mock',
      name: 'convert',
      data: {} as never,
      state: 'waiting',
      timestamp: Date.now(),
      attemptsMade: 0,
      progress: 0,
    } as never);

    const jsonReq = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        storageKey,
        fileName: 'sample.png',
        sourceFormat: 'png',
        targetFormat: 'webp',
      }),
    });
    const res1 = await v1JobsPost(jsonReq);
    expect(res1.status).toBe(202);
    expect(statSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledTimes(1);

    statSpy.mockClear();
    const form = new FormData();
    form.append('file', new File([TINY_PNG], 'sample.png', { type: 'image/png' }));
    form.append('sourceFormat', 'png');
    form.append('targetFormat', 'webp');
    const uploadReq = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    });

    const res2 = await v1JobsPost(uploadReq);
    expect(res2.status).toBe(202);
    expect(statSpy).not.toHaveBeenCalled();

    // Clean up stored input object created by the multipart upload as well.
    const body2 = (await res2.json()) as { jobId?: string };
    expect(typeof body2.jobId).toBe('string');
    s3Storage.deleteObject(storageKey);
  });
});
