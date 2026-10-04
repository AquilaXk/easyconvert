import { describe, it, expect } from 'vitest';
import { validateJobGraph, linearTasksToJobGraph, JobGraphValidationError, type JobGraph } from '@/lib/jobs';
import { validateGraph as queueValidateGraph } from '@/lib/queue/graph';
import { GRAPH_OPERATIONS } from '@/lib/jobs/graph-operations';
import { JobGraphSchema } from '@/lib/api/contracts/schemas';
import { processGraphNodeJob } from '@/lib/queue/graph/node-executor';
import type { Job } from '@/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '@/lib/types';

/**
 * A graph either validates into nodes the executor can run as written, or is rejected: no
 * operation alias reaches the executor, and no output format is filled in by the validator.
 */

function graph(nodes: Record<string, Record<string, unknown>>): JobGraph {
  return { nodes } as unknown as JobGraph;
}

function codes(g: JobGraph, options: Parameters<typeof validateJobGraph>[1] = {}): string[] {
  return validateJobGraph(g, options).errors.map((e) => e.code);
}

const upload = { op: 'import.upload', storageKey: 'uploads/u1/report.docx' };
const exportOf = (input: string) => ({ op: 'export.internal', input });

describe('graph validator is the single source of truth', () => {
  it('serves the queue entry point from the same validator', () => {
    expect(queueValidateGraph).toBe(validateJobGraph);
  });

  it('advertises exactly the canonical operations in the API schema', () => {
    const nodeSchema = (JobGraphSchema as any).properties.nodes.additionalProperties;
    expect([...nodeSchema.properties.op.enum].sort()).toEqual([...GRAPH_OPERATIONS].sort());
  });
});

describe('operation normalization', () => {
  it('rewrites legacy spellings and the operation field to the canonical op', () => {
    const result = validateJobGraph(
      graph({
        src: { operation: 'import', storageKey: 'uploads/u1/a.png' },
        thumb: { operation: 'media.thumbnail', input: 'src', targetFormat: 'jpg' },
        out: { op: 'export.internal', input: 'thumb' },
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.normalizedNodes?.src.op).toBe('import.upload');
    expect(result.normalizedNodes?.thumb.op).toBe('thumbnail');
    expect(result.normalizedNodes?.thumb).not.toHaveProperty('operation');
  });

  it('rejects a node without any operation instead of treating it as convert', () => {
    expect(codes(graph({ src: upload, step: { input: 'src', targetFormat: 'pdf' }, out: exportOf('step') }))).toEqual(['MISSING_OPERATION']);
  });

  it('rejects op and operation fields that name different operations', () => {
    expect(
      codes(graph({ src: upload, step: { op: 'convert', operation: 'ocr', input: 'src', targetFormat: 'pdf' }, out: exportOf('step') }))
    ).toEqual(['CONFLICTING_OPERATION']);
  });
});

describe('no invented output formats', () => {
  it.each(['convert', 'merge', 'archive.create', 'thumbnail'])('rejects %s without a target format', (op) => {
    const input = op === 'merge' || op === 'archive.create' ? ['src'] : 'src';
    expect(codes(graph({ src: upload, step: { op, input }, out: exportOf('step') }))).toEqual(['MISSING_TARGET_FORMAT']);
  });

  it('rejects an OCR output format the executor does not produce', () => {
    expect(
      codes(graph({ src: upload, step: { op: 'ocr', input: 'src', options: { ocrFormat: 'txt' } }, out: exportOf('step') }))
    ).toEqual(['UNSUPPORTED_OUTPUT_FORMAT']);
  });

  it('infers the fixed OCR output format', () => {
    const result = validateJobGraph(graph({ src: upload, step: { op: 'ocr', input: 'src' }, out: exportOf('step') }));
    expect(result.errors).toEqual([]);
    expect(result.inferredOutputFormats?.step).toBe('pdf');
  });
});

describe('source format checks fail closed', () => {
  it('rejects a conversion whose uploaded source format cannot be determined', () => {
    expect(
      codes(graph({ src: { op: 'import.upload', storageKey: 'uploads/u1/blob' }, step: { op: 'convert', input: 'src', targetFormat: 'pdf' }, out: exportOf('step') }))
    ).toEqual(['SOURCE_FORMAT_UNKNOWN']);
  });

  it('rejects a conversion from a format the registry does not know', () => {
    expect(
      codes(graph({ src: { op: 'import.upload', storageKey: 'uploads/u1/data.qqq' }, step: { op: 'convert', input: 'src', targetFormat: 'pdf' }, out: exportOf('step') }))
    ).toEqual(['UNKNOWN_SOURCE_FORMAT']);
  });

  it('accepts a known upload format with a supported target', () => {
    const result = validateJobGraph(graph({ src: upload, step: { op: 'convert', input: 'src', targetFormat: 'pdf' }, out: exportOf('step') }));
    expect(result.errors).toEqual([]);
    expect(result.inferredOutputFormats).toMatchObject({ src: 'docx', step: 'pdf', out: 'pdf' });
  });

  it('leaves URL imports without an extension to the runtime check', () => {
    const result = validateJobGraph(
      graph({ src: { op: 'import.url', url: 'https://files.example.org/download' }, step: { op: 'convert', input: 'src', targetFormat: 'pdf' }, out: exportOf('step') })
    );
    expect(result.errors).toEqual([]);
    expect(result.inferredOutputFormats?.src).toBe('dynamic');
  });
});

describe('legacy task translation', () => {
  it('rejects a merge task without a target format instead of merging into PDF', () => {
    expect(() =>
      linearTasksToJobGraph({ storageKey: 'uploads/u1/a.pdf' }, [{ name: 'join', operation: 'merge' } as any])
    ).toThrow(JobGraphValidationError);
  });
});

describe('restricted output formats', () => {
  it.each([
    ['thumbnail', 'src', 'webp'],
    ['merge', ['src'], 'docx'],
    ['archive.create', ['src'], 'tar.zst'],
  ])('rejects %s producing a format it cannot write', (op, input, targetFormat) => {
    expect(codes(graph({ src: upload, step: { op, input, targetFormat }, out: exportOf('step') }))).toEqual(['UNSUPPORTED_OUTPUT_FORMAT']);
  });

  it('rejects merging inputs that are not already in the merged format', () => {
    expect(
      codes(graph({ src: upload, step: { op: 'merge', input: ['src'], targetFormat: 'pdf' }, out: exportOf('step') }))
    ).toEqual(['INCOMPATIBLE_MERGE_INPUT']);
  });

  it('accepts merging converted PDFs', () => {
    const result = validateJobGraph(
      graph({
        src: upload,
        pdf: { op: 'convert', input: 'src', targetFormat: 'pdf' },
        step: { op: 'merge', input: ['pdf'], targetFormat: 'pdf' },
        out: exportOf('step'),
      })
    );
    expect(result.errors).toEqual([]);
  });
});

describe('executor conformance', () => {
  function nodeJob(graphNode: Record<string, unknown>): Job<ConversionJobData, ConversionJobResult> {
    return {
      id: 'g_conf:n1',
      data: {
        jobId: 'g_conf:n1',
        sourceFormat: 'bin',
        targetFormat: 'bin',
        fileSize: 0,
        options: {},
        graphId: 'g_conf',
        graphNodeId: 'n1',
        graphNode,
        inputArtifacts: [],
      },
      opts: { attempts: 1 },
      attemptsMade: 1,
      signal: new AbortController().signal,
      log: async () => {},
      updateProgress: async () => {},
    } as unknown as Job<ConversionJobData, ConversionJobResult>;
  }

  it.each([...GRAPH_OPERATIONS])('dispatches canonical operation %s to a handler', async (op) => {
    const outcome = await processGraphNodeJob(nodeJob({ op, input: 'missing' })).then(
      () => 'completed',
      (err: Error) => err.message
    );
    expect(outcome).not.toMatch(/Unsupported graph node operation/);
  });

  it('refuses a legacy spelling that bypassed validation', async () => {
    await expect(processGraphNodeJob(nodeJob({ op: 'archive/create', input: ['missing'] }))).rejects.toThrow(
      /Unsupported graph node operation: archive\/create/
    );
  });
});
