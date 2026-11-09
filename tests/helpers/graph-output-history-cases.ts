import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE as deleteFileRoute } from '../../src/app/api/account/files/[id]/route';
import { redisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { createSessionToken } from '../../src/lib/auth/session';
import { userStore } from '../../src/lib/auth/user-store';
import type { User } from '../../src/lib/auth/types';
import { sealGraph } from '../../src/lib/queue/graph/node-jobs';
import type { IGraphScheduler } from '../../src/lib/queue/graph/scheduler-types';
import type { JobGraph } from '../../src/lib/queue/graph/types';
import { storageProvider } from '../../src/lib/storage';
import { saveRetainedResult } from '../../src/lib/storage/retention-service';

/**
 * The final outputs of a completed graph in the history of converted files of its owner (docs/policy-decisions.md, entry 209):
 * recorded once each, never the intermediate files, deletable by the owner for the graph's own keys only, and removed with the
 * account. The same cases run on the scheduler of this process and on a real Redis server.
 */

const GRAPH = {
  failurePolicy: 'fail_fast',
  nodes: {
    upload: { op: 'import.upload', storageKey: 'uploads/graph-history/a.csv' },
    convert: { op: 'convert', input: 'upload', targetFormat: 'json' },
    export: { op: 'export.internal', input: 'convert' },
  },
} as unknown as JobGraph;

export function itRecordsTheFinalOutputsOfACompletedGraph(makeScheduler: () => IGraphScheduler): void {
  let scheduler: IGraphScheduler;
  let owner: User;
  let other: User;
  const storedKeys: string[] = [];

  async function account(label: string): Promise<User> {
    return userStore.sanitizeUser(await userStore.createUser({ name: label, email: `${label}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@graph-history.test`, tier: 'pro' }));
  }

  beforeEach(async () => {
    scheduler = makeScheduler();
    owner = await account('owner');
    other = await account('other');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of storedKeys.splice(0)) await storageProvider.deleteObject(key);
    await redisKeyStore.forgetUsage(owner.id);
    await redisKeyStore.forgetUsage(other.id);
  });

  async function save(key: string, body: string, filename: string): Promise<void> {
    storedKeys.push(key);
    await saveRetainedResult(storageProvider, key, Buffer.from(body), 'application/json', filename);
  }

  /** Runs a graph to the end: the intermediate file of the convert node, and the result the export node keeps. */
  async function completedGraph(ownerUserId: string | undefined) {
    const graphId = `graph_history_${crypto.randomBytes(6).toString('hex')}`;
    await scheduler.initGraph(graphId, sealGraph(graphId, GRAPH), { ownerUserId, sourceFormat: 'csv', targetFormat: 'json' });
    const intermediateKey = `intermediate/${graphId}/convert/0/a.json`;
    const resultKey = `results/${graphId}/export/0/a.json`;
    await save(intermediateKey, '[{"a":1}]', 'a.json');
    await save(resultKey, '[{"a":1}]', 'a.json');
    await scheduler.onNodeCompleted(graphId, 'upload', ['uploads/graph-history/a.csv']);
    await scheduler.onNodeCompleted(graphId, 'convert', [intermediateKey]);
    const done = await scheduler.onNodeCompleted(graphId, 'export', [resultKey]);
    return { graphId, resultKey, intermediateKey, done };
  }

  const asOwner = (id: string, user: User = owner) =>
    deleteFileRoute(new NextRequest(`http://localhost/api/account/files/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` } }), {
      params: Promise.resolve({ id }),
    });

  it('records each final output once under a stable id with the key it lives at, and not the intermediate files', async () => {
    const { graphId, resultKey, done } = await completedGraph(owner.id);

    expect(done.graphCompleted).toBe(true);
    const files = await redisKeyStore.listUserFiles(owner.id);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      id: `${graphId}:export:0`,
      userId: owner.id,
      graphId,
      fileName: 'a.json',
      fromFormat: 'csv',
      toFormat: 'json',
      size: 9,
      storageKey: resultKey,
      downloadUrl: `/api/storage/file/${encodeURIComponent(resultKey)}`,
    });
    expect(files[0].expiresAt).toBeGreaterThan(Date.now());
  });

  it('records the same output once when the completion is reported again', async () => {
    const { graphId } = await completedGraph(owner.id);
    const state = await scheduler.getGraphState(graphId);
    const { recordGraphOutputsInHistory } = await import('../../src/lib/queue/graph/graph-history');

    await recordGraphOutputsInHistory(state!);

    expect(await redisKeyStore.listUserFiles(owner.id)).toHaveLength(1);
  });

  it('records nothing for a graph without an owner or of an anonymous visitor', async () => {
    const spy = vi.spyOn(redisKeyStore, 'recordUserFile');

    await completedGraph(undefined);
    await completedGraph('anon:203.0.113');

    expect(spy).not.toHaveBeenCalled();
  });

  it('does not fail the graph when the history cannot be written', async () => {
    vi.spyOn(redisKeyStore, 'recordUserFile').mockRejectedValue(new Error('history down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { graphId, done } = await completedGraph(owner.id);

    expect(done.graphCompleted).toBe(true);
    expect((await scheduler.getGraphState(graphId))?.status).toBe('completed');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(graphId), expect.any(Error));
  });

  it('lets the owner delete the record and the stored output, and refuses another account', async () => {
    const { graphId, resultKey } = await completedGraph(owner.id);
    const id = `${graphId}:export:0`;

    expect((await asOwner(id, other)).status).toBe(404);
    expect(await storageProvider.getObject(resultKey)).toBeTruthy();

    expect((await asOwner(id)).status).toBe(200);
    expect(await redisKeyStore.listUserFiles(owner.id)).toEqual([]);
    await expect(Promise.resolve(storageProvider.getObject(resultKey))).resolves.toBeFalsy();
  });

  it('refuses to delete a stored object that is not under the results of the graph the record names', async () => {
    const { graphId } = await completedGraph(owner.id);
    const foreignKey = `results/graph_foreign_${crypto.randomBytes(4).toString('hex')}/export/0/b.json`;
    await save(foreignKey, '{}', 'b.json');
    const id = `${graphId}:export:0`;
    await redisKeyStore.recordUserFile({ id, userId: owner.id, graphId, fileName: 'b.json', fromFormat: 'csv', toFormat: 'json', size: 2, downloadUrl: '/x', storageKey: foreignKey });

    expect((await asOwner(id)).status).toBe(404);

    expect(await storageProvider.getObject(foreignKey)).toBeTruthy();
    expect(await redisKeyStore.findUserFile(owner.id, id)).toBeDefined();
  });

  it('removes the records with the account', async () => {
    await completedGraph(owner.id);
    expect(await redisKeyStore.listUserFiles(owner.id)).toHaveLength(1);

    await redisKeyStore.forgetUsage(owner.id);

    expect(await redisKeyStore.listUserFiles(owner.id)).toEqual([]);
  });
}
