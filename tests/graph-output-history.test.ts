import { describe } from 'vitest';
import { itRecordsTheFinalOutputsOfACompletedGraph } from './helpers/graph-output-history-cases';
import { InMemoryGraphScheduler } from '../src/lib/queue/graph/in-memory-scheduler';

describe('the final outputs of a completed graph in the file history, with the scheduler of this process', () => {
  itRecordsTheFinalOutputsOfACompletedGraph(() => new InMemoryGraphScheduler());
});
