import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as readSession } from '../src/app/api/auth/me/route';
import { fileSizeLimitProblem } from '../src/lib/api/file-size-limit';
import { buildOpenApiDocument } from '../src/lib/api/openapi';
import { WEBHOOK_SECRET } from './helpers/paddle-events';

/** The paid plans are on sale exactly when billing is configured: the 413 text, the API reference and the session answer follow it. */

const GIB = 1024 ** 3;
const BILLING_ENV = {
  PADDLE_API_KEY: 'pdl_sdbx_apikey_fixture',
  PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PADDLE_CLIENT_TOKEN: 'test_fixture_client_token',
  PADDLE_ENVIRONMENT: 'sandbox',
  PADDLE_PRICE_ID_PRO: 'pri_pro_fixture',
  PADDLE_PRICE_ID_ENTERPRISE: 'pri_enterprise_fixture',
};

function configure(on: boolean): void {
  for (const [name, value] of Object.entries(BILLING_ENV)) vi.stubEnv(name, on ? value : '');
}

afterEach(() => vi.unstubAllEnvs());

describe('the 413 of a file over the limit', () => {
  const detail = async () => ((await fileSizeLimitProblem({ id: 'user-1', tier: 'free' }, 3 * GIB, '/api/v1/jobs')?.json()) as { detail: string }).detail;

  it('names only the limit of the plan while billing is not configured', async () => {
    configure(false);
    expect(await detail()).toBe('File size 3 GiB exceeds the 1 GiB limit for the free plan.');
  });

  it('names the next plan once billing is configured', async () => {
    configure(true);
    expect(await detail()).toBe('File size 3 GiB exceeds the 1 GiB limit for the free plan. Pro allows files up to 5 GiB.');
  });
});

describe('the API reference', () => {
  const limitTexts = () => JSON.stringify(buildOpenApiDocument()).match(/\(([^()]*callers[^()]*)\)/g) ?? [];

  it('documents the limit of the free plan alone while billing is not configured', () => {
    configure(false);
    const texts = limitTexts();
    expect(texts.length).toBeGreaterThan(0);
    expect(new Set(texts)).toEqual(new Set(['(1 GiB for anonymous callers and accounts)', '(up to 1 GiB for anonymous callers and accounts)']));
  });

  it('documents the limits of every plan once billing is configured', () => {
    configure(true);
    const texts = limitTexts();
    expect(texts.length).toBeGreaterThan(0);
    expect(new Set(texts)).toEqual(
      new Set(['(1 GiB for anonymous callers and the free plan, 5 GiB for Pro, 10 GiB for Enterprise)', '(up to 1 GiB for anonymous callers and the free plan, 5 GiB for Pro, 10 GiB for Enterprise)'])
    );
  });
});

describe('the session answer', () => {
  const answer = async () => (await readSession(new NextRequest('http://localhost:3000/api/auth/me'))).json();

  it.each([false, true])('says paidPlansOnSale as billing is configured (%s)', async (configured) => {
    configure(configured);
    expect(await answer()).toMatchObject({ success: false, paidPlansOnSale: configured });
  });
});
