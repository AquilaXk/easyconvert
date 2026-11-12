import { normalizeGraphNodes } from '@/lib/jobs/graph';
import type { JobGraph } from '@/lib/jobs/graph';
import { checkEngineNamed, resolveEngineChoice } from '@/worker/engine-registry';
import type { ConversionOptions, PipelineTask } from '@/lib/types';

/** The operation of a task that converts a file: the one whose engine a pair lists. */
const CONVERT_OPERATION = 'convert';

const names = (options: ConversionOptions | undefined): boolean => options?.engine !== undefined || options?.engineVersion !== undefined;

/** The parts of a submission that can name an engine. */
export interface SubmittedEngineChoices {
  sourceFormat: string;
  targetFormat: string;
  options: ConversionOptions;
  tasks?: PipelineTask[];
  graph?: JobGraph;
}

/**
 * Refuses a job that names an engine its conversion does not list, or a version that is not installed, before anything is
 * reserved (the refusals of `resolveEngineChoice`). A single job is checked against its pair. The tasks of a pipeline run in turn,
 * each on the output format of the one before, so a convert task is checked against its own pair. A graph node reads a file an
 * earlier node writes, so its engine is checked against the catalogue here and against the pair when the node runs.
 */
export async function checkSubmittedEngineChoices(job: SubmittedEngineChoices): Promise<void> {
  const { sourceFormat, targetFormat, options, tasks, graph } = job;
  if (graph) {
    await checkEngineNamed(options);
    for (const node of Object.values(normalizeGraphNodes(graph))) await checkEngineNamed(node.options ?? {});
    return;
  }
  if (!tasks || tasks.length === 0) {
    await resolveEngineChoice(sourceFormat, targetFormat, options);
    return;
  }
  await checkEngineNamed(options);
  let current = sourceFormat;
  for (const task of tasks) {
    const next = task.targetFormat?.trim().toLowerCase().replace(/^\./, '') || undefined;
    if (names(task.options)) {
      if (task.operation === CONVERT_OPERATION && next !== undefined) await resolveEngineChoice(current, next, task.options ?? {});
      else await checkEngineNamed(task.options ?? {});
    }
    if (next !== undefined) current = next;
  }
}
