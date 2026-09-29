import { NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from './guard';
import { conversionQueue } from '../queue/conversion-queue';
import { classifyStorageKey } from '../storage/key-namespace';

/**
 * Restricts a resource to the user that owns it.
 * Resources without an owner (anonymous uploads) keep capability-URL access.
 * For an owned resource, any caller other than the owner gets the route's regular not-found
 * response so resource identifiers cannot be probed; the owner still sees the guard's own
 * rejection (missing scope, burst limit) so the request can be fixed.
 * Returns the response to send when access is denied, or null when the caller may proceed.
 */
export async function denyUnlessOwner(
  req: Request,
  ownerUserId: string | undefined,
  requiredScope: string,
  notFound: () => NextResponse
): Promise<NextResponse | null> {
  if (!ownerUserId) {
    return null;
  }

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope });
  if (auth.user?.id !== ownerUserId) {
    return notFound();
  }
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error ?? 'Unauthorized' },
      { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
    );
  }
  return null;
}

export type ObjectOwnership =
  | { resolved: true; ownerUserId: string | undefined }
  | { resolved: false };

/**
 * Resolves the user that owns a stored object from its key namespace.
 * A job result is resolved only while its job record can be read: jobs are never removed after
 * they finish, so a missing record means a queue outage (the distributed adapter reports a Redis
 * error as a missing job) or a restarted in-memory queue, and the owner cannot be proven.
 * Every other key (anonymous uploads) has no owner.
 */
export async function resolveObjectOwnership(key: string): Promise<ObjectOwnership> {
  const classified = classifyStorageKey(key);
  if (classified.namespace === 'user-conversion') {
    return { resolved: true, ownerUserId: classified.userId };
  }
  if (classified.namespace === 'job-result') {
    const job = await conversionQueue.getJob(classified.jobId);
    if (!job) {
      return { resolved: false };
    }
    return { resolved: true, ownerUserId: job.data?.userId };
  }
  return { resolved: true, ownerUserId: undefined };
}
