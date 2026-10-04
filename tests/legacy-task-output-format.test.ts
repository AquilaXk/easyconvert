import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { graphScheduler } from '../src/lib/queue/graph';

/**
 * A legacy task chain produces the output of its final task. The job response and the stored
 * job record must report that format, not the top-level `targetFormat` or the last convert
 * stage: a chain ending in a thumbnail produces jpg/png, and an OCR stage produces pdf.
 */

const PDF_BASE64 = readFileSync(join(__dirname, 'fixtures', 'sample.pdf')).toString('base64');

async function apiKey(): Promise<string> {
  const email = `legacy_fmt_${Date.now()}_${Math.random().toString(36).slice(2)}@legacy.test`;
  const user = await userStore.createUser({ email, name: 'legacy-fmt', tier: 'pro' });
  const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'legacy-fmt', { scopes: ['convert:write'] });
  return secretKey;
}

async function submit(body: Record<string, unknown>): Promise<Response> {
  return createJob(
    new NextRequest('https://easyconvert.app/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await apiKey()}` },
      body: JSON.stringify({ filename: 'sample.pdf', inputBufferBase64: PDF_BASE64, ...body }),
    })
  );
}

describe('POST /api/v1/jobs reports the format of the final legacy task', () => {
  it.each([
    ['a thumbnail after a top-level PDF target', { targetFormat: 'pdf', tasks: [{ name: 't', operation: 'media.thumbnail', targetFormat: 'jpg' }] }, 'jpg'],
    [
      'a thumbnail followed by a pass-through optimize stage',
      { tasks: [{ name: 't', operation: 'media.thumbnail', targetFormat: 'png' }, { name: 'o', operation: 'optimize' }] },
      'png',
    ],
    ['an OCR stage after a top-level text target', { targetFormat: 'txt', tasks: [{ name: 'r', operation: 'ocr' }] }, 'pdf'],
  ])('reports the final output format for %s', async (_label, body, expected) => {
    const res = await submit(body);
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.targetFormat).toBe(expected);

    const state = await graphScheduler.getGraphState(json.jobId);
    expect(state?.targetFormat).toBe(expected);
  });
});
