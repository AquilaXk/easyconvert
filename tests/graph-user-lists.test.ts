import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as queueJobsGet } from '../src/app/api/queue/jobs/route';
import { GET as v1JobsGet } from '../src/app/api/v1/jobs/route';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';
import { conversionQueue, resourceQueues } from '../src/lib/queue/conversion-queue';
import { enqueueConversionJob } from '../src/lib/queue/enqueue';
import { graphScheduler } from '../src/lib/queue/graph/scheduler';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';

/**
 * A graph is the job a client runs, charges and cancels, so the lists of jobs name it by its own id, next to the queue jobs
 * of the caller and merged with them newest first. Its nodes stay out of the lists (graph-node-jobs-hidden-from-lists.test.ts).
 */

let user: User;
let other: User;
let cookie: Record<string, string>;

async function account(label: string): Promise<User> {
  return userStore.sanitizeUser(await userStore.createUser({ name: label, email: `${label}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@graph-lists.test`, tier: 'pro' }));
}

beforeEach(async () => {
  user = await account('lister');
  other = await account('other');
  cookie = { Cookie: `easyconvert_session=${createSessionToken(user)}` };
});

async function graphOf(owner: User, name: string, createdAt: number): Promise<string> {
  const graphId = `graph_lists_${crypto.randomBytes(6).toString('hex')}`;
  await graphScheduler.initGraph(
    graphId,
    sealGraph(graphId, { nodes: { upload: { op: 'import.upload', storageKey: `conversions/${owner.id}/${name}` }, convert: { op: 'convert', input: 'upload', targetFormat: 'json' } } }),
    { ownerUserId: owner.id, originalFilename: name, sourceFormat: 'csv', targetFormat: 'json', createdAt }
  );
  return graphId;
}

async function plainJob(name: string) {
  return enqueueConversionJob(
    conversionQueue,
    'convert',
    { jobId: '', originalFilename: name, sourceFormat: 'csv', targetFormat: 'json', fileSize: 4, options: {}, userId: user.id },
    { attempts: 1 },
    { tier: 'pro', inputBytes: 4 }
  );
}

const web = async (query = '') => (await queueJobsGet(new NextRequest(`http://localhost/api/queue/jobs${query}`, { headers: cookie }))).json();
const api = async (query = '') => (await v1JobsGet(new NextRequest(`http://localhost/api/v1/jobs${query}`, { headers: cookie }))).json();

describe('the lists of jobs and the graphs of a caller', () => {
  it('name a running graph by its own id in the web list and the API list, with the fields of a job', async () => {
    const graphId = await graphOf(user, 'scores.csv', Date.now());

    const webList = await web();
    const apiList = await api();

    expect(webList.jobs.find((entry: { id: string }) => entry.id === graphId)).toMatchObject({
      id: graphId,
      name: 'graph',
      state: 'active',
      progress: 0,
      originalFilename: 'scores.csv',
      targetFormat: 'json',
      timestamp: expect.any(Number),
    });
    expect(apiList.jobs.find((entry: { jobId: string }) => entry.jobId === graphId)).toMatchObject({
      jobId: graphId,
      status: 'active',
      progress: 0,
      sourceFormat: 'csv',
      targetFormat: 'json',
      originalFilename: 'scores.csv',
      createdAt: expect.any(Number),
    });
    expect(webList.total).toBe(webList.jobs.length);
    expect(apiList.total).toBe(apiList.jobs.length);
    expect(webList.jobs.map((entry: { id: string }) => entry.id)).not.toContain(`${graphId}:upload`);
  });

  it('merge the graphs with the queue jobs newest first, and keep the page to its limit', async () => {
    const job = await plainJob('plain.csv');
    const older = await graphOf(user, 'older.csv', job.timestamp - 10_000);
    const newer = await graphOf(user, 'newer.csv', job.timestamp + 10_000);

    expect((await api('?limit=50')).jobs.map((entry: { jobId: string }) => entry.jobId)).toEqual([newer, job.id, older]);
    expect((await api('?limit=2')).jobs.map((entry: { jobId: string }) => entry.jobId)).toEqual([newer, job.id]);
    expect((await web()).jobs.map((entry: { id: string }) => entry.id)).toEqual([newer, job.id, older]);
  });

  it('leave out the graphs of another account', async () => {
    const mine = await graphOf(user, 'mine.csv', Date.now());
    const theirs = await graphOf(other, 'theirs.csv', Date.now());

    const ids = (await api()).jobs.map((entry: { jobId: string }) => entry.jobId);

    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('give a graph that ended its status, and filter by it', async () => {
    const running = await graphOf(user, 'running.csv', Date.now());
    const cancelled = await graphOf(user, 'cancelled.csv', Date.now() + 1);
    await graphScheduler.cancelGraph(cancelled, 'Cancelled by user');

    const onlyCancelled = await api('?status=cancelled');
    const onlyWaiting = await api('?status=waiting');
    const onlyCompleted = await api('?status=completed');

    expect(onlyCancelled.jobs.map((entry: { jobId: string }) => entry.jobId)).toEqual([cancelled]);
    expect(onlyCancelled.jobs[0]).toMatchObject({ status: 'cancelled', finishedOn: expect.any(Number) });
    expect(onlyWaiting.jobs.map((entry: { jobId: string }) => entry.jobId)).toContain(running);
    expect(onlyCompleted.jobs.map((entry: { jobId: string }) => entry.jobId)).not.toContain(running);
    expect((await web('?status=cancelled')).jobs.map((entry: { id: string }) => entry.id)).toEqual([cancelled]);
    expect((await web('?status=active')).jobs.map((entry: { id: string }) => entry.id)).toContain(running);
  });

  it('read the graphs once per list request, however small the page', async () => {
    await plainJob('only.csv');
    await graphOf(user, 'a.csv', Date.now());
    await graphOf(user, 'b.csv', Date.now() + 1);
    const graphReads = vi.spyOn(graphScheduler, 'listGraphsOfUser');
    const queueReads = [conversionQueue, ...Object.values(resourceQueues)].map((queue) => vi.spyOn(queue, 'getJobsByUser'));

    await web();
    await api('?limit=1');

    expect(graphReads).toHaveBeenCalledTimes(2);
    for (const read of queueReads) expect(read).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
