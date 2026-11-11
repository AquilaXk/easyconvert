import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { GET as listJobsRoute } from '../src/app/api/queue/jobs/route';
import { GET as getJobRoute } from '../src/app/api/queue/jobs/[id]/route';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import { withoutEngineTrace } from '../src/lib/api/engine-trace';
import type { ConversionJobResult } from '../src/lib/types';

/**
 * The web application's own routes do not name the converters of the deployment or why one fell back: no page uses them, and
 * only the documented API (`/api/v1`, tests/engine-used-surface.test.ts) carries them, in a bounded and redacted form.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;

describe('withoutEngineTrace', () => {
  it('drops the two engine fields and keeps the rest', () => {
    expect(withoutEngineTrace({ filename: 'a.pdf', engineUsed: 'native-soffice', fallbackReason: 'x', size: 3 })).toEqual({ filename: 'a.pdf', size: 3 });
    expect(withoutEngineTrace(undefined)).toBeUndefined();
    expect(withoutEngineTrace({ result: { engineUsed: 'e', size: 1 }, state: 'completed' }, 'result')).toEqual({ result: { size: 1 }, state: 'completed' });
  });
});

describe('POST /api/convert', () => {
  it('answers the converted file without X-Engine-Used', async () => {
    const formData = new FormData();
    formData.append('file', new File(['col1,col2\nval1,val2'], 'test.csv', { type: 'text/csv' }));
    formData.append('targetFormat', 'ods');

    const res = await convertRoute(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: formData }));

    expect(res.status).toBe(HTTP_OK);
    expect(res.headers.has('x-engine-used')).toBe(false);
    expect(res.headers.has('x-fallback-reason')).toBe(false);
  });
});

describe('/api/queue/jobs', () => {
  it('shows the result of a finished job without the engine fields, in the list, the job view and the event stream', async () => {
    const user = await userStore.createUser({ name: 'Engine details', email: `engine_details_${Date.now()}_${Math.random().toString(36).slice(2)}@test.com`, tier: 'pro' });
    const cookie = { Cookie: `easyconvert_session=${createSessionToken(userStore.sanitizeUser(user))}` };
    const result: ConversionJobResult = {
      jobId: 'j',
      status: 'completed',
      resultKey: 'results/j/out.pdf',
      downloadUrl: '/api/storage/file/results%2Fj%2Fout.pdf',
      filename: 'out.pdf',
      mimeType: 'application/pdf',
      size: 1,
      durationMs: 1,
      engineUsed: 'native-soffice',
      fallbackReason: 'native-soffice: 38 words past the page edge',
    };
    const worker = new Worker(conversionQueue, async () => result, { concurrency: 1 });
    try {
      const finished = new Promise<void>((resolve) => worker.on('completed', () => resolve()));
      const job = await conversionQueue.add('convert', {
        jobId: '',
        originalFilename: 'a.docx',
        sourceFormat: 'docx',
        targetFormat: 'pdf',
        fileSize: 1,
        options: {},
        userId: user.id,
        inputBufferBase64: Buffer.from('x').toString('base64'),
      });
      await finished;

      const view = await (await getJobRoute(new NextRequest(`${BASE_URL}/api/queue/jobs/${job.id}`, { headers: cookie }), { params: Promise.resolve({ id: job.id }) })).json();
      const list = await (await listJobsRoute(new NextRequest(`${BASE_URL}/api/queue/jobs`, { headers: cookie }))).json();
      const stream = await getJobRoute(new NextRequest(`${BASE_URL}/api/queue/jobs/${job.id}?stream=true`, { headers: cookie }), { params: Promise.resolve({ id: job.id }) });
      const initial = await stream.body!.getReader().read();

      expect(view.returnvalue.filename).toBe('out.pdf');
      expect(view.returnvalue).not.toHaveProperty('engineUsed');
      expect(view.returnvalue).not.toHaveProperty('fallbackReason');
      const listed = (list.jobs as Array<{ id: string; returnvalue?: Record<string, unknown> }>).find((item) => item.id === job.id);
      expect(listed?.returnvalue?.filename).toBe('out.pdf');
      expect(listed?.returnvalue).not.toHaveProperty('engineUsed');
      const streamed = new TextDecoder().decode(initial.value);
      expect(streamed).toContain('out.pdf');
      expect(streamed).not.toContain('native-soffice');
    } finally {
      await worker.close();
    }
  });
});
