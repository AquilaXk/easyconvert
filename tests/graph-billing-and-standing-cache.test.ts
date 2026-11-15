import { describe, expect, it, vi } from 'vitest';
import { graphReservationUnits } from '../src/lib/jobs/graph-operations';
import { baseCredits } from '../src/lib/billing/credits';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';

describe('Graph admission class pricing & graphReservationUnits', () => {
  it('reserves baseCredits when source format is statically known from upstream import filename', () => {
    const units = graphReservationUnits({
      upload_doc: { op: 'import.upload', filename: 'report.docx' },
      to_pdf: { op: 'convert', input: 'upload_doc', targetFormat: 'pdf' },
      out: { op: 'export.internal', input: 'to_pdf' },
    });
    // docx -> pdf is office-to-pdf: 2 credits
    expect(units).toBe(2);
  });

  it('reserves baseCredits when upstream is URL with extension', () => {
    const units = graphReservationUnits({
      remote_sheet: { op: 'import.url', url: 'https://example.com/data.xlsx' },
      to_pdf: { op: 'convert', input: 'remote_sheet', targetFormat: 'pdf' },
    });
    // xlsx -> pdf is office-to-pdf: 2 credits
    expect(units).toBe(2);
  });

  it('reserves baseCredits when source format is known from upstream targetFormat in chained converts', () => {
    const units = graphReservationUnits({
      source_csv: { op: 'import.upload', filename: 'scores.csv' },
      step1: { op: 'convert', input: 'source_csv', targetFormat: 'xlsx' },
      step2: { op: 'convert', input: 'step1', targetFormat: 'pdf' },
    });
    // step1: csv -> xlsx is general: 1 credit
    // step2: xlsx -> pdf is office-to-pdf: 2 credits
    expect(units).toBe(1 + 2);
  });

  it('reserves 1 credit per input when source format is unknown at submission', () => {
    const units = graphReservationUnits({
      opaque_input: { op: 'import.upload' },
      to_pdf: { op: 'convert', input: 'opaque_input', targetFormat: 'pdf' },
    });
    expect(units).toBe(1);
  });
});

describe('1-second standing cache in withCreditTier', () => {
  it('caches standing for 1 second and re-queries after TTL expires or on invalidation', async () => {
    const fakeUserId = 'usr_cache_test_' + Date.now();
    let queryCount = 0;

    const ledgerMock = {
      packageStanding: vi.fn(async () => {
        queryCount++;
        return { balance: 10, held: 0 };
      }),
    };

    // Spy on ledger()
    const origLedger = (redisKeyStore as unknown as { ledger: () => unknown }).ledger;
    (redisKeyStore as unknown as { ledger: () => unknown }).ledger = () => ledgerMock;

    try {
      redisKeyStore.clearStandingCache(fakeUserId);

      const user = { id: fakeUserId, tier: 'free' as const };

      // Call 1: misses cache, queries ledger
      const res1 = await redisKeyStore.withCreditTier(user);
      expect(res1.tier).toBe('paid');
      expect(queryCount).toBe(1);

      // Call 2: within 1 second, hits cache, ledger query count unchanged
      const res2 = await redisKeyStore.withCreditTier(user);
      expect(res2.tier).toBe('paid');
      expect(queryCount).toBe(1);

      // Invalidate cache
      redisKeyStore.clearStandingCache(fakeUserId);

      // Call 3: re-queries ledger
      const res3 = await redisKeyStore.withCreditTier(user);
      expect(res3.tier).toBe('paid');
      expect(queryCount).toBe(2);
    } finally {
      (redisKeyStore as unknown as { ledger: () => unknown }).ledger = origLedger;
      redisKeyStore.clearStandingCache(fakeUserId);
    }
  });
});
