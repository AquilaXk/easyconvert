import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { RedisGraphScheduler } from '../src/lib/queue/graph';
import {
  parseGraphMeta,
  parseGraphStatus,
  parseNodeState,
  parseNodeStates,
  parseStoredList,
} from '../src/lib/queue/graph/redis-state-parsers';
import { GraphStateCorruptError } from '../src/lib/types';

/**
 * A scheduler record that is missing a field or holds a value of the wrong type fails its graph with
 * GraphStateCorruptError; nothing is defaulted ('' / 'fail_fast' / 'running' / '{"nodes":{}}').
 * The records below are written by hand, field by field, to the shape the Lua scripts store.
 */

const GRAPH_ID = 'job_1700000000000_graphcorrupt';
const CREATED_AT_MS = '1700000000000';
const TWO_NODE_GRAPH = JSON.stringify({
  nodes: {
    src: { op: 'import.upload', storageKey: 'uploads/u1/a.csv' },
    out: { op: 'export.internal', input: 'src' },
  },
});

/** The graph hash `INIT_GRAPH_LUA_SCRIPT` stores for a two-node graph owned by user u1. */
function validGraphHash(): Record<string, string> {
  return {
    policy: 'fail_fast',
    owner: 'u1',
    reservationId: 'res_1',
    webhookUrl: '',
    webhookSecret: '',
    originalFilename: 'a.csv',
    sourceStorageKey: 'uploads/u1/a.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    tasks: '',
    createdAt: CREATED_AT_MS,
    totalNodes: '2',
    graph: TWO_NODE_GRAPH,
    graphId: GRAPH_ID,
    status: 'running',
    completedNodes: '0',
    failedNodes: '0',
  };
}

function without(record: Record<string, string>, field: string): Record<string, string> {
  const copy = { ...record };
  delete copy[field];
  return copy;
}

describe('parseGraphMeta', () => {
  it('reads a complete record into typed fields', () => {
    const meta = parseGraphMeta(GRAPH_ID, validGraphHash());
    expect(meta).toMatchObject({
      graphId: GRAPH_ID,
      status: 'running',
      policy: 'fail_fast',
      ownerUserId: 'u1',
      reservationId: 'res_1',
      originalFilename: 'a.csv',
      sourceStorageKey: 'uploads/u1/a.csv',
      sourceFormat: 'csv',
      targetFormat: 'json',
      createdAt: 1700000000000,
      totalNodes: 2,
      completedNodes: 0,
      failedNodes: 0,
    });
    expect(meta.webhookUrl).toBeUndefined();
    expect(meta.tasks).toBeUndefined();
    expect(Object.keys(meta.graph.nodes)).toEqual(['src', 'out']);
  });

  it('keeps records written before sourceFormat, targetFormat and tasks existed readable', () => {
    const legacy = without(without(without(validGraphHash(), 'sourceFormat'), 'targetFormat'), 'tasks');
    const meta = parseGraphMeta(GRAPH_ID, legacy);
    expect(meta.sourceFormat).toBeUndefined();
    expect(meta.targetFormat).toBeUndefined();
    expect(meta.tasks).toBeUndefined();
  });

  it.each(['graph', 'status', 'policy', 'createdAt', 'totalNodes', 'completedNodes', 'failedNodes', 'graphId', 'owner', 'reservationId', 'webhookUrl', 'webhookSecret', 'originalFilename', 'sourceStorageKey'])(
    'throws GraphStateCorruptError when "%s" is missing',
    (field) => {
      expect(() => parseGraphMeta(GRAPH_ID, without(validGraphHash(), field))).toThrow(GraphStateCorruptError);
    }
  );

  it('names the graph and the field, but never the stored value', () => {
    const record = { ...validGraphHash(), webhookSecret: 'whsec_top_secret', status: 'exploded' };
    let thrown: unknown;
    try {
      parseGraphMeta(GRAPH_ID, record);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GraphStateCorruptError);
    expect((thrown as GraphStateCorruptError).message).toContain(GRAPH_ID);
    expect((thrown as GraphStateCorruptError).message).toContain('status');
    expect((thrown as GraphStateCorruptError).message).not.toContain('exploded');
    expect((thrown as GraphStateCorruptError).message).not.toContain('whsec_top_secret');
  });

  it.each([
    ['an unknown status', { status: 'exploded' }],
    ['an empty status', { status: '' }],
    ['an unknown policy', { policy: 'fail_job' }],
    ['a non-numeric createdAt', { createdAt: 'yesterday' }],
    ['a negative totalNodes', { totalNodes: '-2' }],
    ['a fractional completedNodes', { completedNodes: '1.5' }],
    ['a non-numeric finishedOn', { finishedOn: 'soon' }],
    ['a graph that is not JSON', { graph: '{nodes:' }],
    ['a graph without nodes', { graph: '{}' }],
    ['a graph whose nodes is an array', { graph: '{"nodes":[]}' }],
    ['a graph node without an op', { graph: '{"nodes":{"src":{"storageKey":"k"}}}' }],
    ['tasks that are not an array', { tasks: '{"op":"convert"}' }],
    ['tasks that are not JSON', { tasks: 'not-json' }],
    ['a graphId of another graph', { graphId: 'job_other' }],
  ])('throws GraphStateCorruptError for %s', (_label, override) => {
    expect(() => parseGraphMeta(GRAPH_ID, { ...validGraphHash(), ...override })).toThrow(GraphStateCorruptError);
  });

  it('parses finishedOn and failedReason of a finished graph', () => {
    const meta = parseGraphMeta(GRAPH_ID, {
      ...validGraphHash(),
      status: 'failed',
      finishedOn: '1700000005000',
      failedReason: 'node out failed',
    });
    expect(meta.status).toBe('failed');
    expect(meta.finishedAt).toBe(1700000005000);
    expect(meta.failedReason).toBe('node out failed');
  });
});

describe('parseGraphStatus', () => {
  it.each(['running', 'completed', 'failed', 'cancelled'])('accepts %s', (status) => {
    expect(parseGraphStatus(GRAPH_ID, status)).toBe(status);
  });

  it.each([undefined, null, '', 'missing', 'RUNNING', 7])('rejects %s', (value) => {
    expect(() => parseGraphStatus(GRAPH_ID, value)).toThrow(GraphStateCorruptError);
  });
});

describe('parseNodeState', () => {
  function nodeJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ id: 'src', op: 'import.upload', status: 'waiting', outputs: [], createdAt: 1700000000000, ...overrides });
  }

  it('reads a node document', () => {
    expect(
      parseNodeState(GRAPH_ID, 'src', nodeJson({ status: 'completed', outputs: ['uploads/u1/a.csv'], startedAt: 5, finishedAt: 9 }))
    ).toEqual({
      id: 'src',
      op: 'import.upload',
      status: 'completed',
      outputs: ['uploads/u1/a.csv'],
      error: undefined,
      startedAt: 5,
      finishedAt: 9,
    });
  });

  it('reads the empty object that cjson stores for an empty output list as an empty list', () => {
    expect(parseNodeState(GRAPH_ID, 'src', '{"id":"src","op":"import.upload","status":"waiting","outputs":{}}').outputs).toEqual([]);
  });

  it.each([
    ['an empty document', ''],
    ['a document that is not JSON', '{"id":'],
    ['a document that is an array', '[]'],
    ['a document of another node', nodeJson({ id: 'out' })],
    ['a missing id', JSON.stringify({ op: 'import.upload', status: 'waiting', outputs: [] })],
    ['a missing op', nodeJson({ op: undefined })],
    ['a missing status', nodeJson({ status: undefined })],
    ['an unknown status', nodeJson({ status: 'running' })],
    ['outputs that are missing', nodeJson({ outputs: undefined })],
    ['outputs that are a string', nodeJson({ outputs: 'uploads/u1/a.csv' })],
    ['outputs with a non-string key', nodeJson({ outputs: [7] })],
    ['a non-string error', nodeJson({ status: 'failed', error: 42 })],
    ['a non-numeric startedAt', nodeJson({ startedAt: 'now' })],
    ['a negative finishedAt', nodeJson({ finishedAt: -1 })],
  ])('throws GraphStateCorruptError for %s', (_label, text) => {
    expect(() => parseNodeState(GRAPH_ID, 'src', text)).toThrow(GraphStateCorruptError);
  });

  it('throws GraphStateCorruptError for a node field that is absent from the hash', () => {
    expect(() => parseNodeState(GRAPH_ID, 'src', undefined)).toThrow(GraphStateCorruptError);
  });
});

describe('parseNodeStates and parseStoredList', () => {
  it('rejects a graph whose node records do not match totalNodes', () => {
    const only = { src: JSON.stringify({ id: 'src', op: 'import.upload', status: 'waiting', outputs: [] }) };
    expect(() => parseNodeStates(GRAPH_ID, only, 2)).toThrow(GraphStateCorruptError);
    expect(Object.keys(parseNodeStates(GRAPH_ID, only, 1))).toEqual(['src']);
  });

  it('reads a stored list, treats {} as empty, and rejects anything else', () => {
    expect(parseStoredList<string>(GRAPH_ID, 'list', '["a","b"]')).toEqual(['a', 'b']);
    expect(parseStoredList<string>(GRAPH_ID, 'list', '{}')).toEqual([]);
    expect(() => parseStoredList(GRAPH_ID, 'list', '{"a":1}')).toThrow(GraphStateCorruptError);
    expect(() => parseStoredList(GRAPH_ID, 'list', 'oops')).toThrow(GraphStateCorruptError);
    expect(() => parseStoredList(GRAPH_ID, 'list', undefined)).toThrow(GraphStateCorruptError);
  });
});

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)('RedisGraphScheduler on a record damaged in a real Redis server', () => {
  let redis: Redis;
  let scheduler: RedisGraphScheduler;
  const keyPrefix = `test_corrupt_${Date.now()}_${Math.random().toString(36).slice(2)}:`;

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    scheduler = new RedisGraphScheduler({ redisClient: redis, keyPrefix });
  });

  afterAll(async () => {
    const keys = await redis.keys(`${keyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await redis.quit();
  });

  async function seed(graphId: string, graphHash: Record<string, string>): Promise<void> {
    const k = scheduler.graphKeys(graphId);
    await redis.hset(k.graph, graphHash);
    await redis.hset(
      k.nodes,
      'src',
      JSON.stringify({ id: 'src', op: 'import.upload', status: 'waiting', outputs: {} }),
      'out',
      JSON.stringify({ id: 'out', op: 'export.internal', status: 'pending', outputs: {} })
    );
  }

  it('reads a well-formed record', async () => {
    await seed('g_ok', { ...validGraphHash(), graphId: 'g_ok' });
    const state = await scheduler.getGraphState('g_ok');
    expect(state?.status).toBe('running');
    expect(state?.nodes.src.status).toBe('waiting');
    expect(state?.nodes.out.outputs).toEqual([]);
  });

  it('fails a graph hash with a missing "graph" field instead of reading an empty graph', async () => {
    await seed('g_nograph', { ...without(validGraphHash(), 'graph'), graphId: 'g_nograph' });
    await expect(scheduler.getGraphState('g_nograph')).rejects.toMatchObject({
      name: 'GraphStateCorruptError',
      message: expect.stringContaining('field "graph" is missing'),
    });
  });

  it('fails a graph hash with an invalid status instead of reading it as running', async () => {
    await seed('g_badstatus', { ...validGraphHash(), graphId: 'g_badstatus', status: 'exploded' });
    await expect(scheduler.getGraphState('g_badstatus')).rejects.toMatchObject({
      name: 'GraphStateCorruptError',
      message: expect.stringContaining('the graph status is missing or unknown'),
    });
  });

  it('fails a node document with an invalid status', async () => {
    await seed('g_badnode', { ...validGraphHash(), graphId: 'g_badnode' });
    await redis.hset(scheduler.graphKeys('g_badnode').nodes, 'src', JSON.stringify({ id: 'src', op: 'import.upload', status: 'bogus', outputs: [] }));
    await expect(scheduler.getGraphState('g_badnode')).rejects.toMatchObject({
      name: 'GraphStateCorruptError',
      message: expect.stringContaining('node "src" field "status" is missing or unknown'),
    });
  });

  it('keeps the outbox entry and enqueues nothing when the graph record is corrupt', async () => {
    const enqueued: string[] = [];
    const guarded = new RedisGraphScheduler({
      redisClient: redis,
      keyPrefix,
      enqueueNode: async (_graphId, nodeId) => {
        enqueued.push(nodeId);
      },
    });
    await seed('g_outbox', { ...without(validGraphHash(), 'graph'), graphId: 'g_outbox' });
    await redis.rpush(guarded.graphKeys('g_outbox').outbox, 'src');
    await expect(guarded.drainOutbox('g_outbox')).rejects.toBeInstanceOf(GraphStateCorruptError);
    expect(enqueued).toEqual([]);
    expect(await redis.lrange(guarded.graphKeys('g_outbox').outbox, 0, -1)).toEqual(['src']);
  });

  it('fails an outbox node that the stored graph does not define', async () => {
    await seed('g_ghost', { ...validGraphHash(), graphId: 'g_ghost' });
    await redis.rpush(scheduler.graphKeys('g_ghost').outbox, 'ghost');
    await expect(scheduler.drainOutbox('g_ghost')).rejects.toBeInstanceOf(GraphStateCorruptError);
    expect(await redis.lrange(scheduler.graphKeys('g_ghost').outbox, 0, -1)).toEqual(['ghost']);
  });

  it('returns undefined, not an error, for a graph that was never stored', async () => {
    await expect(scheduler.getGraphState('g_never_stored')).resolves.toBeUndefined();
  });
});
