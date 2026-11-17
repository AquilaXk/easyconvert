import { normalizeGraphNodes } from '@/lib/jobs/graph';
import type { JobGraph } from '@/lib/jobs/graph';
import { isQueueOnlyWebMode } from '@/lib/queue/worker-presence';
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
 * reserved (the refusals of `resolveEngineChoice`). In `WEB_EXECUTION_MODE=queue-only` (`webslim`), the Web pod checks
 * pair/catalogue eligibility while leaving binary installation checks to the Worker fleet.
 */
export async function checkSubmittedEngineChoices(job: SubmittedEngineChoices): Promise<void> {
  const { sourceFormat, targetFormat, options, tasks, graph } = job;
  const validation = { checkLocalInstall: !isQueueOnlyWebMode() };
  if (graph) {
    await checkEngineNamed(options, validation);
    for (const node of Object.values(normalizeGraphNodes(graph))) await checkEngineNamed(node.options ?? {}, validation);
    return;
  }
  if (!tasks || tasks.length === 0) {
    await resolveEngineChoice(sourceFormat, targetFormat, options, validation);
    return;
  }
  await checkEngineNamed(options, validation);
  let current = sourceFormat;
  for (const task of tasks) {
    const next = task.targetFormat?.trim().toLowerCase().replace(/^\./, '') || undefined;
    if (names(task.options)) {
      if (task.operation === CONVERT_OPERATION && next !== undefined) {
        await resolveEngineChoice(current, next, task.options ?? {}, validation);
      } else {
        await checkEngineNamed(task.options ?? {}, validation);
      }
    }
    if (next !== undefined) current = next;
  }
}
