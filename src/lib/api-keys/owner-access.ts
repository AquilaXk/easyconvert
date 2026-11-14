import { NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from './guard';
import { conversionQueue } from '../queue/conversion-queue';
import { graphScheduler } from '../queue/graph';
import { storageProvider } from '../storage';
import { classifyStorageKey, isUploadKey } from '../storage/key-namespace';
import { isResultDeleted } from '../storage/retention-service';
import { QueueUnavailableError } from '../types';
import { isAnonymousUserId } from '../auth/anonymous-identity';

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
 * A job result is resolved only while its job record can be read. An ended job is kept for `endedJobRetentionMs`, longer
 * than its result and the record of the result's deletion, so a missing record, a queue outage (`QueueUnavailableError`) or
 * a restarted in-memory queue means the owner cannot be proven, and access is denied.
 * An upload and the output of a graph node have no owner (capability access). A key of no namespace a writer of the
 * server produces is not resolved, so no route serves it.
 */
const INTERMEDIATE_GRAPH_ID_PATTERN = /^intermediate\/([^/]+)\//;

export interface OwnershipResolverDeps {
  getJob?: (jobId: string) => Promise<{ data?: { userId?: string } } | null | undefined>;
  graphScheduler?: {
    getGraphState: (graphId: string) => Promise<
      | {
          status: string;
          ownerUserId?: string;
          nodes?: Record<string, { status: string; op: string }>;
        }
      | undefined
    >;
  };
}

function hasCompletedExportNode(nodes: Record<string, { status: string; op: string }> | undefined): boolean {
  if (!nodes) return false;
  return Object.values(nodes).some((node) => node.status === 'completed' && node.op.startsWith('export.'));
}

export async function resolveObjectOwnership(key: string, deps?: OwnershipResolverDeps): Promise<ObjectOwnership> {
  const classified = classifyStorageKey(key);
  if (classified.namespace === 'other') {
    return { resolved: false };
  }
  if (classified.namespace === 'user-conversion') {
    return { resolved: true, ownerUserId: classified.userId };
  }
  const readJob = deps?.getJob ?? ((jobId: string) => conversionQueue.getJob(jobId));
  const scheduler = deps?.graphScheduler ?? graphScheduler;
  if (classified.namespace === 'job-result') {
    try {
      const job = await readJob(classified.jobId);
      if (job) {
        return { resolved: true, ownerUserId: job.data?.userId };
      }
      const graphState = await scheduler.getGraphState(classified.jobId);
      if (graphState) {
        if (
          (graphState.status === 'failed' || graphState.status === 'cancelled') &&
          !hasCompletedExportNode(graphState.nodes)
        ) {
          return { resolved: false };
        }
        return { resolved: true, ownerUserId: graphState.ownerUserId };
      }
      return { resolved: false };
    } catch (err) {
      if (err instanceof QueueUnavailableError) {
        return { resolved: false };
      }
      throw err;
    }
  }
  if (classified.namespace === 'intermediate') {
    const match = INTERMEDIATE_GRAPH_ID_PATTERN.exec(key);
    if (match) {
      try {
        const graphState = await scheduler.getGraphState(match[1]);
        if (graphState && (graphState.status === 'failed' || graphState.status === 'cancelled')) {
          return { resolved: false };
        }
      } catch (err) {
        if (err instanceof QueueUnavailableError) {
          return { resolved: false };
        }
        throw err;
      }
    }
  }
  return { resolved: true, ownerUserId: undefined };
}

/**
 * Decides whether a caller may submit a stored object as a job input. The object must exist, not be a result the
 * retention rule already deleted, and be reachable by the caller the way a download of it is: an upload or a result of
 * an anonymous caller by anyone holding its key (the capability), an account's output by that account only. Answer a
 * rejected key exactly like a missing object, so other users' keys can be neither probed nor converted.
 */
export async function mayUseStorageKeyAsJobInput(
  key: string,
  callerUserId: string | undefined,
  statKey: (key: string) => unknown = (k) => storageProvider.stat(k)
): Promise<boolean> {
  if (!(await statKey(key)) || (await isResultDeleted(key))) {
    return false;
  }
  if (isUploadKey(key)) {
    return true;
  }
  const ownership = await resolveObjectOwnership(key);
  if (!ownership.resolved) return false;
  return isAnonymousUserId(ownership.ownerUserId) || (callerUserId !== undefined && ownership.ownerUserId === callerUserId);
}
