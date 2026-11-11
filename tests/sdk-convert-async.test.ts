import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EasyConvertClient } from '../sdk/typescript/src/client';

/**
 * POST /api/v1/convert answers 202 with the queued job when the file is over the synchronous limit or the request sends
 * `Prefer: respond-async`, and takes the webhook of that job in the form (docs/policy-decisions.md, entry 232). The SDK sends all three
 * and does not read the JSON of a 202 as the bytes of a result.
 */

const ACCEPTED = { success: true, status: 'accepted', jobId: 'job_1', statusUrl: '/api/v1/jobs/job_1' };

afterEach(() => {
  vi.restoreAllMocks();
});

function client(): EasyConvertClient {
  return new EasyConvertClient({ apiKey: 'ec_live_test_dummy_key_1234567890', baseUrl: 'https://api.test' });
}

describe('the TypeScript client convert()', () => {
  it('sends Prefer: respond-async and the webhook fields, and returns the queued job', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(ACCEPTED), { status: 202 }));
    const answer = await client().convert({
      file: 'a,b\n1,2\n',
      filename: 'a.csv',
      targetFormat: 'json',
      respondAsync: true,
      webhookUrl: 'https://hooks.example.test/in',
      webhookSecret: 'whsec_test',
    });
    expect(answer).toEqual(ACCEPTED);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/v1/convert');
    expect((init.headers as Record<string, string>).Prefer).toBe('respond-async');
    const form = init.body as FormData;
    expect(form.get('webhookUrl')).toBe('https://hooks.example.test/in');
    expect(form.get('webhookSecret')).toBe('whsec_test');
  });

  it('returns the queued job, not its JSON as bytes, when raw is set and the server queued the conversion', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(ACCEPTED), { status: 202 }));
    expect(await client().convert({ file: 'x', targetFormat: 'pdf', raw: true })).toEqual(ACCEPTED);
  });

  it('returns the bytes of a finished raw conversion, and sends no Prefer header by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const answer = await client().convert({ file: 'x', targetFormat: 'pdf', raw: true });
    expect(new Uint8Array(answer as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/v1/convert?raw=true');
    expect(init.headers as Record<string, string>).not.toHaveProperty('Prefer');
  });
});

describe('the Python client convert()', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../sdk/python/easyconvert/client.py'), 'utf-8');
  const convert = source.slice(source.indexOf('    def convert('), source.indexOf('    def _create_job_multipart('));

  it('takes the Prefer preference and the webhook, and returns the JSON of a 202 whatever raw says', () => {
    expect(convert).toContain('respond_async: bool = False');
    expect(convert).toContain('webhook_url: Optional[str] = None');
    expect(convert).toContain('webhook_secret: Optional[str] = None');
    expect(convert).toContain('headers["Prefer"] = "respond-async"');
    expect(convert).toContain('data["webhookUrl"] = webhook_url');
    expect(convert.indexOf('resp.status_code == 202')).toBeGreaterThan(-1);
    expect(convert.indexOf('resp.status_code == 202')).toBeLessThan(convert.indexOf('return resp.content'));
  });
});
