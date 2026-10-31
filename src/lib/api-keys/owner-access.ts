import { NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from './guard';
import { conversionQueue } from '../queue/conversion-queue';
import { storageProvider } from '../storage';
import { classifyStorageKey, isUploadKey } from '../storage/key-namespace';
import { isResultDeleted } from '../storage/retention-service';
import { QueueUnavailableError } from '../types';
import { isAnonymousUserId } from '../plan-limits';

/** Response detail for a job input key that is missing or that the caller may not use. */
export const STORAGE_OBJECT_NOT_FOUND = 'Storage object not found.';

/**
 * Restricts a resource to the user that owns it.
 * Resources without an owner keep capability-URL access, and so do those of an anonymous caller: an anonymous
 * identity is the address bucket of the client, which no request can prove to be the same person, so the job id and
 * the storage key (a random token each) are the capability.
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
  if (!ownerUserId || isAnonymousUserId(ownerUserId)) {
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
 * they finish, so a missing record or a queue outage (`QueueUnavailableError`) or a restarted
 * in-memory queue means the owner cannot be proven, and access is denied.
 * Every other key (anonymous uploads) has no owner.
 */
export async function resolveObjectOwnership(key: string): Promise<ObjectOwnership> {
  const classified = classifyStorageKey(key);
  if (classified.namespace === 'user-conversion') {
    return { resolved: true, ownerUserId: classified.userId };
  }
  if (classified.namespace === 'job-result') {
    try {
      const job = await conversionQueue.getJob(classified.jobId);
      if (!job) {
        return { resolved: false };
      }
      return { resolved: true, ownerUserId: job.data?.userId };
    } catch (err) {
      if (err instanceof QueueUnavailableError) {
        return { resolved: false };
      }
      throw err;
    }
  }
  return { resolved: true, ownerUserId: undefined };
}

/**
 * Decides whether a caller may submit a stored object as a job input. The object must exist, not be a result the
 * retention rule already deleted, and be
 * either an upload (reachable by anyone holding its key) or an output owned by the authenticated
 * caller; anonymous callers may only use uploads. Answer a rejected key exactly like a missing
 * object, so other users' keys can be neither probed nor converted.
 */
export async function mayUseStorageKeyAsJobInput(
  key: string,
  callerUserId: string | undefined
): Promise<boolean> {
  if (!(await storageProvider.stat(key)) || (await isResultDeleted(key))) {
    return false;
  }
  if (isUploadKey(key)) {
    return true;
  }
  if (!callerUserId) {
    return false;
  }
  const ownership = await resolveObjectOwnership(key);
  return ownership.resolved && ownership.ownerUserId === callerUserId;
}
