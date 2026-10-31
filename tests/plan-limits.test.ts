import { describe, it, expect } from 'vitest';
import {
  LARGEST_PLAN_FILE_BYTES,
  PLAN_MAX_FILE_BYTES,
  fileLimitCopy,
  fileTooLargeMessage,
  maxFileBytes,
  nextLargerPlan,
  planOfCaller,
  type Plan,
} from '../src/lib/plan-limits';
import { fileSizeLimitProblem } from '../src/lib/api/file-size-limit';

const GIB = 1024 * 1024 * 1024;
const PLANS: readonly Plan[] = ['anonymous', 'free', 'pro', 'enterprise'];

describe('plan file size limits', () => {
  it('gives anonymous and free callers 1 GB, Pro 5 GB and Enterprise 10 GB', () => {
    expect(PLAN_MAX_FILE_BYTES).toEqual({ anonymous: GIB, free: GIB, pro: 5 * GIB, enterprise: 10 * GIB });
    expect(LARGEST_PLAN_FILE_BYTES).toBe(10 * GIB);
  });

  it('never lowers the limit from one plan to the next', () => {
    for (let i = 1; i < PLANS.length; i++) {
      expect(maxFileBytes(PLANS[i])).toBeGreaterThanOrEqual(maxFileBytes(PLANS[i - 1]));
    }
  });

  it('keeps the table frozen so a caller cannot raise a limit', () => {
    expect(Object.isFrozen(PLAN_MAX_FILE_BYTES)).toBe(true);
  });
});

describe('planOfCaller', () => {
  it('reads the plan from the tier of a signed-in caller', () => {
    expect(planOfCaller({ id: 'u1', tier: 'free' })).toBe('free');
    expect(planOfCaller({ id: 'u1', tier: 'pro' })).toBe('pro');
    expect(planOfCaller({ id: 'u1', tier: 'enterprise' })).toBe('enterprise');
  });

  it('treats an anonymous identity as anonymous whatever tier it carries', () => {
    expect(planOfCaller({ id: 'anon:203.0.113.0', tier: 'free' })).toBe('anonymous');
    expect(planOfCaller({ id: 'anon:203.0.113.0', tier: 'enterprise' })).toBe('anonymous');
    expect(planOfCaller(undefined)).toBe('anonymous');
    expect(planOfCaller(null)).toBe('anonymous');
  });

  it('gives a tier the table does not know, or none, the free limit', () => {
    expect(planOfCaller({ id: 'u1', tier: 'platinum' })).toBe('free');
    expect(planOfCaller({ id: 'u1' })).toBe('free');
    expect(planOfCaller({ id: 'u1', tier: '' })).toBe('free');
  });
});

describe('nextLargerPlan', () => {
  it('names the first plan with a larger limit, skipping a plan with the same one', () => {
    expect(nextLargerPlan('anonymous')).toBe('pro');
    expect(nextLargerPlan('free')).toBe('pro');
    expect(nextLargerPlan('pro')).toBe('enterprise');
    expect(nextLargerPlan('enterprise')).toBeUndefined();
  });
});

describe('copy', () => {
  it('states the limit of the plan under the drop zone', () => {
    expect(fileLimitCopy('anonymous')).toBe('Up to 1 GB per file');
    expect(fileLimitCopy('free')).toBe('Up to 1 GB per file');
    expect(fileLimitCopy('pro')).toBe('Up to 5 GB per file');
    expect(fileLimitCopy('enterprise')).toBe('Up to 10 GB per file');
  });

  it('names the size, the limit and the next plan in a too-large message', () => {
    expect(fileTooLargeMessage('anonymous', GIB + 1)).toBe(
      'File size 1,073,741,825 bytes exceeds the 1 GB limit for anonymous use. Pro allows files up to 5 GB.'
    );
    expect(fileTooLargeMessage('free', 3 * GIB)).toBe(
      'File size 3 GB exceeds the 1 GB limit for the free plan. Pro allows files up to 5 GB.'
    );
    expect(fileTooLargeMessage('pro', 6 * GIB)).toBe(
      'File size 6 GB exceeds the 5 GB limit for the Pro plan. Enterprise allows files up to 10 GB.'
    );
  });

  it('adds no upgrade hint for the plan with the largest limit', () => {
    expect(fileTooLargeMessage('enterprise', 11 * GIB)).toBe('File size 11 GB exceeds the 10 GB limit for the Enterprise plan.');
  });
});

describe('fileSizeLimitProblem', () => {
  const callers = [
    { plan: 'anonymous', caller: { id: 'anon:198.51.100.0', tier: 'free' }, limit: GIB, nextLimit: '5 GB' },
    { plan: 'free', caller: { id: 'u-free', tier: 'free' }, limit: GIB, nextLimit: '5 GB' },
    { plan: 'pro', caller: { id: 'u-pro', tier: 'pro' }, limit: 5 * GIB, nextLimit: '10 GB' },
    { plan: 'enterprise', caller: { id: 'u-ent', tier: 'enterprise' }, limit: 10 * GIB, nextLimit: undefined },
  ] as const;

  it.each(callers)('accepts a file of exactly the limit and refuses one byte more for $plan', async ({ caller, limit, nextLimit }) => {
    expect(fileSizeLimitProblem(caller, limit, '/api/convert')).toBeNull();
    expect(fileSizeLimitProblem(caller, 0, '/api/convert')).toBeNull();

    const refusal = fileSizeLimitProblem(caller, limit + 1, '/api/convert');
    expect(refusal?.status).toBe(413);
    expect(refusal?.headers.get('content-type')).toBe('application/problem+json');
    const body = await refusal!.json();
    expect(body).toMatchObject({
      status: 413,
      title: 'Payload Too Large',
      type: 'https://api.easyconvert.io/problems/payload-too-large',
      instance: '/api/convert',
      success: false,
    });
    expect(body.error).toBe(body.detail);
    if (nextLimit) expect(body.detail).toContain(`allows files up to ${nextLimit}`);
    else expect(body.detail).not.toContain('allows files up to');
  });

  it('carries the extra headers of the route on the refusal', () => {
    const refusal = fileSizeLimitProblem({ id: 'u', tier: 'free' }, GIB + 1, '/api/v1/uploads', { 'Tus-Resumable': '1.0.0' });
    expect(refusal?.headers.get('tus-resumable')).toBe('1.0.0');
  });
});
