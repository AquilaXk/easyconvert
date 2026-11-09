import { isAnonymousUserId } from '../auth/anonymous-identity';
import { redisKeyStore } from '../api-keys/redis-key-store';
import type { ConversionJobData, ConversionJobResult } from '../types';
import type { Job } from './bullmq-engine';
import { resolveRetentionPolicy } from '../storage/result-retention';

/**
 * Puts the result of a queue job that completed in the history of converted files of its owner (`/api/account/files`), as the
 * synchronous conversion does. The record is made under the job id, so a completion reported twice records it once, and it is
 * kept as long as the result is (RESULT_UNDELIVERED_TTL_SECONDS from the end). Not recorded: a job of a visitor without an
 * account, whose result is reached by its link alone, and a node of a graph, whose final outputs the graph records when it completes (`recordGraphOutputsInHistory`). A history that cannot
 * be written is logged and never fails the job, whose result is stored.
 */
export async function recordJobResultInHistory(
  job: Pick<Job<ConversionJobData, ConversionJobResult>, 'id' | 'data'>,
  result: ConversionJobResult
): Promise<void> {
  const userId = job.data?.userId;
  if (!userId || isAnonymousUserId(userId) || job.data.graphId) return;
  try {
    await redisKeyStore.recordUserFile({
      id: job.id,
      userId,
      fileName: result.filename,
      fromFormat: job.data.sourceFormat,
      toFormat: job.data.targetFormat,
      size: result.size,
      downloadUrl: result.downloadUrl,
      storageKey: result.resultKey,
      ttlMs: resolveRetentionPolicy().undeliveredTtlMs,
    });
  } catch (err) {
    console.error(`[ConversionQueue] Failed to record the result of job ${job.id} in the file history:`, err);
  }
}
