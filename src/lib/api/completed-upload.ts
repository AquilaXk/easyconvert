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

/**
 * Stores `buffer` as the one-part upload of `ownerUserId` and records it (`registerCompletedUpload`), answering its key. An
 * account's file lies under `conversions/<userId>/`, where the erasure of the account looks for it, and a visitor's in the
 * ownerless namespace. A record that cannot be written removes the file again and fails with the fixed
 * UNRECORDED_UPLOAD_DETAIL, so no internal message reaches an answer.
 */
export async function storeUploadedBuffer(
  storage: Pick<IStorageBackend, 'initiateMultipartUpload' | 'uploadPart' | 'completeMultipartUpload' | 'deleteObject'>,
  buffer: Buffer,
  file: { name: string; type: string; size: number },
  ownerUserId: string | undefined
): Promise<string> {
  const init = await storage.initiateMultipartUpload(file.name, file.type, file.size, ownerUserId);
  await storage.uploadPart(init.uploadId, 1, buffer);
  const { key } = await storage.completeMultipartUpload(init.uploadId);
  try {
    await registerCompletedUpload(storage, key);
  } catch (error: unknown) {
    console.error('[uploads] Could not record a stored request input, which was removed:', error);
    throw new Error(UNRECORDED_UPLOAD_DETAIL);
  }
  return key;
}
