import crypto from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { describe, it, expect, vi } from 'vitest';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { gzipServer } from './helpers/gzip-remote';
import { spendImportBytes } from './helpers/import-budget';
import {
  ANONYMOUS_DAILY_UPLOAD_BYTES,
  LINK_IMPORT_METER_BATCH_BYTES,
  bytesBroughtInToday,
  declaredBodyBytes,
  declaredOverflow,
  reserveAnonymousUpload,
  withLinkImportMeter,
  type MeterVerdict,
} from '../src/lib/api-keys/anonymous-upload-budget';
import { MemoryBudgetStore } from '../src/lib/api-keys/upload-budget-store';
import { URL_IMPORT_MAX_BYTES } from '../src/lib/plan-limits';

/**
 * How a link import is metered against the day's bytes of its caller (docs/policy-decisions.md, entry 15): which declared
 * length it can trust before reading, when it is refused before it starts, and how the bytes it receives are charged.
 * The fetch client of the lockfile (undici 6.29.1, `lib/web/fetch/index.js` lines 2118 to 2189) decodes gzip, deflate and br
 * by piping the body through decoders and keeps the header list as received, so a decoded body still carries the encoded
 * `Content-Length` (https://github.com/nodejs/undici/issues/2514, https://github.com/whatwg/fetch/issues/1524).
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const freshCaller = () => anonymousUserId(`198.51.100.${crypto.randomInt(1, 255)}-${crypto.randomBytes(4).toString('hex')}`);

const spend = (caller: string, bytes: number) => spendImportBytes(caller, 'anonymous', bytes);

/** An anonymous link import of `owner` reading at most the route's limit. */
const anonymousImport = (owner: string) => ({ owner, plan: 'anonymous' as const, limitBytes: URL_IMPORT_MAX_BYTES });

describe('the declared length of a body', () => {
  const headers = (fields: Record<string, string>) => new Headers(fields);

  it('is the Content-Length of a body sent as it is', () => {
    expect(declaredBodyBytes(headers({ 'content-length': '20000' }))).toBe(20_000);
    expect(declaredBodyBytes(headers({ 'content-length': '0', 'content-encoding': 'identity' }))).toBe(0);
  });

  it.each(['gzip', 'br', 'deflate', 'gzip, identity'])('is unknown for a body sent with Content-Encoding %s, whose Content-Length counts the encoded bytes', (encoding) => {
    expect(declaredBodyBytes(headers({ 'content-length': '61', 'content-encoding': encoding }))).toBeUndefined();
  });

  it.each(['', '-1', '1e3', '12.5', '0x10', '10, 10', '99999999999999999999'])('is unknown for the Content-Length %j, which is not one decimal length', (value) => {
    expect(declaredBodyBytes(headers({ 'content-length': value }))).toBeUndefined();
  });

  it('is unknown without a Content-Length', () => {
    expect(declaredBodyBytes(headers({}))).toBeUndefined();
  });

  it('is unknown for a gzipped answer the fetch client decoded, which keeps the encoded length and encoding in its headers', async () => {
    const csv = `name,score\n${'Alice,100\n'.repeat(2000)}`;
    const server = await gzipServer(csv);
    try {
      const res = await undiciFetch(server.url);
      const decoded = await res.text();

      expect(decoded).toBe(csv);
      expect([res.headers.get('content-encoding'), res.headers.get('content-length')]).toEqual(['gzip', String(server.compressedBytes)]);
      expect(declaredBodyBytes(res.headers)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('is refused past the import limit first, then past what the day has left, and fits otherwise', () => {
    const limits = { limitBytes: 100 * MIB, leftBytes: 30 * MIB };
    expect(declaredOverflow(200 * MIB, limits)).toEqual({ kind: 'too-large' });
    expect(declaredOverflow(40 * MIB, limits)).toEqual({ kind: 'larger-than-left', leftBytes: 30 * MIB });
    expect(declaredOverflow(30 * MIB, limits)).toBeUndefined();
    expect(declaredOverflow(undefined, limits)).toBeUndefined();
  });
});

describe('the meter of a link import', () => {
  it('refuses an import before it runs once the bytes received use up the day', async () => {
    const caller = freshCaller();
    await spend(caller, ANONYMOUS_DAILY_UPLOAD_BYTES);
    let ran = false;

    const refused = await withLinkImportMeter(anonymousImport(caller), async () => {
      ran = true;
    });

    expect(refused).toEqual({ refusal: 'daily-bytes' });
    expect(ran).toBe(false);
  });

  it('counts the bytes open uploads reserved as used when it admits an import', async () => {
    const caller = freshCaller();
    await spend(caller, ANONYMOUS_DAILY_UPLOAD_BYTES - GIB);
    const upload = await reserveAnonymousUpload(caller, GIB, Date.now() + 60_000);
    if ('refusal' in upload) throw new Error(`refused: ${upload.refusal}`);

    expect(await withLinkImportMeter(anonymousImport(caller), async () => undefined)).toEqual({ refusal: 'daily-bytes' });
    await upload.reservation.release();
    expect(await withLinkImportMeter(anonymousImport(caller), async (meter) => meter.leftBytes)).toEqual({ result: GIB });
  });

  it('charges each full batch as it arrives and the rest once the import ends', async () => {
    const caller = freshCaller();
    const seen: number[] = [];

    await withLinkImportMeter(anonymousImport(caller), async (meter) => {
      await meter.count(LINK_IMPORT_METER_BATCH_BYTES - 1);
      seen.push(await bytesBroughtInToday(caller));
      await meter.count(1);
      seen.push(await bytesBroughtInToday(caller));
      await meter.count(MIB);
    });

    expect(seen).toEqual([0, LINK_IMPORT_METER_BATCH_BYTES]);
    expect(await bytesBroughtInToday(caller)).toBe(LINK_IMPORT_METER_BATCH_BYTES + MIB);
  });

  it('answers that the day passed its budget at the batch that took it past, at most one batch over', async () => {
    const caller = freshCaller();
    await spend(caller, ANONYMOUS_DAILY_UPLOAD_BYTES - MIB);
    const answers: MeterVerdict[] = [];

    await withLinkImportMeter(anonymousImport(caller), async (meter) => {
      while (answers.at(-1) !== 'day-reached') answers.push(await meter.count(MIB));
    });

    expect(answers).toEqual(['ok', 'ok', 'ok', 'day-reached']);
    const charged = await bytesBroughtInToday(caller);
    expect(charged).toBe(ANONYMOUS_DAILY_UPLOAD_BYTES - MIB + LINK_IMPORT_METER_BATCH_BYTES);
    expect(charged).toBeLessThanOrEqual(ANONYMOUS_DAILY_UPLOAD_BYTES + LINK_IMPORT_METER_BATCH_BYTES);
  });

  it('answers at the end whether what is left of the last batch kept the day within its budget', async () => {
    const caller = freshCaller();
    await spend(caller, ANONYMOUS_DAILY_UPLOAD_BYTES - MIB);

    const fits = await withLinkImportMeter(anonymousImport(caller), async (meter) => {
      await meter.count(MIB);
      return meter.charge();
    });
    expect(fits).toEqual({ result: 'ok' });

    const other = freshCaller();
    await spend(other, ANONYMOUS_DAILY_UPLOAD_BYTES - MIB);
    const passes = await withLinkImportMeter(anonymousImport(other), async (meter) => {
      await meter.count(MIB + 1);
      return meter.charge();
    });
    expect(passes).toEqual({ result: 'day-reached' });
  });

  it('charges what an import received when it fails', async () => {
    const caller = freshCaller();

    await expect(
      withLinkImportMeter(anonymousImport(caller), async (meter) => {
        await meter.count(5 * MIB + 7);
        throw new Error('the remote reset the connection');
      })
    ).rejects.toThrow('the remote reset the connection');

    expect(await bytesBroughtInToday(caller)).toBe(5 * MIB + 7);
  });

  it('answers too-large for a batch that passes both the read limit and the day, as the route and a graph node both read it', async () => {
    const caller = freshCaller();
    await spend(caller, ANONYMOUS_DAILY_UPLOAD_BYTES - MIB);

    const answer = await withLinkImportMeter({ owner: caller, plan: 'anonymous', limitBytes: 3 * MIB }, (meter) => meter.count(LINK_IMPORT_METER_BATCH_BYTES));

    expect(answer).toEqual({ result: 'too-large' });
    expect(await bytesBroughtInToday(caller)).toBe(ANONYMOUS_DAILY_UPLOAD_BYTES - MIB + LINK_IMPORT_METER_BATCH_BYTES);
  });

  it('charges a batch whose charge failed with the last charge, so nothing it received goes uncharged', async () => {
    const caller = freshCaller();
    const update = MemoryBudgetStore.prototype.update;
    let writes = 0;
    vi.spyOn(MemoryBudgetStore.prototype, 'update').mockImplementation(async function (this: MemoryBudgetStore, ...args) {
      writes += 1;
      if (writes === 1) throw new Error('the store did not answer');
      return update.apply(this, args);
    });
    try {
      await expect(withLinkImportMeter(anonymousImport(caller), (meter) => meter.count(LINK_IMPORT_METER_BATCH_BYTES))).rejects.toThrow('the store did not answer');
    } finally {
      vi.restoreAllMocks();
    }

    expect(await bytesBroughtInToday(caller)).toBe(LINK_IMPORT_METER_BATCH_BYTES);
  });

  it('charges a batch once when its write landed but its answer was lost and the last charge writes it again', async () => {
    const caller = freshCaller();
    const update = MemoryBudgetStore.prototype.update;
    let writes = 0;
    vi.spyOn(MemoryBudgetStore.prototype, 'update').mockImplementation(async function (this: MemoryBudgetStore, ...args) {
      await update.apply(this, args);
      writes += 1;
      if (writes === 1) throw new Error('the answer was lost');
    });
    try {
      await expect(
        withLinkImportMeter(anonymousImport(caller), async (meter) => {
          await meter.count(LINK_IMPORT_METER_BATCH_BYTES);
        })
      ).rejects.toThrow('the answer was lost');
    } finally {
      vi.restoreAllMocks();
    }

    expect(await bytesBroughtInToday(caller)).toBe(LINK_IMPORT_METER_BATCH_BYTES);
  });

  it('charges once when the import charged its end itself before the meter closes', async () => {
    const caller = freshCaller();

    await withLinkImportMeter(anonymousImport(caller), async (meter) => {
      await meter.count(3 * MIB);
      return meter.charge();
    });

    expect(await bytesBroughtInToday(caller)).toBe(3 * MIB);
  });

  it('meters an account against its plan, in a budget of its own', async () => {
    const account = `user_meter_${crypto.randomBytes(4).toString('hex')}`;
    expect(await withLinkImportMeter({ owner: account, plan: 'pro', limitBytes: URL_IMPORT_MAX_BYTES }, async (meter) => meter.leftBytes)).toEqual({ result: 10 * GIB });
  });
});
