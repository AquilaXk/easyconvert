import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import {
  LINK_IMPORT_HOLD_GRACE_MS,
  OPEN_UPLOAD_IDLE_MS,
  bytesBroughtInToday,
  holdImport,
  importOverflow,
  linkImportHoldBytes,
  reserveLinkImport,
  reserveUpload,
  settleImport,
  shrinkImportHold,
  type HeldBytes,
  type UploadBudgetRecord,
} from '../src/lib/api-keys/anonymous-upload-budget';

/**
 * The hold a link import takes on the day's bytes of its caller (docs/policy-decisions.md, entry 15): how much it holds and
 * why it holds less than one file, how a body larger than its hold is judged, and how the hold ends.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HOUR = 60 * 60 * 1000;
const DAY = '2026-11-01';
const NOW = Date.UTC(2026, 10, 1, 12);

describe('the hold of a link import', () => {
  const policy = { maxOpenUploads: 2, dailyBytes: 2 * GIB, idleMs: HOUR };
  const IMPORT_DEADLINE_MS = 2 * HOUR;
  const HOLD_ENDS = NOW + IMPORT_DEADLINE_MS + LINK_IMPORT_HOLD_GRACE_MS;
  const NEXT_DAY = '2026-11-02';
  const held = () => holdImport(undefined, { id: 'import', bytes: 100 * MIB, day: DAY, now: NOW, expiresAt: HOLD_ENDS });

  /** The bytes of the day `record` is charged at `now`, read through a session that declares none. */
  function bytesAt(record: UploadBudgetRecord, now: number): number {
    const probe = reserveUpload(record, { id: 'probe', bytes: 0, day: DAY, now, expiresAt: now + HOUR }, policy);
    if ('refusal' in probe) throw new Error(`refused: ${probe.refusal}`);
    return probe.record.bytes;
  }

  it('holds its bytes until the deadline of the import and the grace after it have passed', () => {
    expect(bytesAt(held(), NOW + OPEN_UPLOAD_IDLE_MS + 1)).toBe(100 * MIB);
    expect(bytesAt(held(), HOLD_ENDS - 1)).toBe(100 * MIB);
    expect(bytesAt(held(), HOLD_ENDS)).toBe(0);
  });

  it('is replaced by the bytes the import received', () => {
    expect(settleImport(held(), { id: 'import', receivedBytes: 7 * MIB, day: DAY, now: NOW + HOUR }).bytes).toBe(7 * MIB);
  });

  it('charges the bytes received after the hold expired, also when the record changed in between', () => {
    expect(settleImport(held(), { id: 'import', receivedBytes: 7 * MIB, day: DAY, now: HOLD_ENDS + 1 }).bytes).toBe(7 * MIB);

    const changedAfterExpiry = reserveUpload(held(), { id: 'upload', bytes: MIB, day: DAY, now: HOLD_ENDS + 1, expiresAt: HOLD_ENDS + HOUR }, policy);
    if ('refusal' in changedAfterExpiry) throw new Error('refused');
    expect(changedAfterExpiry.record.open.import).toBeUndefined();
    expect(settleImport(changedAfterExpiry.record, { id: 'import', receivedBytes: 7 * MIB, day: DAY, now: HOLD_ENDS + 2 }).bytes).toBe(8 * MIB);
  });

  it('charges an import that ends after midnight to the new day, and its hold is not returned to that day', () => {
    const newDayWithBytes: UploadBudgetRecord = { ...held(), day: NEXT_DAY, bytes: 50 * MIB };
    const settled = settleImport(newDayWithBytes, { id: 'import', receivedBytes: 7 * MIB, day: NEXT_DAY, now: NOW + HOUR });
    expect(settled.day).toBe(NEXT_DAY);
    expect(settled.bytes).toBe(57 * MIB);
    expect(settled.open.import).toBeUndefined();
  });

  it('does not count as an open upload', () => {
    const first = reserveUpload(held(), { id: 'a', bytes: MIB, day: DAY, now: NOW, expiresAt: NOW + HOUR }, policy);
    if ('refusal' in first) throw new Error('refused');
    const second = reserveUpload(first.record, { id: 'b', bytes: MIB, day: DAY, now: NOW, expiresAt: NOW + HOUR }, policy);
    if ('refusal' in second) throw new Error('refused');
    expect(reserveUpload(second.record, { id: 'c', bytes: MIB, day: DAY, now: NOW, expiresAt: NOW + HOUR }, policy)).toEqual({ refusal: 'open-uploads' });
  });

  const ONE_FILE = GIB;
  const received = (bytes: number) => settleImport(undefined, { id: 'earlier', receivedBytes: bytes, day: DAY, now: NOW });
  const heldBy = (record: UploadBudgetRecord, id: string, bytes: number) => holdImport(record, { id, bytes, day: DAY, now: NOW, expiresAt: HOLD_ENDS });
  const holdFor = (record: UploadBudgetRecord, id: string) => linkImportHoldBytes(record, { id, day: DAY, now: NOW, limitBytes: ONE_FILE, dailyBytes: policy.dailyBytes });

  function heldFor(record: UploadBudgetRecord, id: string): HeldBytes {
    const held = holdFor(record, id);
    if ('refusal' in held) throw new Error(`refused: ${held.refusal}`);
    return held;
  }

  it.each([
    ['one file while the day has room for it, and a larger body is over the import limit', () => received(200 * MIB), { shortBy: 'none', bytes: ONE_FILE }, { kind: 'too-large' }],
    ['the rest of the day when the bytes received leave less than one file, and a larger body is larger than what is left', () => received(1.5 * GIB), { shortBy: 'received', bytes: 0.5 * GIB }, { kind: 'larger-than-left', leftBytes: 0.5 * GIB }],
    [
      'less than one file while another import holds the rest, and a larger body waits for it instead of being refused for the day',
      () => heldBy(received(300 * MIB), 'other', ONE_FILE),
      { shortBy: 'held', bytes: GIB - 300 * MIB, leftTodayBytes: 2 * GIB - 300 * MIB },
      { kind: 'held' },
    ],
  ] as const)('holds %s', (_label, record, expectedHold, expectedOverflow) => {
    const held = heldFor(record(), 'import');
    expect(held).toEqual(expectedHold);
    expect(importOverflow({ limitBytes: ONE_FILE, held })).toEqual(expectedOverflow);
  });

  it('counts an open upload with the holds of other imports, since its bytes come back when it is aborted', () => {
    const opened = reserveUpload(received(512 * MIB), { id: 'upload', bytes: 800 * MIB, day: DAY, now: NOW, expiresAt: NOW + HOUR }, policy);
    if ('refusal' in opened) throw new Error('refused');
    expect(heldFor(opened.record, 'import')).toEqual({ shortBy: 'held', bytes: 736 * MIB, leftTodayBytes: 1.5 * GIB });

    const full = reserveUpload(received(1.5 * GIB), { id: 'upload', bytes: 0.5 * GIB, day: DAY, now: NOW, expiresAt: NOW + HOUR }, policy);
    if ('refusal' in full) throw new Error('refused');
    expect(holdFor(full.record, 'import')).toEqual({ refusal: 'held' });
  });

  it('judges a declared length by the import limit, then by what the day has left once the other holds end', () => {
    const held = heldFor(heldBy(received(1.5 * GIB), 'other', 200 * MIB), 'import');
    expect(held).toEqual({ shortBy: 'held', bytes: 312 * MIB, leftTodayBytes: 512 * MIB });
    const hold = { limitBytes: ONE_FILE, held };

    expect(importOverflow(hold, 400 * MIB)).toEqual({ kind: 'held' });
    expect(importOverflow(hold, 600 * MIB)).toEqual({ kind: 'larger-than-left', leftBytes: 512 * MIB });
    expect(importOverflow(hold, 1200 * MIB)).toEqual({ kind: 'too-large' });
  });

  it('shrinks a hold to a smaller declared length, giving the rest back to the day, and never grows one', () => {
    const record = heldBy(received(0), 'import', ONE_FILE);
    expect(shrinkImportHold(record, { id: 'import', bytes: 10 * MIB, day: DAY, now: NOW })?.bytes).toBe(10 * MIB);
    expect(shrinkImportHold(record, { id: 'import', bytes: 2 * GIB, day: DAY, now: NOW })).toBeUndefined();
    expect(shrinkImportHold(record, { id: 'gone', bytes: MIB, day: DAY, now: NOW })).toBeUndefined();
  });

  const freshCaller = () => anonymousUserId(`198.51.100.${crypto.randomInt(1, 255)}-${crypto.randomBytes(4).toString('hex')}`);

  async function heldImport(caller: string, limitBytes: number, holdId?: string) {
    const hold = await reserveLinkImport(caller, 'anonymous', IMPORT_DEADLINE_MS, limitBytes, holdId);
    if ('refusal' in hold) throw new Error(`refused: ${hold.refusal}`);
    return hold.reservation;
  }

  it('holds one file at the limit it is given, and the rest of the day when less is left', async () => {
    const caller = freshCaller();
    const first = await heldImport(caller, GIB);
    expect(first.held.bytes).toBe(GIB);
    await first.settle(1.5 * GIB);

    expect((await heldImport(caller, GIB)).held.bytes).toBe(0.5 * GIB);
  });

  it('refuses an import while other imports hold the rest of the day as held, and once the day is received as daily-bytes', async () => {
    const caller = freshCaller();
    const first = await heldImport(caller, GIB);
    const second = await heldImport(caller, GIB);

    expect(await reserveLinkImport(caller, 'anonymous', IMPORT_DEADLINE_MS, GIB)).toEqual({ refusal: 'held' });
    await first.settle(GIB);
    await second.settle(GIB);
    expect(await reserveLinkImport(caller, 'anonymous', IMPORT_DEADLINE_MS, GIB)).toEqual({ refusal: 'daily-bytes' });
  });

  it('replaces the hold an import of the same id left, so a retried import holds its bytes once', async () => {
    const caller = freshCaller();
    await heldImport(caller, GIB, 'graph_1:link');
    const retried = await heldImport(caller, GIB, 'graph_1:link');

    expect(await bytesBroughtInToday(caller)).toBe(GIB);
    await retried.settle(7 * MIB);
    expect(await bytesBroughtInToday(caller)).toBe(7 * MIB);
  });

  it('is settled once: a second settle of the same import charges nothing more', async () => {
    const caller = anonymousUserId(`198.51.100.${crypto.randomInt(1, 255)}-${crypto.randomBytes(4).toString('hex')}`);
    const hold = await reserveLinkImport(caller, 'anonymous', IMPORT_DEADLINE_MS);
    if ('refusal' in hold) throw new Error('refused');

    await hold.reservation.settle(5 * MIB);
    await hold.reservation.settle(5 * MIB);

    expect(await bytesBroughtInToday(caller)).toBe(5 * MIB);
  });
});
