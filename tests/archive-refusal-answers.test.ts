import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { ArchiveEncryptedHeaderError, ConversionFailedError, isUnprocessableInputError, MissingVolumeError } from '../src/lib/types';

/**
 * An archive whose header is encrypted, or whose volume set lacks a part, is intact but cannot be read as sent: every route answers
 * 422 and a queued job fails once. Both errors used to extend `Error` directly, so the batch route answered 500 and the queue tried
 * the job again three times.
 */

vi.mock('../src/lib/conversions/dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/conversions/dispatch')>()),
  dispatchConversion: vi.fn(),
}));

afterEach(() => {
  vi.mocked(dispatchConversion).mockReset();
});

const CASES = [
  ['ArchiveEncryptedHeaderError', () => new ArchiveEncryptedHeaderError()],
  ['MissingVolumeError', () => new MissingVolumeError('archive.part2.rar')],
] as const;

describe.each(CASES)('%s', (name, make) => {
  it('is a typed, unprocessable conversion failure', () => {
    const error = make();
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(isUnprocessableInputError(error)).toBe(true);
  });

  it('fails a queued job once with its 422', () => {
    expect(classifyJobFailure(make())).toEqual({ code: name, status: 422, retryable: false });
  });

  it('answers 422 on POST /api/convert/batch', async () => {
    vi.mocked(dispatchConversion).mockRejectedValue(make());
    const body = new FormData();
    body.append('files', new File([new Uint8Array([1, 2, 3, 4])], 'a.zip'));
    body.append('targetFormats', JSON.stringify({ default: 'tar' }));
    const res = await batchPost(new NextRequest('http://localhost:3000/api/convert/batch', { method: 'POST', body }));
    expect(res.status).toBe(422);
  });
});
