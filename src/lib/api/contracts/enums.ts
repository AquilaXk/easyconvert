import { LEGACY_TASK_OPERATIONS } from '@/lib/jobs/graph';

/**
 * Pipeline task operations the API accepts: exactly the operations the legacy-task adapter
 * translates into a job graph, so the schema never advertises a stage that cannot run.
 */
export const PIPELINE_OPERATIONS: readonly string[] = Object.freeze(Array.from(LEGACY_TASK_OPERATIONS));

