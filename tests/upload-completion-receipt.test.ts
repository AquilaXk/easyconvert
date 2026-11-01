import { describe, it, expect, vi } from 'vitest';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';
import { getIdempotencyStore } from '../src/lib/api/idempotency';
import { StorageServiceError } from '../src/lib/storage/adapters/adapter-interface';
import { digestOfPartList } from '../src/lib/storage/upload-completion';
import { stripEtagQuotes } from '../src/lib/storage/etag';
import type { UploadCompletion } from '../src/lib/storage/result-retention';
import { ANONYMOUS_UPLOAD_OWNER } from '../src/lib/auth/anonymous-identity';
import { UNAVAILABLE_DETAIL, cleanups, from, multipart, stagedUpload, installUploadFlowHooks } from './helpers/anonymous-upload-flow';

installUploadFlowHooks();

describe('an ETag as a store and a client write it', () => {
  it.each([
    ['"abc"', 'abc'],
    ['abc', 'abc'],
    ['W/"abc"', 'W/abc'],
    ['""', ''],
    ['', ''],
  ])('reads %j as %j', (written, read) => {
    expect(stripEtagQuotes(written)).toBe(read);
  });
});

describe('the digest of a part list reads each entry as the completion reads it', () => {
  const digest = (parts: unknown) => digestOfPartList(parts);

  it('counts an omitted, an empty and a non-text ETag as the same entry, since the completion checks none of them', () => {
    const omitted = digest([{ partNumber: 1 }]);

    expect(digest([{ partNumber: 1, etag: '' }])).toBe(omitted);
    expect(digest([{ partNumber: 1, etag: undefined }])).toBe(omitted);
    expect(digest([{ partNumber: 1, etag: 7 }])).toBe(omitted);
  });

  it('counts a quoted and an unquoted ETag as the same entry, and a weak one as another', () => {
    expect(digest([{ partNumber: 1, etag: '"abc"' }])).toBe(digest([{ partNumber: 1, etag: 'abc' }]));
    expect(digest([{ partNumber: 1, etag: 'W/"abc"' }])).not.toBe(digest([{ partNumber: 1, etag: 'abc' }]));
  });

  it('tells lists apart by the number, the ETag, the order and the presence of an ETag', () => {
    const base = digest([{ partNumber: 1, etag: 'a' }, { partNumber: 2, etag: 'b' }]);

    expect(digest([{ partNumber: 1, etag: 'a' }, { partNumber: 3, etag: 'b' }])).not.toBe(base);
    expect(digest([{ partNumber: 1, etag: 'a' }, { partNumber: 2, etag: 'c' }])).not.toBe(base);
    expect(digest([{ partNumber: 2, etag: 'b' }, { partNumber: 1, etag: 'a' }])).not.toBe(base);
    expect(digest([{ partNumber: 1, etag: 'a' }, { partNumber: 2 }])).not.toBe(base);
  });

  it('gives a request that lists no part one digest, whether the list is absent or null, and an empty list another', () => {
    expect(digest(undefined)).toBe(digest(null));
    expect(digest([])).not.toBe(digest(undefined));
  });
});

describe('the receipt of a completion', () => {
  const RECEIPT_PREFIX = 'upload-completion/';
  const receiptReads = () => vi.spyOn(getRetentionLedger(), 'get');

  async function completedUpload(address: string) {
    const staged = await stagedUpload(address);
    /** Completes with the listed part, or with the list given as the one argument after the headers (`undefined` sends none). */
    const complete = (headers: Record<string, string>, ...list: [unknown?]) =>
      multipartPost(multipart('complete', { uploadId: staged.uploadId, parts: list.length > 0 ? list[0] : [{ partNumber: 1, etag: staged.etag }] }, headers));
    const firstBody = await (await complete(staged.visitor)).json();
    cleanups.push(() => {
      s3Storage.deleteObject(firstBody.key);
    });
    return { ...staged, complete, firstBody };
  }

  it('is told apart from a missing receipt: a receipt that cannot be read answers a repeat 503 with Retry-After, and the repeat after it is answered', async () => {
    const { visitor, complete, firstBody } = await completedUpload('203.0.113.91');
    const read = receiptReads().mockRejectedValueOnce(new Error('redis: connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const unreadable = await complete(visitor);

    expect(read).toHaveBeenCalled();
    expect(unreadable.status).toBe(503);
    expect(unreadable.headers.get('retry-after')).toBe('5');
    expect((await unreadable.json()).detail).toBe(UNAVAILABLE_DETAIL);
    const again = await complete(visitor);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(firstBody);
  });

  it('releases the key of an idempotent repeat that met an unreadable receipt, so the next repeat is answered', async () => {
    const staged = await stagedUpload('203.0.113.92');
    const headers = { ...staged.visitor, 'Idempotency-Key': `unreadable-${staged.uploadId}` };
    vi.spyOn(getIdempotencyStore(), 'complete').mockRejectedValue(new Error('redis: connection reset'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const complete = () => multipartPost(multipart('complete', { uploadId: staged.uploadId, parts: [{ partNumber: 1, etag: staged.etag }] }, headers));
    const firstBody = await (await complete()).json();
    cleanups.push(() => {
      s3Storage.deleteObject(firstBody.key);
    });
    receiptReads().mockRejectedValueOnce(new Error('redis: connection reset'));

    const unreadable = await complete();
    const answered = await complete();

    expect(unreadable.status).toBe(503);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual(firstBody);
  });

  it('answers a repeat that lists the same parts, whatever quotes the ETags carry, and no repeat that lists others', async () => {
    const { visitor, etag, complete, firstBody } = await completedUpload('203.0.113.93');

    const quoted = await complete(visitor, [{ partNumber: 1, etag: `"${etag.replace(/"/g, '')}"` }]);
    const otherTag = await complete(visitor, [{ partNumber: 1, etag: 'not-the-etag' }]);
    const otherNumber = await complete(visitor, [{ partNumber: 2, etag }]);
    const noList = await complete(visitor, undefined);
    const emptyList = await complete(visitor, []);

    expect(quoted.status).toBe(200);
    expect(await quoted.json()).toEqual(firstBody);
    for (const refused of [otherTag, otherNumber, noList, emptyList]) {
      expect(refused.status).toBe(404);
      expect((await refused.json()).detail).toBe('Upload session not found or has expired.');
    }
  });

  it('answers a repeat that lists a part without its ETag, or with an empty one, as the first request that did so', async () => {
    const staged = await stagedUpload('203.0.113.98');
    const complete = (parts: unknown) => multipartPost(multipart('complete', { uploadId: staged.uploadId, parts }, staged.visitor));
    const firstBody = await (await complete([{ partNumber: 1 }])).json();
    cleanups.push(() => {
      s3Storage.deleteObject(firstBody.key);
    });

    const omitted = await complete([{ partNumber: 1 }]);
    const empty = await complete([{ partNumber: 1, etag: '' }]);

    for (const repeat of [omitted, empty]) {
      expect(repeat.status).toBe(200);
      expect(await repeat.json()).toEqual(firstBody);
    }
  });

  it('answers a repeat of a completion that listed no part with a repeat that lists none', async () => {
    const staged = await stagedUpload('203.0.113.94');
    const complete = (parts?: unknown) => multipartPost(multipart('complete', { uploadId: staged.uploadId, parts }, staged.visitor));
    const firstBody = await (await complete()).json();
    cleanups.push(() => {
      s3Storage.deleteObject(firstBody.key);
    });

    expect(await (await complete()).json()).toEqual(firstBody);
    expect((await complete([{ partNumber: 1, etag: staged.etag }])).status).toBe(404);
  });

  it('keeps the owner the session recorded and the digest of the part list with the first answer', async () => {
    const ledger = getRetentionLedger();
    const update = ledger.update.bind(ledger);
    const written: UploadCompletion[] = [];
    vi.spyOn(ledger, 'update').mockImplementation(async (key, change) => {
      const record = await update(key, change);
      if (key.startsWith(RECEIPT_PREFIX) && record?.completion) written.push(record.completion);
      return record;
    });

    const { etag, firstBody } = await completedUpload('203.0.113.97');

    const { success: _success, ...answer } = firstBody;
    expect(written).toEqual([{ ownerUserId: ANONYMOUS_UPLOAD_OWNER, partsDigest: digestOfPartList([{ partNumber: 1, etag }]), result: answer }]);
  });

  it('looks up no receipt for an upload id that is not an id', async () => {
    const visitor = from('203.0.113.95');
    const read = receiptReads();

    for (const uploadId of ['x'.repeat(5000), 'up 1\n2']) {
      const res = await multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag: 'e' }] }, visitor));
      expect(res.status).toBe(404);
    }
    expect(read.mock.calls.filter(([key]) => String(key).startsWith(RECEIPT_PREFIX))).toEqual([]);
  });

  it('answers the repeat that an object store lets through to its ended session, from the receipt', async () => {
    const staged = await stagedUpload('203.0.113.96');
    const openSession = s3Storage.getUploadSession(staged.uploadId);
    const complete = (parts: unknown) => multipartPost(multipart('complete', { uploadId: staged.uploadId, parts }, staged.visitor));
    const listed = [{ partNumber: 1, etag: staged.etag }];
    const firstBody = await (await complete(listed)).json();
    cleanups.push(() => {
      s3Storage.deleteObject(firstBody.key);
    });
    vi.spyOn(s3Storage, 'getUploadSession').mockReturnValue(openSession);
    vi.spyOn(s3Storage, 'getUploadedParts').mockImplementation(() => {
      throw new StorageServiceError('Multipart upload no longer exists', 'oci', { statusCode: 404, code: 'NoSuchUpload', retryable: false });
    });

    const repeat = await complete(listed);
    const other = await complete([{ partNumber: 1, etag: 'other' }]);

    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(firstBody);
    expect(other.status).toBe(404);
  });
});
