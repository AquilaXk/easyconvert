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
import { enqueueGraphNodeJob } from '../src/lib/queue/graph/node-jobs';
import { listVisibleJobs } from '../src/lib/queue/user-jobs';

/**
 * A graph is run, charged and cancelled as one job, so the nodes it queues are not jobs of their own to list: they would
 * show as `<graphId>:<nodeId>` entries the owner cannot cancel (409) and the graph's own id answers for.
 */

let user: User;
let cookie: Record<string, string>;

beforeEach(async () => {
  user = userStore.sanitizeUser(await userStore.createUser({ name: 'Lister', email: `list_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@lists.test`, tier: 'pro' }));
  cookie = { Cookie: `easyconvert_session=${createSessionToken(user)}` };
});

async function ownJob(name: string) {
  return enqueueConversionJob(
    conversionQueue,
    'convert',
    { jobId: '', originalFilename: name, sourceFormat: 'csv', targetFormat: 'json', fileSize: 4, options: {}, userId: user.id },
    { attempts: 1 },
    { tier: 'pro', inputBytes: 4 }
  );
}

async function graphNode(graphId: string, nodeId: string) {
  await enqueueGraphNodeJob(graphId, nodeId, { op: 'convert', input: 'upload', targetFormat: 'json' } as never, { ownerUserId: user.id, originalFilename: 'in.csv' }, []);
}

describe('the jobs a caller lists', () => {
  it('leave out the nodes of a graph, in the web list and in the API list', async () => {
    const job = await ownJob('plain.csv');
    await graphNode(`graph_list_${Date.now()}`, 'json');

    const web = await (await queueJobsGet(new NextRequest('http://localhost/api/queue/jobs', { headers: cookie }))).json();
    expect(web.jobs.map((entry: { id: string }) => entry.id)).toEqual([job.id]);
    expect(web.total).toBe(1);

    const api = await (await v1JobsGet(new NextRequest('http://localhost/api/v1/jobs', { headers: cookie }))).json();
    expect(api.jobs.map((entry: { jobId: string }) => entry.jobId)).toEqual([job.id]);
  });

  it('fill the page with the caller\'s own jobs when newer graph nodes would take every place', async () => {
    const older = [await ownJob('one.csv'), await ownJob('two.csv')];
    const graphId = `graph_page_${Date.now()}`;
    for (const node of ['a', 'b', 'c', 'd', 'e']) await graphNode(graphId, node);

    const listed = await listVisibleJobs(user.id, ['waiting', 'active', 'completed', 'failed', 'cancelled'], 2);

    expect(listed.map((job) => job.id).sort()).toEqual(older.map((job) => job.id).sort());
  });

  it('reads each queue once per list request, however small the page and however many nodes come first', async () => {
    await ownJob('only.csv');
    const graphId = `graph_calls_${Date.now()}`;
    for (const node of ['a', 'b', 'c', 'd', 'e']) await graphNode(graphId, node);
    const reads = Object.values(resourceQueues).map((queue) => vi.spyOn(queue, 'getJobsByUser'));
    const merged = vi.spyOn(conversionQueue, 'getJobsByUser');

    const listed = await listVisibleJobs(user.id, ['waiting', 'active', 'completed', 'failed', 'cancelled'], 1);
    await queueJobsGet(new NextRequest('http://localhost/api/queue/jobs', { headers: cookie }));
    await v1JobsGet(new NextRequest('http://localhost/api/v1/jobs?limit=1', { headers: cookie }));

    expect(listed).toHaveLength(1);
    expect(merged).toHaveBeenCalledTimes(3);
    for (const read of reads) expect(read).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });
});
