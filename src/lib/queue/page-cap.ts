import { redisUserStore } from '../auth/redis-user-store';
import { isAnonymousUserId } from '../plan-limits';
import { tierMaxPages, withTierPageCap } from '../conversions/page-range';
import type { ConversionEnginePort } from './engine-port';

/**
 * Page limit of queued conversions. The limit follows the tier of the job's owner, looked up when the job
 * runs, never an option stored in the job: job data comes from request bodies (and from Redis), which cannot
 * be trusted to carry it.
 */

const FREE_TIER = 'free';

/** Most pages a job owned by `userId` may convert; unknown and anonymous owners get the free tier's limit. */
export async function pageLimitForOwner(userId: string | undefined): Promise<number> {
  if (!userId || isAnonymousUserId(userId)) return tierMaxPages();
  const owner = await redisUserStore.findById(userId);
  return tierMaxPages(owner?.tier);
}

/** Tier of the owner of `userId`; unknown and anonymous owners are the free tier, as for the page limit. */
export async function tierForOwner(userId: string | undefined): Promise<string> {
  if (!userId || isAnonymousUserId(userId)) return FREE_TIER;
  const owner = await redisUserStore.findById(userId);
  return owner?.tier ?? FREE_TIER;
}

/** An engine that runs every conversion under `maxPages` as its page limit. */
export function pageCappedEngine(engine: ConversionEnginePort, maxPages: number): ConversionEnginePort {
  return {
    name: engine.name,
    convert: (input, sourceFormat, targetFormat, options, originalFilename) =>
      engine.convert(input, sourceFormat, targetFormat, withTierPageCap(options, maxPages), originalFilename),
  };
}
