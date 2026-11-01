import crypto from 'node:crypto';
import { getRetentionLedger } from './retention-ledger';
import { newCompletionRecord, type UploadCompletion } from './result-retention';

/**
 * The receipt of a completed upload, found by the id of its session. The store consumes a session when it completes it,
 * so a client whose answer was lost, and an idempotency store that could not keep it, can only be answered from this: the
 * file the completion stored, for the owner the session recorded. It lives in the retention ledger, which every
 * instance shares, for the time an idempotent answer is kept.
 */

const RECEIPT_KEY_PREFIX = 'upload-completion/';

/** A key for the ledger that names no object and does not depend on what characters or how many an upload id has. */
function receiptKey(uploadId: string): string {
  return `${RECEIPT_KEY_PREFIX}${crypto.createHash('sha256').update(uploadId).digest('hex')}`;
}

/** Keeps the first answer of the completion of `uploadId`; a second completion of the same id changes nothing. */
export async function rememberUploadCompletion(uploadId: string, completion: UploadCompletion): Promise<void> {
  const key = receiptKey(uploadId);
  const now = Date.now();
  await getRetentionLedger().update(key, (current) => current ?? newCompletionRecord(key, now, completion));
}

/** The first answer of the completion of `uploadId`, or undefined when none was kept. */
export async function recallUploadCompletion(uploadId: string): Promise<UploadCompletion | undefined> {
  return (await getRetentionLedger().get(receiptKey(uploadId)))?.completion;
}
