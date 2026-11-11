import { afterEach, describe, expect, it } from 'vitest';
import { setRetentionLedger, type RetentionLedger } from '../src/lib/storage/retention-ledger';
import { resultAvailabilities } from '../src/lib/storage/retention-service';
import { newRecord, resolveRetentionPolicy, type RetentionRecord } from '../src/lib/storage/result-retention';

/** A ledger that can only read key by key (the file ledger) answers a list of results the same way, through `get`. */
describe('availability of a list of results through a ledger without a batch read', () => {
  afterEach(() => setRetentionLedger(undefined));

  it('reads each retained key with get and leaves the others unknown', async () => {
    const policy = resolveRetentionPolicy({});
    const records = new Map<string, RetentionRecord>([['conversions/u1/a.json', newRecord('conversions/u1/a.json', Date.now(), policy)]]);
    const reads: string[] = [];
    setRetentionLedger({
      get: async (key: string) => (reads.push(key), records.get(key)),
    } as unknown as RetentionLedger);

    const answers = await resultAvailabilities(['conversions/u1/a.json', undefined, 'conversions/u1/missing.json', 'uploads/x.bin']);

    expect(answers.map((answer) => answer?.state)).toEqual(['available', undefined, undefined, undefined]);
    expect(reads).toEqual(['conversions/u1/a.json', 'conversions/u1/missing.json']);
  });
});
