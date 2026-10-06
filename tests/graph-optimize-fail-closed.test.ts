import { describe, expect, it } from 'vitest';
import { validateJobGraph } from '../src/lib/jobs';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { UnsupportedOptionError } from '../src/lib/types';
import type { JobGraph } from '../src/lib/jobs';
import type { Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { s3Storage } from '../src/lib/storage/s3-storage';

const ARTIFACT_TTL_MS = 60 * 60 * 1000;

function nodeJob(graphNode: Record<string, unknown>, inputArtifacts: string[]) {
  const graphId = `g_opt_${Date.now()}`;
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
      graphNode,
      inputArtifacts,
    },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

describe('Graph optimize fail closed', () => {
  it('refuses optimize on PDF at submission time', () => {
    const graph: JobGraph = {
      nodes: {
        src: { op: 'import.upload', storageKey: 'test.pdf' },
        opt: { op: 'optimize', input: 'src' },
        out: { op: 'export.internal', input: 'opt' }
      }
    } as any;
    
    const result = validateJobGraph(graph);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.message.includes('optimize is not available for pdf'))).toBe(true);
  });
  
  it('fails with UnsupportedOptionError in the executor if validation is bypassed', async () => {
    const artifactPath = `intermediate/g_opt/src.pdf`;
    s3Storage.saveObject(artifactPath, Buffer.from('%PDF-1.4\n'), 'application/pdf', 'src.pdf', ARTIFACT_TTL_MS);
    
    const job = nodeJob({ op: 'optimize', input: 'src' }, [artifactPath]);
    
    let caughtErr: Error | undefined;
    try {
      await processGraphNodeJob(job, undefined, s3Storage);
    } catch (e) {
      caughtErr = e as Error;
    }
    
    expect(caughtErr).toBeDefined();
    expect(caughtErr).toBeInstanceOf(UnsupportedOptionError);
    expect(caughtErr?.message).toMatch(/optimize is not available for pdf/);
  });
});
