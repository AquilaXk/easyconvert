/**
 * The identity of a caller without an account (docs/policy-decisions.md, entry 137). The quota, the burst limit and the
 * upload budget count it by the address bucket of the client (`anon:<bucket>`). What it creates is never bound to that
 * bucket: the address can change between two requests of one visitor and must not appear in a storage key, so a
 * session, an upload, a job and a result of an anonymous caller are reached by their random id or key, the capability.
 */

import { UNATTRIBUTED_CLIENT_KEY } from '../security/client-ip';

const ANONYMOUS_PREFIX = 'anon:';

/** The id of the anonymous caller in the address bucket `addressBucket`, which the quota and the limits count. */
export function anonymousUserId(addressBucket: string): string {
  return `${ANONYMOUS_PREFIX}${addressBucket}`;
}

/** Whether `userId` names an anonymous caller, not a signed-in account. */
export function isAnonymousUserId(userId: string | undefined): boolean {
  return userId?.startsWith(ANONYMOUS_PREFIX) ?? false;
}

/**
 * Whether `userId` is the one identity every request shares while no client can be attributed. It has no daily quota and
 * no upload budget, which would let one client use them up for everyone (docs/client-ip-trust.md, item 5).
 */
export function isUnattributedAnonymous(userId: string): boolean {
  return userId === anonymousUserId(UNATTRIBUTED_CLIENT_KEY);
}

/** The owner written on an upload session an anonymous caller opens: anonymous, and naming no address. */
export const ANONYMOUS_UPLOAD_OWNER = anonymousUserId('upload');

/** The owner to write on an upload session `callerUserId` opens. */
export function uploadOwnerOf(callerUserId: string): string {
  return isAnonymousUserId(callerUserId) ? ANONYMOUS_UPLOAD_OWNER : callerUserId;
}

/**
 * Whether `callerUserId` may act on an upload session owned by `ownerUserId`. An account's session is its own; a
 * session of an anonymous caller is open to any anonymous caller that holds its random id, and to no account.
 */
export function mayUseUploadSession(ownerUserId: string | undefined, callerUserId: string): boolean {
  if (!ownerUserId) return false;
  return isAnonymousUserId(ownerUserId) ? isAnonymousUserId(callerUserId) : ownerUserId === callerUserId;
}
