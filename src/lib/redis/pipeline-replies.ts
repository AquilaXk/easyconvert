import type Redis from 'ioredis';

/** The replies of a pipeline, or the first error of one of its commands (`exec` itself reports a failed command as a value). */
export async function pipelineReplies(pipeline: ReturnType<Redis['pipeline']>): Promise<unknown[]> {
  const results = (await pipeline.exec()) ?? [];
  for (const [error] of results) if (error) throw error;
  return results.map(([, reply]) => reply);
}
