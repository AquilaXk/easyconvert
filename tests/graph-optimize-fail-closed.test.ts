import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { graphScheduler } from '../src/lib/queue/graph';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { OPTIMIZERS } from '../src/lib/conversions/optimizers';
import { UnsupportedOptionError } from '../src/lib/types';
import type { Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * `optimize` must never report an unchanged file or a default re-encode as optimised. Until a format
 * has a registered optimiser, a graph that optimises it is refused with a 422 problem before any
 * job is enqueued, and the executor refuses the node too if validation was bypassed.
 */
const ARTIFACT_TTL_MS = 60 * 60 * 1000;
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function nodeJob(inputArtifacts: string[], options: Record<string, unknown> = {}) {
  const graphId = `g_opt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return {
    id: `${graphId}:n1`,
    data: {
      jobId: `${graphId}:n1`,
      sourceFormat: 'bin',
      targetFormat: 'bin',
      fileSize: 0,
      options: {},
      graphId,
      graphNodeId: 'n1',
      graphNode: { op: 'optimize', input: 'src', options },
      inputArtifacts,
    },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

describe('optimize fails closed for formats without an optimiser', () => {
  let authHeaders: Record<string, string>;
  let userId: string;
  let initGraph: MockInstance<typeof graphScheduler.initGraph>;

  beforeEach(async () => {
    const email = `optimize_${Date.now()}_${Math.random().toString(36).slice(2)}@optimize.test`;
    const user = await userStore.createUser({ email, name: 'optimize', tier: 'pro' });
    userId = user.id;
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'optimize', { scopes: ['convert:read', 'convert:write'] });
    authHeaders = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
    initGraph = vi.spyOn(graphScheduler, 'initGraph');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function submitOptimize(filename: string, bytes: Buffer, mime: string) {
    const storageKey = `uploads/${userId}/${filename}`;
    s3Storage.saveObject(storageKey, bytes, mime, filename);
    const quotaBefore = JSON.stringify(await redisKeyStore.getQuotaUsage(userId));
    const res = await createJob(
      new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          storageKey,
          filename,
          graph: {
            nodes: {
              src: { op: 'import.upload', storageKey },
              opt: { op: 'optimize', input: 'src' },
              out: { op: 'export.internal', input: 'opt' },
            },
          },
        }),
      })
    );
    const json = await res.json();
    const quotaUnchanged = quotaBefore === JSON.stringify(await redisKeyStore.getQuotaUsage(userId));
    return { res, json, quotaUnchanged };
  }

  it.each([
    ['pdf', 'doc.pdf', PDF_BYTES, 'application/pdf'],
    ['png', 'pic.png', PNG_SIGNATURE, 'image/png'],
    ['jpg', 'pic.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'],
  ])('answers a 422 problem for %s at submission and enqueues nothing', async (format, filename, bytes, mime) => {
    const { res, json, quotaUnchanged } = await submitOptimize(filename, bytes, mime);

    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(json.type).toBe('https://api.easyconvert.io/problems/unprocessable-entity');
    expect(json.status).toBe(422);
    expect(json.detail).toContain(`optimize is not available for ${format}`);
    expect(json.detail).toContain('No format has an optimiser yet');
    expect(json.detail).toContain('conversion options');
    expect(json.invalidParams).toEqual([
      { name: 'nodes.opt', reason: expect.stringContaining(`optimize is not available for ${format}`) },
    ]);
    expect(initGraph).not.toHaveBeenCalled();
    expect(quotaUnchanged).toBe(true);
  });

  it('refuses the node in the executor when validation is bypassed and stores no output', async () => {
    const artifactPath = 'intermediate/g_opt_bypass/src.pdf';
    s3Storage.saveObject(artifactPath, PDF_BYTES, 'application/pdf', 'src.pdf', ARTIFACT_TTL_MS);
    const job = nodeJob([artifactPath]);

    const error = await processGraphNodeJob(job, undefined, s3Storage).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect((error as Error).message).toContain('optimize is not available for pdf');
    expect((error as Error).message).toContain('No format has an optimiser yet');
    const stored = await s3Storage.getObject(artifactPath);
    expect(createHash('sha256').update(stored!.buffer).digest('hex')).toBe(createHash('sha256').update(PDF_BYTES).digest('hex'));
    expect(await s3Storage.getObject(`intermediate/${job.data.graphId}/n1/src.pdf`)).toBeUndefined();
  });

  it('keeps the registry empty so no format is reported optimised', () => {
    expect([...OPTIMIZERS.keys()]).toEqual([]);
  });
});
