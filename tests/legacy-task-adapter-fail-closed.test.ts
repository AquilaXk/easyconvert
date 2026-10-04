import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { linearTasksToJobGraph, JobGraphValidationError } from '../src/lib/jobs/graph';
import { linearTasksToGraph } from '../src/lib/queue/graph/adapter';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { PipelineTask } from '../src/lib/types';

/**
 * Legacy linear `tasks` must not be completed with invented values: a missing export URL used
 * to become a fixed third-party URL (customer data sent elsewhere), BYOS exports became a URL
 * on an unrelated host, and a missing or unknown operation became a PDF conversion.
 */

const SOURCE = { storageKey: 'uploads/u/report.csv', filename: 'report.csv' };
const DESTINATION = 'https://customer-destination.example.org/upload/report.json';

function codesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(JobGraphValidationError);
    return (err as JobGraphValidationError).errors.map((e) => e.code);
  }
  throw new Error('expected the adapter to reject the tasks');
}

const ADAPTERS: [string, (tasks: PipelineTask[]) => unknown][] = [
  ['jobs adapter', (tasks) => linearTasksToJobGraph(SOURCE, tasks)],
  ['queue adapter', (tasks) => linearTasksToGraph(SOURCE, tasks)],
];

describe.each(ADAPTERS)('%s rejects incomplete legacy tasks', (_name, adapt) => {
  it('rejects export/url without a destination URL', () => {
    expect(codesOf(() => adapt([{ name: 'out', operation: 'export/url' } as PipelineTask]))).toEqual([
      'MISSING_EXPORT_URL',
    ]);
  });

  it('rejects storage-provider exports that pipelines cannot execute', () => {
    for (const operation of ['export/s3', 'export/gcs', 'export/azure', 'export/sftp', 'export/webdav']) {
      expect(codesOf(() => adapt([{ name: 'out', operation, url: DESTINATION } as PipelineTask]))).toEqual([
        'BYOS_OPERATION_UNSUPPORTED',
      ]);
    }
  });

  it('rejects convert without a target format', () => {
    expect(codesOf(() => adapt([{ name: 'c', operation: 'convert' } as PipelineTask]))).toEqual([
      'MISSING_TARGET_FORMAT',
    ]);
  });

  it('rejects unknown operations instead of converting to PDF', () => {
    expect(codesOf(() => adapt([{ name: 'x', operation: 'teleport', targetFormat: 'json' } as unknown as PipelineTask]))).toEqual([
      'UNSUPPORTED_OPERATION',
    ]);
  });

  it('keeps the caller-provided destination and target format', () => {
    const graph = adapt([
      { name: 'c', operation: 'convert', targetFormat: 'json' } as PipelineTask,
      { name: 'out', operation: 'export/url', url: DESTINATION } as PipelineTask,
    ]) as { nodes: Record<string, { op: string; url?: string; targetFormat?: string }> };
    const nodes = Object.values(graph.nodes);
    expect(nodes.find((n) => n.op === 'convert')?.targetFormat).toBe('json');
    expect(nodes.find((n) => n.op === 'export.url')?.url).toBe(DESTINATION);
  });
});

describe('POST /api/v1/jobs with incomplete legacy tasks', () => {
  it('answers 422 before reserving quota', async () => {
    const email = `tasks_${Date.now()}_${Math.random().toString(36).slice(2)}@tasks.test`;
    const user = await userStore.createUser({ email, name: 'tasks', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'tasks', { scopes: ['convert:write'] });
    const usedBefore = (await redisKeyStore.getQuotaUsage(user.id)).usedToday;

    const res = await createJob(
      new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({
          filename: 'report.csv',
          targetFormat: 'json',
          inputBufferBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
          tasks: [
            { name: 'c', operation: 'convert', targetFormat: 'json' },
            { name: 'out', operation: 'export/url' },
          ],
        }),
      })
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.invalidParams.map((p: { reason: string }) => p.reason).join(' ')).toMatch(/export URL/i);
    expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(usedBefore);
  });
});
