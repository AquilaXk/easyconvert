import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { setRetentionLedger, type RetentionLedger } from '../../src/lib/storage/retention-ledger';
import { capacityEvictionOrder, isCapacityCandidate } from '../../src/lib/storage/result-capacity';
import { GONE_RECORD_MS, recordKind, resolveRetentionPolicy, type RetentionRecord, type UploadCompletion } from '../../src/lib/storage/result-retention';
import { sweepRetention } from '../../src/lib/storage/retention-service';
import { recallUploadCompletion, rememberUploadCompletion } from '../../src/lib/storage/upload-completion';

/**
 * What the retention ledger must do with the receipt of an upload completion, whichever store keeps it: it is a record
 * of no object, so it is never live, never due, never a candidate for deletion, and it only waits for the gone window.
 */

const POLICY = resolveRetentionPolicy({});
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export const COMPLETION: UploadCompletion = {
  ownerUserId: 'anon:upload',
  partsDigest: 'a'.repeat(64),
  result: { location: '/api/storage/file/uploads%2Fa.csv', key: 'uploads/a.csv', size: 8, etag: '"e"' },
};

/** An upload id no earlier run kept a receipt for, since a Redis ledger keeps its records for a day. */
const newUploadId = (): string => `upload-id-${crypto.randomBytes(6).toString('hex')}`;

/** A ledger that notes the keys it was asked to update, so a test can find a receipt whose key is the module's own. */
export function recordingLedger(ledger: RetentionLedger): { ledger: RetentionLedger; updatedKeys: string[] } {
  const updatedKeys: string[] = [];
  return {
    updatedKeys,
    ledger: {
      get: (key) => ledger.get(key),
      update: (key, change) => (updatedKeys.push(key), ledger.update(key, change)),
      forget: (key) => ledger.forget(key),
      collectDue: (now, limit) => ledger.collectDue(now, limit),
      liveRecords: () => ledger.liveRecords(),
    },
  };
}

/** Keeps the receipt of `uploadId` in `ledger`; returns the ledger's record of it. */
export async function keepReceipt(ledger: RetentionLedger, uploadId: string): Promise<RetentionRecord> {
  const recording = recordingLedger(ledger);
  setRetentionLedger(recording.ledger);
  await rememberUploadCompletion(uploadId, COMPLETION);
  const record = await ledger.get(recording.updatedKeys[0]);
  if (!record) throw new Error('the receipt was not kept');
  return record;
}

/** The tests every ledger runs on a completion record; `openLedger` gives the ledger under test, empty. */
export function defineCompletionRecordContract(openLedger: () => RetentionLedger): void {
  it('returns the receipt to the upload id that was kept for, with the answer, the owner and the digest', async () => {
    const ledger = openLedger();
    const uploadId = newUploadId();
    await keepReceipt(ledger, uploadId);

    expect(await recallUploadCompletion(uploadId)).toEqual(COMPLETION);
    expect(await recallUploadCompletion(newUploadId())).toBeUndefined();
  });

  it('is of the kind completion and ended from the start, so it is never a live record', async () => {
    const ledger = openLedger();
    const record = await keepReceipt(ledger, newUploadId());

    expect(recordKind(record)).toBe('completion');
    expect(record.goneAt).toBe(record.createdAt);
    expect((await ledger.liveRecords()).map((live) => live.key)).not.toContain(record.key);
  });

  it('is never due for a sweep, however far the clock moves', async () => {
    const ledger = openLedger();
    const record = await keepReceipt(ledger, newUploadId());

    expect(await ledger.collectDue(Date.now() + TEN_YEARS_MS, 1_000_000)).not.toContain(record.key);
  });

  it('is never deleted by a sweep, since it names no object', async () => {
    const ledger = openLedger();
    const record = await keepReceipt(ledger, newUploadId());
    const deleted: string[] = [];

    const storage = { deleteObject: async (key: string) => (deleted.push(key), true) };

    await sweepRetention(storage, Date.now() + GONE_RECORD_MS / 2);
    expect(await ledger.get(record.key)).toBeDefined();
    await sweepRetention(storage, Date.now() + TEN_YEARS_MS);

    expect(deleted).not.toContain(record.key);
  });

  it('is never a candidate for deletion when the disk runs full', async () => {
    const ledger = openLedger();
    const record = await keepReceipt(ledger, newUploadId());
    const farFuture = Date.now() + TEN_YEARS_MS;

    expect(isCapacityCandidate(record, farFuture, POLICY)).toBe(false);
    expect(capacityEvictionOrder([record, ...(await ledger.liveRecords())], farFuture, POLICY).map((candidate) => candidate.key)).not.toContain(record.key);
  });

  it('keeps a second completion of the same upload from replacing the first answer', async () => {
    const ledger = openLedger();
    const uploadId = newUploadId();
    await keepReceipt(ledger, uploadId);
    const other = { ...COMPLETION, result: { ...COMPLETION.result, key: 'uploads/other.csv' } };

    await rememberUploadCompletion(uploadId, other);

    expect(await recallUploadCompletion(uploadId)).toEqual(COMPLETION);
  });
}
