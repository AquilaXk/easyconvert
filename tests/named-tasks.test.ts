import { describe, expect, it } from 'vitest';
import { JobCreateRequestSchema, validateOrProblem } from '../src/lib/api/contracts';
import { duplicateKeys } from '../src/lib/jobs/duplicate-keys';
import { validateJobGraph } from '../src/lib/jobs/graph';
import { GRAPH_OPERATIONS } from '../src/lib/jobs/graph-operations';
import {
  NAMED_TASK_OPERATIONS,
  namedTaskNameErrors,
  namedTaskRefusal,
  namedTasksToJobGraph,
  publicOperationName,
  type NamedTaskMap,
} from '../src/lib/jobs/named-tasks';
import { DEPENDENCY_FAILED_CODE, MAX_TASK_RESULT_FILES, namedTaskReports, TASK_FAILED_CODE } from '../src/lib/jobs/named-task-report';
import type { GraphExecutionState, GraphNodeState, NodeExecutionStatus } from '../src/lib/queue/graph/scheduler-types';
import type { JobGraph } from '../src/lib/queue/graph/types';
import en from '../messages/en.json';
import ko from '../messages/ko.json';

const PROBLEM = 'https://api.easyconvert.io/problems/';

/** The tasks of the example in the contract: an import by URL, a conversion that reads it, and an export that reads the conversion. */
const EXAMPLE: NamedTaskMap = {
  'import-1': { operation: 'import/url', url: 'https://files.example.com/report.docx' },
  'convert-1': { operation: 'convert', input: 'import-1', output_format: 'pdf', options: { pages: '1-2' } },
  'export-1': { operation: 'export/url', input: ['convert-1'] },
};

function translated(tasks: NamedTaskMap, uploadKeys: Record<string, string> = {}): JobGraph {
  const result = namedTasksToJobGraph(tasks, uploadKeys);
  if (!result.ok) throw new Error(`not translated: ${result.errors.map((e) => e.message).join(' ')}`);
  return result.graph as unknown as JobGraph;
}

describe('named tasks become a graph of the same names', () => {
  it('maps each task to the graph node of its name, under fail_fast', () => {
    const graph = translated(EXAMPLE);
    expect(graph.failurePolicy).toBe('fail_fast');
    expect(Object.keys(graph.nodes)).toEqual(['import-1', 'convert-1', 'export-1']);
    expect(graph.nodes['import-1']).toMatchObject({ op: 'import.url', url: 'https://files.example.com/report.docx' });
    expect(graph.nodes['convert-1']).toMatchObject({ op: 'convert', input: 'import-1', targetFormat: 'pdf', options: { pages: '1-2' } });
    expect(graph.nodes['export-1']).toMatchObject({ op: 'export.internal', input: ['convert-1'] });
  });

  it('is a graph the validator accepts, and charges one unit for its one conversion', () => {
    const verdict = validateJobGraph(translated(EXAMPLE) as never, { userTier: 'free' });
    expect(verdict.errors).toEqual([]);
    expect(verdict.topologicalOrder).toEqual(['import-1', 'convert-1', 'export-1']);
  });

  it('sends the files of an export that names a url there, and keeps those of one that names none', () => {
    const sent = translated({
      'in-1': { operation: 'import/upload', storage_key: 'uploads/a/b.csv' },
      'out-1': { operation: 'export/url', input: 'in-1', url: 'https://hooks.example.com/put', method: 'POST', headers: { 'x-token': 'k' } },
    });
    expect(sent.nodes['in-1']).toMatchObject({ op: 'import.upload', storageKey: 'uploads/a/b.csv' });
    expect(sent.nodes['out-1']).toMatchObject({ op: 'export.url', url: 'https://hooks.example.com/put', method: 'POST', headers: { 'x-token': 'k' } });
    expect(translated({ a: { operation: 'import/upload', storage_key: 'uploads/a/b.csv' }, b: { operation: 'export/url', input: 'a' } }).nodes.b).toMatchObject({ op: 'export.internal' });
  });

  it('reads an upload by the key its upload_id was resolved to', () => {
    const graph = translated({ up: { operation: 'import/upload', upload_id: 'u1' } }, { u1: 'uploads/u1/scan.pdf' });
    expect(graph.nodes.up).toMatchObject({ op: 'import.upload', storageKey: 'uploads/u1/scan.pdf' });
  });

  it('answers every operation under the name it was sent with', () => {
    const operations = [...NAMED_TASK_OPERATIONS];
    expect(operations).toContain('import/url');
    for (const operation of operations) {
      const result = namedTasksToJobGraph({ t: { operation, ...(operation === 'import/url' ? { url: 'https://x.example.com/a.pdf' } : {}), ...(operation === 'import/upload' ? { storage_key: 'uploads/a/b.pdf' } : {}) } });
      if (!result.ok) throw new Error(result.errors[0].message);
      expect(publicOperationName((result.graph.nodes!.t as { op: string }).op)).toBe(operation);
    }
  });

  it('offers every operation of the graph engine, the engine`s dotted import, archive and export names aside', () => {
    const offered = new Set(NAMED_TASK_OPERATIONS);
    const missing = GRAPH_OPERATIONS.filter((op) => !offered.has(op) && !offered.has(publicOperationName(op)));
    expect(missing).toEqual([]);
  });
});

describe('a task that does not fit its operation is refused by name', () => {
  const refused = (tasks: NamedTaskMap) => {
    const result = namedTasksToJobGraph(tasks);
    if (result.ok) throw new Error('translated');
    return result.errors;
  };

  it.each([
    ['a url on a conversion', { c: { operation: 'convert', input: 'a', output_format: 'pdf', url: 'https://x.example.com/' } }, 'tasks.c.url'],
    ['an output_format on an optimize', { o: { operation: 'optimize', input: 'a', output_format: 'pdf' } }, 'tasks.o.output_format'],
    ['an input on an import', { i: { operation: 'import/url', url: 'https://x.example.com/a.pdf', input: 'a' } }, 'tasks.i.input'],
    ['a method on an export that keeps its files', { e: { operation: 'export/url', input: 'a', method: 'POST' } }, 'tasks.e.method'],
    ['both upload_id and storage_key', { u: { operation: 'import/upload', upload_id: 'x', storage_key: 'uploads/a/b.pdf' } }, 'tasks.u.upload_id'],
    ['an import without a url', { i: { operation: 'import/url' } }, 'tasks.i.url'],
    ['an upload that names nothing', { u: { operation: 'import/upload' } }, 'tasks.u.upload_id'],
  ] as Array<[string, NamedTaskMap, string]>)('%s', (_label, tasks, path) => {
    expect(refused(tasks).map((e) => e.path)).toContain(path);
  });
});

describe('the names of the tasks', () => {
  it('refuses more tasks than the plan allows before looking at anything else', () => {
    const names = Array.from({ length: 9 }, (_, i) => `Bad Name ${i}`);
    const errors = namedTaskNameErrors(names, 'free', ['dup']);
    expect(errors.map((e) => e.code)).toEqual(['GRAPH_NODE_LIMIT_EXCEEDED']);
    expect(namedTaskNameErrors(names.slice(0, 8).map((_, i) => `t${i}`), 'free')).toEqual([]);
    expect(namedTaskNameErrors(Array.from({ length: 9 }, (_, i) => `t${i}`), 'pro')).toEqual([]);
    expect(namedTaskNameErrors(Array.from({ length: 33 }, (_, i) => `t${i}`), 'enterprise').map((e) => e.code)).toEqual(['GRAPH_NODE_LIMIT_EXCEEDED']);
  });

  it.each(['Convert-1', '1convert', 'convert 1', 'convert.1', '', '_x', `a${'b'.repeat(64)}`, 'ünï'])('refuses the name %j', (name) => {
    expect(namedTaskNameErrors([name], 'pro').map((e) => e.code)).toEqual(['INVALID_NODE_ID']);
  });

  it.each(['a', 'import-1', 'convert_2', `a${'b'.repeat(63)}`])('accepts the name %j', (name) => {
    expect(namedTaskNameErrors([name], 'pro')).toEqual([]);
  });

  it('names a repeated name as a duplicate', () => {
    expect(namedTaskNameErrors(['a', 'b'], 'pro', ['a'])).toEqual([expect.objectContaining({ code: 'DUPLICATE_TASK_NAME', path: 'tasks.a' })]);
  });
});

describe('the refusal of a task graph is typed by its cause and worded in both languages', () => {
  const typeOf = (tasks: NamedTaskMap) => {
    const result = namedTasksToJobGraph(tasks);
    if (!result.ok) return namedTaskRefusal(result.errors);
    const verdict = validateJobGraph(result.graph as never, { userTier: 'pro' });
    if (verdict.valid) throw new Error('valid');
    return namedTaskRefusal(verdict.errors);
  };

  it('an input that names no task', () => {
    const refusal = typeOf({ ...EXAMPLE, 'export-1': { operation: 'export/url', input: ['convert-2'] } });
    expect(refusal.type).toBe(`${PROBLEM}task-input-unknown`);
    expect(refusal.invalidParams).toEqual([expect.objectContaining({ name: 'tasks.export-1.input', reason: expect.stringContaining('convert-2') })]);
  });

  it('tasks that read each other in a loop', () => {
    const refusal = typeOf({
      'import-1': { operation: 'import/url', url: 'https://files.example.com/a.docx' },
      'a-1': { operation: 'convert', input: ['import-1', 'b-1'], output_format: 'pdf' },
      'b-1': { operation: 'convert', input: 'a-1', output_format: 'pdf' },
      'export-1': { operation: 'export/url', input: 'b-1' },
    });
    expect(refusal.type).toBe(`${PROBLEM}task-graph-cycle`);
    expect(refusal.detail).toMatch(/a-1 -> b-1 -> a-1|b-1 -> a-1 -> b-1/);
  });

  it('a task that reads itself', () => {
    expect(typeOf({ ...EXAMPLE, 'convert-1': { operation: 'convert', input: 'convert-1', output_format: 'pdf' } }).type).toBe(`${PROBLEM}task-graph-cycle`);
  });

  it('a name that cannot be used, a repeated name and too many tasks', () => {
    expect(namedTaskRefusal(namedTaskNameErrors(['Bad'], 'pro')).type).toBe(`${PROBLEM}task-name-invalid`);
    expect(namedTaskRefusal(namedTaskNameErrors(['a'], 'pro', ['a'])).type).toBe(`${PROBLEM}task-name-duplicate`);
    expect(namedTaskRefusal(namedTaskNameErrors(Array.from({ length: 40 }, (_, i) => `t${i}`), 'pro')).type).toBe(`${PROBLEM}task-count-exceeded`);
  });

  it('any other fault of the tasks is the generic problem, with the task in its path', () => {
    const refusal = typeOf({ ...EXAMPLE, 'convert-1': { operation: 'convert', input: 'import-1' } });
    expect(refusal.type).toBe(`${PROBLEM}unprocessable-entity`);
    expect(refusal.invalidParams.map((p) => p.name)).toContain('tasks.convert-1.targetFormat');
  });

  it('names the more specific cause first when several are present', () => {
    const refusal = namedTaskRefusal([
      { path: 'tasks.a', code: 'MISSING_TARGET_FORMAT', message: 'x' },
      { path: 'tasks.b', code: 'NON_EXISTENT_INPUT', message: 'y' },
    ]);
    expect(refusal.type).toBe(`${PROBLEM}task-input-unknown`);
  });

  it.each(['task-name-invalid', 'task-name-duplicate', 'task-count-exceeded', 'task-input-unknown', 'task-graph-cycle'])('%s has a sentence in English and in Korean', (name) => {
    expect((en.errors.problems as Record<string, string>)[name]).toMatch(/\S/);
    expect((ko.errors.problems as Record<string, string>)[name]).toMatch(/[가-힣]/);
  });
});

describe('the names that a JSON text uses twice', () => {
  it('finds a repeated task name that JSON.parse would merge', () => {
    const text = '{"tasks":{"a":{"operation":"convert"},"b":{},"a":{"operation":"ocr"}},"webhookUrl":"https://x.example.com"}';
    expect(JSON.parse(text).tasks.a.operation).toBe('ocr');
    expect(duplicateKeys(text, 'tasks')).toEqual(['a']);
  });

  it('counts only the names of the tasks object itself', () => {
    const text = '{"options":{"x":1,"x":2},"tasks":{"a":{"options":{"y":1,"y":2},"input":["b","b"]},"b":{}}}';
    expect(duplicateKeys(text, 'tasks')).toEqual([]);
  });

  it('reads the tasks the parse reads when the member itself is repeated', () => {
    expect(duplicateKeys('{"tasks":{"a":{},"a":{}},"tasks":{"a":{},"b":{}}}', 'tasks')).toEqual([]);
    expect(duplicateKeys('{"tasks":{"a":{},"b":{}},"tasks":{"c":{},"c":{}}}', 'tasks')).toEqual(['c']);
  });

  it('is not misled by strings that hold braces, quotes or the name of another member', () => {
    const text = '{ "note" : "{\\"tasks\\": 1}" ,\n "tasks" : { "a\\"b" : { "x" : "}\\\\" } , "a\\"b" : [ 1 , { } ] , "c": true, "d": null, "e": -1.5e3 } }';
    expect(duplicateKeys(text, 'tasks')).toEqual(['a"b']);
  });

  it('reads the keys of the whole text when no member is named, and none from a text that is not an object', () => {
    expect(duplicateKeys('{"a":1,"a":2,"b":3}')).toEqual(['a']);
    expect(duplicateKeys('[1,2]', 'tasks')).toEqual([]);
    expect(duplicateKeys('{"tasks":[{"a":1,"a":2}]}', 'tasks')).toEqual([]);
    expect(duplicateKeys('{"other":{}}', 'tasks')).toEqual([]);
  });
});

describe('what a job reports of each task', () => {
  function stateOf(
    graph: JobGraph,
    statuses: Record<string, NodeExecutionStatus>,
    extra: Record<string, Partial<GraphNodeState>> = {}
  ): GraphExecutionState {
    const nodes = Object.fromEntries(
      Object.entries(graph.nodes).map(([id, node]) => [id, { id, op: node.op, status: statuses[id], outputs: [], ...extra[id] } as GraphNodeState])
    );
    return {
      graphId: 'job_1',
      status: 'running',
      policy: 'fail_fast',
      createdAt: 1,
      totalNodes: Object.keys(nodes).length,
      completedNodes: 0,
      failedNodes: 0,
      nodes,
      graph,
      namedTasks: true,
    };
  }

  const chain = translated({
    'in-1': { operation: 'import/url', url: 'https://files.example.com/a.docx' },
    'conv-1': { operation: 'convert', input: 'in-1', output_format: 'pdf' },
    'conv-2': { operation: 'convert', input: 'conv-1', output_format: 'png' },
    'out-1': { operation: 'export/url', input: 'conv-2' },
    'side-1': { operation: 'convert', input: 'in-1', output_format: 'txt' },
  });

  it('reports the failed task with its code, its dependents as failed by dependency, and an unrelated stopped task as cancelled', () => {
    const reports = namedTaskReports(
      stateOf(
        chain,
        { 'in-1': 'completed', 'conv-1': 'failed', 'conv-2': 'cancelled', 'out-1': 'cancelled', 'side-1': 'cancelled' },
        { 'conv-1': { error: 'The input is not valid.', errorCode: 'malformed_input', startedAt: 5, finishedAt: 9 } }
      )
    );
    expect(reports['in-1']).toEqual({ operation: 'import/url', status: 'completed' });
    expect(reports['conv-1']).toEqual({
      operation: 'convert',
      status: 'failed',
      input: ['in-1'],
      startedAt: 5,
      finishedAt: 9,
      error: { code: 'malformed_input', message: 'The input is not valid.' },
    });
    const blocked = { code: DEPENDENCY_FAILED_CODE, message: 'Task "conv-1" failed, so this task did not run.', task: 'conv-1' };
    expect(reports['conv-2']).toMatchObject({ status: 'failed', error: blocked });
    expect(reports['out-1']).toMatchObject({ operation: 'export/url', status: 'failed', error: blocked });
    expect(reports['side-1']).toMatchObject({ operation: 'convert', status: 'cancelled' });
    expect(reports['side-1'].error).toBeUndefined();
  });

  it('gives a failure that names no code the generic one, and masks what the message quotes', () => {
    const reports = namedTaskReports(
      stateOf(chain, { 'in-1': 'failed', 'conv-1': 'cancelled', 'conv-2': 'cancelled', 'out-1': 'cancelled', 'side-1': 'cancelled' }, { 'in-1': { error: 'fetch failed: Bearer abc.def.ghi' } })
    );
    expect(reports['in-1'].error?.code).toBe(TASK_FAILED_CODE);
    expect(reports['in-1'].error?.message).not.toContain('abc.def.ghi');
    expect(reports['side-1']).toMatchObject({ status: 'failed', error: { code: DEPENDENCY_FAILED_CODE, task: 'in-1' } });
  });

  it('reports waiting and active tasks while the job runs, and a task a cancel stopped as cancelled', () => {
    const running = namedTaskReports(stateOf(chain, { 'in-1': 'completed', 'conv-1': 'active', 'conv-2': 'pending', 'out-1': 'pending', 'side-1': 'waiting' }));
    expect(Object.fromEntries(Object.entries(running).map(([name, r]) => [name, r.status]))).toEqual({
      'in-1': 'completed',
      'conv-1': 'active',
      'conv-2': 'waiting',
      'out-1': 'waiting',
      'side-1': 'waiting',
    });
    const cancelled = namedTaskReports(stateOf(chain, { 'in-1': 'completed', 'conv-1': 'cancelled', 'conv-2': 'cancelled', 'out-1': 'cancelled', 'side-1': 'completed' }));
    expect(cancelled['conv-1'].status).toBe('cancelled');
    expect(cancelled['conv-1'].error).toBeUndefined();
  });

  it('lists the files an export kept with their download URLs, and none for a task that hands its files on', () => {
    const state = stateOf(
      chain,
      { 'in-1': 'completed', 'conv-1': 'completed', 'conv-2': 'completed', 'out-1': 'completed', 'side-1': 'completed' },
      {
        'conv-2': { outputs: ['intermediate/job_1/conv-2/0/a.png'] },
        'out-1': { outputs: ['results/job_1/out-1/0/a b.png', 'results/job_1/out-1/1/c.png'] },
      }
    );
    const reports = namedTaskReports(state);
    expect(reports['conv-2'].result).toBeUndefined();
    expect(reports['out-1'].result).toEqual({
      files: [
        { filename: 'a b.png', downloadUrl: `/api/storage/file/${encodeURIComponent('results/job_1/out-1/0/a b.png')}` },
        { filename: 'c.png', downloadUrl: `/api/storage/file/${encodeURIComponent('results/job_1/out-1/1/c.png')}` },
      ],
      fileCount: 2,
    });
  });

  it('lists at most the first files of an export that kept many, and counts them all', () => {
    const keys = Array.from({ length: MAX_TASK_RESULT_FILES + 5 }, (_, i) => `results/job_1/out-1/${i}/f${i}.png`);
    const reports = namedTaskReports(stateOf(chain, { 'in-1': 'completed', 'conv-1': 'completed', 'conv-2': 'completed', 'out-1': 'completed', 'side-1': 'completed' }, { 'out-1': { outputs: keys } }));
    expect(reports['out-1'].result?.files).toHaveLength(MAX_TASK_RESULT_FILES);
    expect(reports['out-1'].result?.fileCount).toBe(MAX_TASK_RESULT_FILES + 5);
  });

  it('names a task that kept files only under its own job', () => {
    const state = stateOf(chain, { 'in-1': 'completed', 'conv-1': 'completed', 'conv-2': 'completed', 'out-1': 'completed', 'side-1': 'completed' }, { 'out-1': { outputs: ['results/other_job/out-1/0/a.png'] } });
    expect(namedTaskReports(state)['out-1'].result).toEqual({ files: [], fileCount: 0 });
  });
});

describe('the schema of `tasks` takes an array or an object and words a fault of the one that fits', () => {
  const invalidParams = (tasks: unknown) => {
    const result = validateOrProblem(JobCreateRequestSchema, { tasks });
    return result.ok ? [] : (result.problem.invalidParams ?? []);
  };

  it('accepts a pipeline array and the object of the example', () => {
    expect(validateOrProblem(JobCreateRequestSchema, { tasks: [{ name: 'c', operation: 'convert', targetFormat: 'pdf' }] }).ok).toBe(true);
    expect(validateOrProblem(JobCreateRequestSchema, { tasks: EXAMPLE }).ok).toBe(true);
  });

  it('names only the fault of the array, as before, when an array has a bad stage', () => {
    expect(invalidParams([{ operation: 'nope' }])).toEqual([{ name: 'tasks.0.operation', reason: 'must be equal to one of the allowed values' }]);
  });

  it('names only the faults of the tasks of an object, by name', () => {
    expect(invalidParams({ a: { operation: 'nope', foo: 1 }, b: 'x' }).map((p) => p.name)).toEqual(['tasks.a.foo', 'tasks.a.operation', 'tasks.b']);
    expect(invalidParams({}).map((p) => p.reason)).toEqual(['must NOT have fewer than 1 properties']);
  });

  it('names the value that is neither', () => {
    expect(invalidParams('x').map((p) => p.name)).toEqual(['tasks', 'tasks', 'tasks']);
  });
});
