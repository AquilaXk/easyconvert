import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { POST as queueJobsRoute } from '../src/app/api/queue/jobs/route';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { executeWorkerConversion } from '../src/worker/engines';
import { processNodeJob } from '../src/lib/queue/node-processor';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { ConversionFailedError, UnsupportedOptionError } from '../src/lib/types';

/**
 * Conversion options are a JSON object. Any other JSON value (null, an array, a number, a string,
 * a boolean) is a client error: the routes answer 400 before converting or queueing anything, and
 * the conversion boundaries throw a typed error instead of a TypeError (HTTP 500) or silently
 * spreading the value into an empty or index-keyed object.
 */

const BASE_URL = 'http://localhost:3000';
const CSV_INPUT = 'name,score\nAlice,100\n';
// Every JSON value that is not an object, as the multipart "options" field carries it.
const NON_OBJECT_OPTIONS = ['null', '[]', '[{"bom":true}]', '7', '"bom"', 'true'];
const ROUTE_ERROR = 'The "options" field must be a JSON object.';
const ENGINE_ERROR = 'Conversion options must be a JSON object.';

let apiKey = '';

beforeEach(async () => {
  const email = `options_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@options-object.test`;
  const user = await userStore.createUser({ email, name: 'Options Tester', tier: 'pro' });
  apiKey = (await redisKeyStore.generateApiKey(user.id, 'Options Test Key', { scopes: ['convert:write', 'convert:read'] })).secretKey;
});

function multipart(url: string, form: FormData): NextRequest {
  return new NextRequest(`${BASE_URL}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
}

function csvFile(): File {
  return new File([CSV_INPUT], 'scores.csv', { type: 'text/csv' });
}

describe('routes reject conversion options that are not a JSON object', () => {
  for (const raw of NON_OBJECT_OPTIONS) {
    it(`POST /api/convert answers 400 for options=${raw}`, async () => {
      const form = new FormData();
      form.append('file', csvFile());
      form.append('targetFormat', 'json');
      form.append('options', raw);
      const res = await convertRoute(multipart('/api/convert', form));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: ROUTE_ERROR });
    });

    it(`POST /api/convert/batch answers 400 for options=${raw}`, async () => {
      const form = new FormData();
      form.append('files', csvFile());
      form.append('options', raw);
      const res = await batchRoute(multipart('/api/convert/batch', form));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: ROUTE_ERROR });
    });

    it(`POST /api/queue/jobs (multipart) answers 400 for options=${raw}`, async () => {
      const form = new FormData();
      form.append('file', csvFile());
      form.append('targetFormat', 'json');
      form.append('options', raw);
      const res = await queueJobsRoute(multipart('/api/queue/jobs', form));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: ROUTE_ERROR });
    });

    it(`POST /api/queue/jobs (JSON body) answers 400 for options=${raw}`, async () => {
      const body = `{"filename":"scores.csv","targetFormat":"json","inputBufferBase64":"${Buffer.from(CSV_INPUT).toString('base64')}","options":${raw}}`;
      const req = new NextRequest(`${BASE_URL}/api/queue/jobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
      });
      const res = await queueJobsRoute(req);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: ROUTE_ERROR });
    });
  }

  it('POST /api/queue/jobs answers 400 for options that are not JSON instead of ignoring them', async () => {
    const form = new FormData();
    form.append('file', csvFile());
    form.append('targetFormat', 'json');
    form.append('options', '{bom: true');
    const res = await queueJobsRoute(multipart('/api/queue/jobs', form));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'Invalid JSON format for "options" parameter.' });
  });

  it('still converts with an absent or empty options field', async () => {
    for (const raw of [undefined, '', '{}']) {
      const form = new FormData();
      form.append('file', csvFile());
      form.append('targetFormat', 'json');
      if (raw !== undefined) form.append('options', raw);
      const res = await convertRoute(multipart('/api/convert', form));
      expect(res.status).toBe(200);
      expect(JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf-8'))).toEqual([{ name: 'Alice', score: '100' }]);
    }
  });
});

describe('conversion boundaries throw a typed error for non-object options', () => {
  const values: unknown[] = [null, [], 7, 'bom', true];

  it('dispatchConversion rejects them before any engine runs', async () => {
    for (const value of values) {
      const err = await dispatchConversion(Buffer.from(CSV_INPUT), 'csv', 'json', value as never, 'scores.csv').then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(UnsupportedOptionError);
      expect(err).toBeInstanceOf(ConversionFailedError);
      expect((err as Error).message).toBe(ENGINE_ERROR);
    }
  });

  it('the queue processor fails a job whose stored options are not an object', async () => {
    for (const value of values) {
      const job = {
        id: 'options-job',
        data: { jobId: 'options-job', originalFilename: 'scores.csv', sourceFormat: 'csv', targetFormat: 'json', options: value },
        log: async () => undefined,
        updateProgress: async () => undefined,
      };
      const err = await processNodeJob(job as never).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(UnsupportedOptionError);
      expect((err as Error).message).toBe(ENGINE_ERROR);
    }
  });

  it('the worker engine rejects them before reading any option', async () => {
    for (const value of values) {
      const err = await executeWorkerConversion(Buffer.from(CSV_INPUT), 'csv', 'json', value as never, 'scores.csv').then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(UnsupportedOptionError);
      expect((err as Error).message).toBe(ENGINE_ERROR);
    }
  });
});
