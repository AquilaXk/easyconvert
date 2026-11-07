import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/conversions/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversions/dispatch')>();
  return { ...actual, dispatchConversion: vi.fn(actual.dispatchConversion) };
});

import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { JobTimeoutError } from '../src/lib/types';
import { instruments } from '../src/lib/metrics/instruments';
import { allSamples, reading, resetMetrics } from './helpers/metrics-readings';

/**
 * The convert routes count and time every answer by route, family of the source format and outcome (docs/slo.md). These tests
 * post to the real /api/convert handler, through the same wrapper the other convert routes use, and read the registry the scrape
 * endpoint renders.
 */

const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));
const SECRET_FILE_NAME = 'payroll-march-secret.pdf';
const SECRET_PASSWORD = 'hunter2-correct-horse';

let nextClient = 150;

function form(targetFormat: string, fileName = 'report.pdf', options?: object): FormData {
  const body = new FormData();
  body.append('file', new File([new Uint8Array(PDF)], fileName, { type: 'application/pdf' }));
  body.append('targetFormat', targetFormat);
  if (options) body.append('options', JSON.stringify(options));
  return body;
}

const post = (body: BodyInit) =>
  convertRoute(
    new NextRequest('http://localhost/api/convert', {
      method: 'POST',
      headers: { 'x-forwarded-for': `203.0.113.${nextClient++}` },
      body,
    })
  );

const requests = (labels: Record<string, string>) => reading('easyconvert_http_requests_total', labels);
const timed = (labels: Record<string, string>) => reading('easyconvert_http_request_duration_seconds_count', labels);

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  redisKeyStore.resetStore();
  resetMetrics();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the counters of /api/convert', () => {
  it('count an answered conversion as ok in the family of its source, and time it', async () => {
    const res = await post(form('docx'));

    expect(res.status).toBe(200);
    expect(await requests({ route: 'convert', family: 'document', outcome: 'ok' })).toBe(1);
    expect(await timed({ route: 'convert', family: 'document', outcome: 'ok' })).toBe(1);
    expect(await reading('easyconvert_http_request_duration_seconds_sum', { outcome: 'ok' })).toBeGreaterThan(0);
  });

  it('count a request the service turned away as refused', async () => {
    const res = await post(form('not-a-format'));

    expect(res.status).toBe(400);
    expect(await requests({ route: 'convert', outcome: 'refused' })).toBe(1);
    expect(await requests({ outcome: 'ok' })).toBe(0);
  });

  it('count an answer of the server that failed as failed', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new Error('the engine fell over'));

    const res = await post(form('docx'));

    expect(res.status).toBe(500);
    expect(await requests({ route: 'convert', family: 'document', outcome: 'failed' })).toBe(1);
  });

  it('count a conversion that ran past its deadline as timed_out', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new JobTimeoutError(1000));

    const res = await post(form('docx'));

    expect(res.status).toBe(504);
    expect(await requests({ route: 'convert', family: 'document', outcome: 'timed_out' })).toBe(1);
  });

  it('count the answers of the other convert routes under their own route', async () => {
    const headers = { 'x-forwarded-for': `203.0.113.${nextClient++}` };
    const v1 = await v1ConvertRoute(new NextRequest('http://localhost/api/v1/convert', { method: 'POST', headers, body: form('docx') }));
    const batch = await batchRoute(new NextRequest('http://localhost/api/convert/batch', { method: 'POST', headers, body: new FormData() }));

    expect(v1.status).toBe(401);
    expect(batch.status).toBeGreaterThanOrEqual(400);
    expect(batch.status).toBeLessThan(500);
    expect(await requests({ route: 'v1/convert', outcome: 'refused' })).toBe(1);
    expect(await requests({ route: 'convert/batch', outcome: 'refused' })).toBe(1);
    expect(await requests({ route: 'other' })).toBe(0);
  });

  it('count each answer once, whatever the outcome', async () => {
    await post(form('docx'));
    await post(form('docx'));
    await post(form('not-a-format'));

    expect(await requests({})).toBe(3);
    expect(await timed({})).toBe(3);
  });

  it('leave no file name, password or file byte in a label or anywhere in the scrape text', async () => {
    await post(form('docx', SECRET_FILE_NAME, { password: SECRET_PASSWORD }));
    await post(form('not-a-format', SECRET_FILE_NAME, { password: SECRET_PASSWORD }));

    const text = await instruments().registry.metrics();
    expect(text).toContain('easyconvert_http_requests_total');
    for (const secret of [SECRET_FILE_NAME, 'payroll', SECRET_PASSWORD, 'hunter2', 'report.pdf', '203.0.113', '%PDF']) {
      expect(text).not.toContain(secret);
    }
    const labelValues = new Set((await allSamples()).filter((sample) => sample.metricName.startsWith('easyconvert_')).flatMap((sample) => Object.values(sample.labels)));
    expect([...labelValues].filter((value) => !/^[0-9.]+$|^\+Inf$/.test(value)).sort()).toEqual(['convert', 'document', 'ok', 'refused'].sort());
  });
});
