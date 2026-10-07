import { redisUserStore } from '../auth/redis-user-store';
import { tierMaxPages, withTierPageCap } from '../conversions/page-range';
import type { ConversionEnginePort } from './engine-port';

/**
 * Page limit of queued conversions. The limit follows the tier of the job's owner, looked up when the job
 * runs, never an option stored in the job: job data comes from request bodies (and from Redis), which cannot
 * be trusted to carry it.
 */

const ANONYMOUS_USER_PREFIX = 'anon:';

/** Most pages a job owned by `userId` may convert; unknown and anonymous owners get the free tier's limit. */
export async function pageLimitForOwner(userId: string | undefined): Promise<number> {
  if (!userId || userId.startsWith(ANONYMOUS_USER_PREFIX)) return tierMaxPages();
  const owner = await redisUserStore.findById(userId);
  return tierMaxPages(owner?.tier);
}

/** An engine that runs every conversion under `maxPages` as its page limit. */
export function pageCappedEngine(engine: ConversionEnginePort, maxPages: number): ConversionEnginePort {
  return {
    name: engine.name,
    convert: (input, sourceFormat, targetFormat, options, originalFilename) =>
      engine.convert(input, sourceFormat, targetFormat, withTierPageCap(options, maxPages), originalFilename),
  };
}
