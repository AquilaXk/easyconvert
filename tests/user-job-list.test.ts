import { describe, expect, it } from 'vitest';
import { Queue } from '../src/lib/queue/bullmq-engine';

/** The in-memory queue lists a user's jobs by states, leaving out the jobs the caller excludes before the page is counted. */
interface Data {
  userId: string;
  name: string;
  graphId?: string;
}

describe('listing the jobs of a user in memory', () => {
  async function seeded() {
    const queue = new Queue<Data, string>('list');
    for (let n = 0; n < 12; n += 1) {
      const job = await queue.add('convert', { userId: 'u1', name: `j${n}`, ...(n % 3 === 0 ? { graphId: 'g' } : {}) });
      job.timestamp = n + 1;
      job.state = n % 2 === 0 ? 'completed' : 'waiting';
    }
    await queue.add('convert', { userId: 'u2', name: 'other' });
    return queue;
  }

  it('counts the page after the exclusion, newest first, and never lists another user', async () => {
    const queue = await seeded();
    const page = await queue.getJobsByUser('u1', undefined, 3, 0, { excludeGraphNodes: true });

    expect(page.map((job) => job.data.name)).toEqual(['j11', 'j10', 'j8']);
    expect((await queue.getJobsByUser('u1', undefined, 3, 3, { excludeGraphNodes: true })).map((job) => job.data.name)).toEqual(['j7', 'j5', 'j4']);
    expect((await queue.getJobsByUser('u1', ['waiting'], 10, 0)).map((job) => job.data.name)).toEqual(['j11', 'j9', 'j7', 'j5', 'j3', 'j1']);
  });
});
