import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { linearTasksToJobGraph, validateJobGraph, JobGraphValidationError, type JobGraph } from '../src/lib/jobs/graph';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { PipelineTask } from '../src/lib/types';

/**
 * A merge combines several inputs. Linear legacy tasks cannot name more than the previous
 * stage, so a merge built from them would pass its single input through unchanged. Both the
 * legacy adapter and the graph validator must reject a merge with fewer than two inputs.
 */

const SOURCE = { storageKey: 'uploads/u/report.pdf', filename: 'report.pdf' };

function adapterCodes(tasks: PipelineTask[]): string[] {
  try {
    linearTasksToJobGraph(SOURCE, tasks);
  } catch (err) {
    expect(err).toBeInstanceOf(JobGraphValidationError);
    return (err as JobGraphValidationError).errors.map((e) => e.code);
  }
  throw new Error('expected the adapter to reject the tasks');
}

function graph(nodes: Record<string, Record<string, unknown>>): JobGraph {
  return { nodes } as unknown as JobGraph;
}

describe('legacy adapter merge tasks', () => {
  it('rejects a merge task, which can only receive the previous stage', () => {
    expect(adapterCodes([{ name: 'join', operation: 'merge', targetFormat: 'pdf' } as unknown as PipelineTask])).toEqual([
      'LEGACY_TASK_MERGE_SINGLE_INPUT',
    ]);
  });

  it('rejects a merge task after a conversion stage', () => {
    expect(
      adapterCodes([
        { name: 'c', operation: 'convert', targetFormat: 'pdf' } as PipelineTask,
        { name: 'join', operation: 'merge', targetFormat: 'pdf' } as unknown as PipelineTask,
      ])
    ).toEqual(['LEGACY_TASK_MERGE_SINGLE_INPUT']);
  });
});

describe('graph validator merge inputs', () => {
  const pdfUpload = (key: string) => ({ op: 'import.upload', storageKey: `uploads/u/${key}.pdf` });

  it('rejects a merge node with a single input', () => {
    const result = validateJobGraph(
      graph({ a: pdfUpload('a'), join: { op: 'merge', input: ['a'], targetFormat: 'pdf' }, out: { op: 'export.internal', input: 'join' } })
    );
    expect(result.errors.map((e) => ({ code: e.code, path: e.path }))).toEqual([
      { code: 'MERGE_INPUTS_INSUFFICIENT', path: 'nodes.join.input' },
    ]);
  });

  it('counts a repeated input once', () => {
    const result = validateJobGraph(
      graph({ a: pdfUpload('a'), join: { op: 'merge', input: ['a', 'a'], targetFormat: 'pdf' }, out: { op: 'export.internal', input: 'join' } })
    );
    expect(result.errors.map((e) => e.code)).toEqual(['MERGE_INPUTS_INSUFFICIENT']);
  });

  it('accepts a merge node with two PDF inputs', () => {
    const result = validateJobGraph(
      graph({
        a: pdfUpload('a'),
        b: pdfUpload('b'),
        join: { op: 'merge', input: ['a', 'b'], targetFormat: 'pdf' },
        out: { op: 'export.internal', input: 'join' },
      })
    );
    expect(result.errors).toEqual([]);
    expect(result.inferredOutputFormats?.join).toBe('pdf');
  });
});

describe('POST /api/v1/jobs with a single-input merge graph', () => {
  it('answers 422 before reserving quota', async () => {
    const email = `merge_${Date.now()}_${Math.random().toString(36).slice(2)}@merge.test`;
    const user = await userStore.createUser({ email, name: 'merge', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'merge', { scopes: ['convert:write'] });
    const usedBefore = (await redisKeyStore.getQuotaUsage(user.id)).usedToday;

    const res = await createJob(
      new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({
          filename: 'sample.pdf',
          inputBufferBase64: readFileSync(join(__dirname, 'fixtures', 'sample.pdf')).toString('base64'),
          graph: {
            nodes: {
              src: { op: 'import.upload', storageKey: 'inline:sample.pdf' },
              join: { op: 'merge', input: ['src'], targetFormat: 'pdf' },
              out: { op: 'export.internal', input: 'join' },
            },
          },
        }),
      })
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.invalidParams).toEqual([{ name: 'nodes.join.input', reason: expect.stringMatching(/at least 2 inputs/) }]);
    expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(usedBefore);
  });
});
