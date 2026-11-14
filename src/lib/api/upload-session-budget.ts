import type { NextResponse } from 'next/server';
import { OPEN_UPLOAD_IDLE_MS, endUploadReservation, reserveUploadBudget, type UploadReservation } from '../api-keys/anonymous-upload-budget';
import { isUnattributedAnonymous } from '../auth/anonymous-identity';
import type { User } from '../auth/types';
import { planOfCaller } from '../plan-limits';
import { unattributedTransferRefusal, uploadBudgetRefusalResponse } from './upload-budget-response';

/**
 * The budget of the upload sessions the routes of `/api/v1/uploads` open (docs/policy-decisions.md, entries 137 and 296), as
 * `/api/storage/multipart` keeps it: the declared size is reserved before the session exists, bound to it once it does, and
 * ended when the session is completed or aborted. A session nobody ends stops counting when it expires.
 */

/** Reserves the declared `bytes` of a session of `user`, or answers the 429 (or the 503 of an unattributed visitor) that refuses it. */
export async function reserveSessionBudget(
  user: User,
  bytes: number,
  instanceUri: string
): Promise<{ reservation: UploadReservation } | { refused: NextResponse }> {
  if (isUnattributedAnonymous(user.id)) return { refused: unattributedTransferRefusal(instanceUri) };
  const reserved = await reserveUploadBudget(user, bytes, Date.now() + OPEN_UPLOAD_IDLE_MS);
  if ('refusal' in reserved) return { refused: uploadBudgetRefusalResponse(reserved.refusal, instanceUri, planOfCaller(user)) };
  return { reservation: reserved.reservation };
}

/**
 * Takes back an opening that failed: the session is aborted when it was made and the reservation released, each whatever the
 * other does. A session whose abort failed, and a reservation that could not be released, end when they expire.
 */
export async function undoOpening(reservation: UploadReservation, uploadId: string | undefined, abort: (uploadId: string) => unknown): Promise<void> {
  try {
    if (uploadId) await abort(uploadId);
  } catch (error) {
    console.warn('[uploads] Could not abort the session of a failed opening; it ends when it expires:', error);
  } finally {
    await reservation.release().catch((error: unknown) => {
      console.warn('[uploads] Could not give back the budget of a failed opening; it returns when the reservation expires:', error);
    });
  }
}

/** Ends the reservation of a session the store already closed. A budget that cannot be reached does not change the answer: the reservation then ends when it expires. */
export async function closeSessionBudget(uploadId: string, outcome: 'completed' | 'aborted'): Promise<void> {
  await endUploadReservation(uploadId, outcome).catch((error: unknown) => {
    console.warn(`[uploads] Could not close the budget of the ${outcome} upload; it ends when the reservation expires:`, error);
  });
}
