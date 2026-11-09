import { afterEach, describe, expect, it, vi } from 'vitest';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { MAX_RECORDED_OUTPUTS_PER_GRAPH, RECORD_BATCH_SIZE, recordGraphOutputsInHistory } from '../src/lib/queue/graph/graph-history';
import type { GraphExecutionState } from '../src/lib/queue/graph/scheduler-types';
import { storageProvider } from '../src/lib/storage';
import { itRecordsTheFinalOutputsOfACompletedGraph } from './helpers/graph-output-history-cases';
import { InMemoryGraphScheduler } from '../src/lib/queue/graph/in-memory-scheduler';

describe('the final outputs of a completed graph in the file history, with the scheduler of this process', () => {
  itRecordsTheFinalOutputsOfACompletedGraph(() => new InMemoryGraphScheduler());
});

const HANG_GUARD_MS = 10_000;
const OUTPUT_COUNT = MAX_RECORDED_OUTPUTS_PER_GRAPH + 40;
const TIMEOUT_MS = 50;

function stateWithOutputs(count: number): GraphExecutionState {
  const graphId = 'graph_bounded';
  const outputs = Array.from({ length: count }, (_, i) => `results/${graphId}/export/${i}/f${i}.txt`);
  return {
    graphId,
    ownerUserId: 'user-bounded',
    sourceFormat: 'zip',
    graph: { nodes: { export: { op: 'export.internal', input: 'x' } } },
    nodes: { export: { id: 'export', op: 'export.internal', status: 'completed', outputs } },
  } as unknown as GraphExecutionState;
}

describe('the step that records the outputs of a graph is bounded', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records at most the limit of outputs of one graph and logs how many were left out', async () => {
    vi.spyOn(storageProvider, 'stat').mockResolvedValue({ size: 1, filename: 'f.txt' } as never);
    const record = vi.spyOn(redisKeyStore, 'recordUserFile').mockResolvedValue({} as never);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await recordGraphOutputsInHistory(stateWithOutputs(OUTPUT_COUNT));

    expect(record).toHaveBeenCalledTimes(MAX_RECORDED_OUTPUTS_PER_GRAPH);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`${OUTPUT_COUNT - MAX_RECORDED_OUTPUTS_PER_GRAPH} were not put`));
  });

  it('goes on when the history never answers, with what was recorded kept', async () => {
    vi.spyOn(storageProvider, 'stat').mockResolvedValue({ size: 1, filename: 'f.txt' } as never);
    const record = vi.spyOn(redisKeyStore, 'recordUserFile').mockImplementation(() => new Promise<never>(() => undefined));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const started = Date.now();

    await recordGraphOutputsInHistory(stateWithOutputs(OUTPUT_COUNT), { timeoutMs: TIMEOUT_MS });

    expect(Date.now() - started).toBeLessThan(HANG_GUARD_MS);
    expect(record).toHaveBeenCalledTimes(RECORD_BATCH_SIZE);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('took longer than'));
  }, HANG_GUARD_MS);

  it('records compound archive extensions like tar.gz and resolves each branch source format from its upstream import', async () => {
    const graphId = 'graph_multibranch';
    vi.spyOn(storageProvider, 'stat').mockImplementation((async (key: string) => ({
      size: 42,
      filename: key.endsWith('.tar.gz') ? 'bundle.tar.gz' : 'out.pdf',
    })) as never);
    const recorded: Array<Record<string, unknown>> = [];
    vi.spyOn(redisKeyStore, 'recordUserFile').mockImplementation((async (entry: Record<string, unknown>) => {
      recorded.push(entry);
      return entry;
    }) as never);

    const state = {
      graphId,
      ownerUserId: 'user-multibranch',
      sourceFormat: '',
      graph: {
        nodes: {
          up1: { op: 'import.upload', storageKey: 'uploads/u/photo.png' },
          up2: { op: 'import.upload', storageKey: 'uploads/u/report.docx' },
          conv2: { op: 'convert', input: 'up2', targetFormat: 'pdf' },
          arch: { op: 'archive.create', input: ['up1', 'conv2'], targetFormat: 'tar.gz' },
          expPdf: { op: 'export.internal', input: 'conv2' },
          expTarGz: { op: 'export.internal', input: 'arch' },
        },
      },
      nodes: {
        expPdf: { id: 'expPdf', op: 'export.internal', status: 'completed', outputs: [`results/${graphId}/expPdf/0/out.pdf`] },
        expTarGz: { id: 'expTarGz', op: 'export.internal', status: 'completed', outputs: [`results/${graphId}/expTarGz/0/bundle.tar.gz`] },
      },
    } as unknown as GraphExecutionState;

    await recordGraphOutputsInHistory(state);

    expect(recorded).toHaveLength(2);
    expect(recorded.find((r) => r.fileName === 'out.pdf')).toMatchObject({
      fromFormat: 'docx',
      toFormat: 'pdf',
    });
    expect(recorded.find((r) => r.fileName === 'bundle.tar.gz')).toMatchObject({
      fromFormat: 'png',
      toFormat: 'tar.gz',
    });
  });

  it('accepts non-convert DAG graphs (ocr, merge, pdf.rotate-pages, thumbnail, optimize) without top-level targetFormat', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { NextRequest } = await import('next/server');
    const { POST: createJob } = await import('../src/app/api/v1/jobs/route');
    const { userStore } = await import('../src/lib/auth/user-store');

    const pdfBase64 = readFileSync(join(__dirname, 'fixtures', 'sample.pdf')).toString('base64');
    const user = await userStore.createUser({
      email: `dag_fmt_${Date.now()}_${Math.random().toString(36).slice(2)}@dag.test`,
      name: 'dag-fmt',
      tier: 'pro',
    });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'dag-fmt', { scopes: ['convert:write'] });

    const submitGraph = async (graph: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const res = await createJob(
        new NextRequest('https://easyconvert.app/api/v1/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
          body: JSON.stringify({ filename: 'sample.pdf', inputBufferBase64: pdfBase64, graph, ...extra }),
        })
      );
      expect(res.status).toBe(202);
      return res.json();
    };

    const ocrRes = await submitGraph({
      nodes: {
        u: { op: 'import.upload', storageKey: 'inline' },
        o: { op: 'ocr', input: 'u' },
        e: { op: 'export.internal', input: 'o' },
      },
    });
    expect(ocrRes.targetFormat).toBe('pdf');

    const mergeRes = await submitGraph({
      nodes: {
        u1: { op: 'import.upload', storageKey: 'inline' },
        u2: { op: 'import.upload', storageKey: 'inline' },
        m: { op: 'merge', input: ['u1', 'u2'], targetFormat: 'pdf' },
        e: { op: 'export.internal', input: 'm' },
      },
    });
    expect(mergeRes.targetFormat).toBe('pdf');

    const rotateRes = await submitGraph({
      nodes: {
        u: { op: 'import.upload', storageKey: 'inline' },
        r: { op: 'pdf.rotate-pages', input: 'u', options: { rotate: { rotation: 90 } } },
        e: { op: 'export.internal', input: 'r' },
      },
    });
    expect(rotateRes.targetFormat).toBe('pdf');

    const thumbRes = await submitGraph({
      nodes: {
        u: { op: 'import.upload', storageKey: 'inline' },
        t: { op: 'thumbnail', input: 'u', options: { thumbnail: { format: 'png' } } },
        e: { op: 'export.internal', input: 't' },
      },
    });
    expect(thumbRes.targetFormat).toBe('png');

    const optRes = await submitGraph({
      nodes: {
        u: { op: 'import.upload', storageKey: 'inline' },
        opt: { op: 'optimize', input: 'u' },
        e: { op: 'export.internal', input: 'opt' },
      },
    });
    expect(optRes.targetFormat).toBe('pdf');
  });
});

