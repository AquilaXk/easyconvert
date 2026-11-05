import { describe, it, expect } from 'vitest';
import { Queue, type JobOptions } from '../src/lib/queue/bullmq-engine';
import { conversionQueue, resourceQueues } from '../src/lib/queue/conversion-queue';
import { enqueueConversionJob, endedJobRetentionMs } from '../src/lib/queue/enqueue';

const AGE_SECONDS = 60;

async function endJob(queue: Queue<{ userId: string; name: string }, string>, name: string, opts: JobOptions, endedAgoMs: number, outcome: 'completed' | 'failed') {
  const job = await queue.add('convert', { userId: 'u1', name }, opts);
  const active = queue._popNextWaiting();
  expect(active?.id).toBe(job.id);
  if (outcome === 'completed') queue._onJobCompleted(job, name);
  else queue._onJobFailed(job, new Error(name));
  job.state = outcome;
  job.finishedOn = Date.now() - endedAgoMs;
  return job;
}

describe('In-process queue: ended jobs kept as KeepJobs says', () => {
  it('removes completed jobs older than age when a later job completes, and keeps younger ones and other states', async () => {
    const queue = new Queue<{ userId: string; name: string }, string>('keep-age');
    const keep = { removeOnComplete: { age: AGE_SECONDS }, removeOnFail: { age: AGE_SECONDS } };
    const old = await endJob(queue, 'old', keep, AGE_SECONDS * 1000 + 1, 'completed');
    const oldFailed = await endJob(queue, 'old-failed', keep, AGE_SECONDS * 1000 + 1, 'failed');
    const young = await endJob(queue, 'young', keep, 1000, 'completed');
    await endJob(queue, 'last', keep, 0, 'completed');

    expect(await queue.getJob(old.id)).toBeUndefined();
    expect(await queue.getJob(young.id)).toBeDefined();
    expect(await queue.getJob(oldFailed.id)).toBeDefined();
    expect((await queue.getJobsByUser('u1')).map((job) => job.data.name).sort()).toEqual(['last', 'old-failed', 'young']);
  });

  it('removes the job itself for true, keeps the newest for a count, and keeps all when unset', async () => {
    const queue = new Queue<{ userId: string; name: string }, string>('keep-count');
    const removed = await endJob(queue, 'removed', { removeOnComplete: true }, 0, 'completed');
    expect(await queue.getJob(removed.id)).toBeUndefined();

    const first = await endJob(queue, 'first', {}, 3000, 'completed');
    await endJob(queue, 'second', {}, 2000, 'completed');
    expect(await queue.getJob(first.id)).toBeDefined();
    await endJob(queue, 'third', { removeOnComplete: 1 }, 1000, 'completed');
    expect((await queue.getJobs(['completed'])).map((job) => job.data.name)).toEqual(['third']);
  });

  it('clean of failed jobs also removes the dead letters recorded before the grace', async () => {
    const queue = new Queue<{ userId: string; name: string }, string>('keep-dlq');
    const failed = await endJob(queue, 'failed', {}, AGE_SECONDS * 1000 + 1, 'failed');
    await queue.moveToDlq(failed, 'failed');
    (await queue.getDlqEntries())[0].timestamp = Date.now() - AGE_SECONDS * 1000 - 1;

    expect(await queue.clean(AGE_SECONDS * 1000, 10, 'failed')).toEqual([failed.id]);
    expect(await queue.getDlqEntries()).toEqual([]);
  });

  it('delegates completion and failure through conversionQueue to the owning resourceQueue so KeepJobs runs on it', async () => {
    const completedResult = (jobId: string) => ({
      jobId,
      status: 'completed' as const,
      resultKey: `results/${jobId}/0/out.json`,
      downloadUrl: `/api/storage/file/results%2F${jobId}%2F0%2Fout.json`,
      filename: 'out.json',
      mimeType: 'application/json',
      size: 2,
      durationMs: 1,
    });
    const oldCompleted = await enqueueConversionJob(
      resourceQueues.light,
      'convert',
      { jobId: '', originalFilename: 'old-ok.csv', sourceFormat: 'csv', targetFormat: 'json', fileSize: 4, options: {}, userId: 'u-routed' },
      { attempts: 1 },
      { tier: 'free', inputBytes: 4 }
    );
    const poppedOldOk = await conversionQueue._popNextWaiting?.();
    expect(poppedOldOk?.id).toBe(oldCompleted.id);
    expect(await conversionQueue._onJobCompleted?.(poppedOldOk!, completedResult(oldCompleted.id))).toBe(true);
    oldCompleted.state = 'completed';
    oldCompleted.finishedOn = Date.now() - endedJobRetentionMs() - 1000;

    const latestCompleted = await enqueueConversionJob(
      resourceQueues.light,
      'convert',
      { jobId: '', originalFilename: 'new-ok.csv', sourceFormat: 'csv', targetFormat: 'json', fileSize: 4, options: {}, userId: 'u-routed' },
      { attempts: 1 },
      { tier: 'free', inputBytes: 4 }
    );
    const poppedNewOk = await conversionQueue._popNextWaiting?.();
    expect(poppedNewOk?.id).toBe(latestCompleted.id);
    expect(await conversionQueue._onJobCompleted?.(poppedNewOk!, completedResult(latestCompleted.id))).toBe(true);
    expect(await resourceQueues.light.getJob(oldCompleted.id)).toBeUndefined();
    await conversionQueue.remove(latestCompleted.id);

    const oldFailed = await enqueueConversionJob(
      resourceQueues.light,
      'convert',
      { jobId: '', originalFilename: 'old-fail.csv', sourceFormat: 'csv', targetFormat: 'json', fileSize: 4, options: {}, userId: 'u-routed' },
      { attempts: 1 },
      { tier: 'free', inputBytes: 4 }
    );
    const poppedOldFail = await conversionQueue._popNextWaiting?.();
    expect(poppedOldFail?.id).toBe(oldFailed.id);
    expect(await conversionQueue._onJobFailed?.(poppedOldFail!, new Error('failed'))).toBe(true);
    oldFailed.state = 'failed';
    oldFailed.finishedOn = Date.now() - endedJobRetentionMs() - 1000;

    const latestFailed = await enqueueConversionJob(
      resourceQueues.light,
      'convert',
      { jobId: '', originalFilename: 'new-fail.csv', sourceFormat: 'csv', targetFormat: 'json', fileSize: 4, options: {}, userId: 'u-routed' },
      { attempts: 1 },
      { tier: 'free', inputBytes: 4 }
    );
    const poppedNewFail = await conversionQueue._popNextWaiting?.();
    expect(poppedNewFail?.id).toBe(latestFailed.id);
    expect(await conversionQueue._onJobFailed?.(poppedNewFail!, new Error('failed'))).toBe(true);
    expect(await resourceQueues.light.getJob(oldFailed.id)).toBeUndefined();
    await conversionQueue.remove(latestFailed.id);
    expect(await conversionQueue.getJobsByUser('u-routed')).toEqual([]);
  });
});
