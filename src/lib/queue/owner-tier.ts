import { redisUserStore } from '../auth/redis-user-store';
import { isAnonymousUserId } from '../auth/anonymous-identity';

const FREE_TIER = 'free';

/** Tier of the owner of `userId`; unknown and anonymous owners are the free tier. */
export async function tierForOwner(userId: string | undefined): Promise<string> {
  if (!userId || isAnonymousUserId(userId)) return FREE_TIER;
  const owner = await redisUserStore.findById(userId);
  return owner?.tier ?? FREE_TIER;
}
