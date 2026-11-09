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
});
