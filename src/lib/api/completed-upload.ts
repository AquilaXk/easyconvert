import type { NextResponse } from 'next/server';
import { registerCompletedUpload } from '../storage/retention-service';
import type { IStorageBackend } from '../storage/oci-storage';
import { createProblemDetailsResponse } from './problem-details';

/** The detail of the answer to an upload that was stored but could not be recorded; the error itself stays in the server log. */
export const UNRECORDED_UPLOAD_DETAIL = 'The upload could not be recorded, so it cannot be converted. Upload the file again.';

const HTTP_INTERNAL_SERVER_ERROR = 500;

/**
 * Records the upload just completed under `key` (`registerCompletedUpload`), so that a job reading it holds it and a
 * download does not take it for a result. When the record cannot be written the object is removed again, and the answer
 * is the 500 to return in place of the completion; undefined when the upload is recorded.
 */
export async function recordCompletedUpload(storage: Pick<IStorageBackend, 'deleteObject'>, key: string, instanceUri: string): Promise<NextResponse | undefined> {
  try {
    await registerCompletedUpload(storage, key);
    return undefined;
  } catch (error: unknown) {
    console.error('[uploads] Could not record a completed upload, which was removed:', error);
    return createProblemDetailsResponse(HTTP_INTERNAL_SERVER_ERROR, UNRECORDED_UPLOAD_DETAIL, instanceUri);
  }
}
