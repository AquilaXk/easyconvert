import { describe, expect, it, vi } from 'vitest';
import { SandboxedTimeoutError } from '../src/lib/security/process-sandbox';
import { CpuTaskTimeoutError } from '../src/lib/types';
import { classifyJobFailure } from '../src/lib/queue/job-failure';

/**
 * A render of a document or PDF that outruns the tool's time limit answers a typed refusal instead of an untyped crash
 * (#671). The engine is replaced by one that fails the way the sandbox reports a timeout; the expected answers come
 * from the error contract, not from the engine.
 */
const failures = vi.hoisted(() => ({ next: null as unknown }));
vi.mock('../src/worker/engines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/worker/engines')>()),
  executeWorkerConversion: vi.fn(async () => {
    throw failures.next;
  }),
}));

const { dispatchConversion } = await import('../src/lib/conversions/dispatch');
const HTTP_UNPROCESSABLE = 422;
const LIMIT_MS = 45_000;

describe('document conversions that outrun a tool limit', () => {
  it.each([
    ['xls', 'png'],
    ['pdf', 'svg'],
    ['ps', 'png'],
    ['xlsx', 'jpg'],
  ])('answers the typed 422 for a .%s to .%s render that timed out', async (source, target) => {
    failures.next = new SandboxedTimeoutError(LIMIT_MS);
    const error = await dispatchConversion(Buffer.from('x'), source, target, {}, `in.${source}`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CpuTaskTimeoutError);
    expect((error as Error).message).toBe(`The .${source} to .${target} conversion task exceeded its ${LIMIT_MS} ms time limit`);
    expect(classifyJobFailure(error)).toMatchObject({ status: HTTP_UNPROCESSABLE, retryable: false });
  });

  it('leaves the timeout of a media tool as it was', async () => {
    failures.next = new SandboxedTimeoutError(LIMIT_MS);
    await expect(dispatchConversion(Buffer.from('x'), 'mp4', 'webm', {}, 'in.mp4')).rejects.toThrow(`Process execution timed out after ${LIMIT_MS}ms`);
  });
});
