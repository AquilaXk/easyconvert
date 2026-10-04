import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as jobsPostHandler } from '../src/app/api/v1/jobs/route';
import { POST as convertPostHandler } from '../src/app/api/v1/convert/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';

describe('API Request Schema Validation & Quota Conservation', () => {
  let testUser: any;
  let writeKey: { key: any; secretKey: string };

  beforeEach(async () => {
    const email = `val_test_${Date.now()}_${Math.random().toString(36).substring(7)}@easyconvert.local`;
    testUser = await userStore.createUser({
      name: 'Validation Tester',
      email,
      tier: 'pro',
    });

    writeKey = await redisKeyStore.generateApiKey(testUser.id, 'Validation Test Key', {
      scopes: ['convert:write', 'convert:read'],
    });
  });

  it('rejects invalid operation in tasks with 422 ProblemDetails without consuming quota', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${writeKey.secretKey}`,
      },
      body: JSON.stringify({
        filename: 'input.docx',
        targetFormat: 'pdf',
        inputBufferBase64: Buffer.from('dummy content').toString('base64'),
        tasks: [
          {
            name: 'stage-1',
            operation: 'transform', // Not in PIPELINE_OPERATIONS SSOT
            targetFormat: 'pdf',
          },
        ],
      }),
    });

    const res = await jobsPostHandler(req);
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const problem = await res.json();
    expect(problem.status).toBe(422);
    expect(problem.type).toBe('https://api.easyconvert.io/problems/unprocessable-entity');
    expect(problem.title).toBe('Unprocessable Entity');
    expect(problem.instance).toBe('/api/v1/jobs');
    expect(problem.success).toBe(false);
    expect(problem.invalidParams).toBeDefined();
    expect(problem.invalidParams.length).toBeGreaterThan(0);
    expect(problem.invalidParams.some((p: any) => p.name.includes('tasks') || p.name.includes('operation'))).toBe(true);

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
  });

  it('rejects out-of-range dpi option with 422 ProblemDetails without consuming quota', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${writeKey.secretKey}`,
      },
      body: JSON.stringify({
        filename: 'sample.png',
        targetFormat: 'webp',
        inputBufferBase64: Buffer.from('dummy png data').toString('base64'),
        options: {
          dpi: 1200, // Valid range is 72-600
        },
      }),
    });

    const res = await jobsPostHandler(req);
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const problem = await res.json();
    expect(problem.status).toBe(422);
    expect(problem.type).toBe('https://api.easyconvert.io/problems/unprocessable-entity');
    expect(problem.title).toBe('Unprocessable Entity');
    expect(problem.instance).toBe('/api/v1/jobs');
    expect(problem.invalidParams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringContaining('dpi'),
        }),
      ])
    );

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
  });

  it('rejects tasks when provided as an object instead of array with 422 ProblemDetails without consuming quota', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${writeKey.secretKey}`,
      },
      body: JSON.stringify({
        filename: 'document.pdf',
        targetFormat: 'txt',
        inputBufferBase64: Buffer.from('dummy pdf bytes').toString('base64'),
        tasks: {
          name: 'invalid-single-task-object',
          operation: 'convert',
          targetFormat: 'txt',
        }, // Must be an array
      }),
    });

    const res = await jobsPostHandler(req);
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const problem = await res.json();
    expect(problem.status).toBe(422);
    expect(problem.type).toBe('https://api.easyconvert.io/problems/unprocessable-entity');
    expect(problem.invalidParams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringContaining('tasks'),
        }),
      ])
    );

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
  });

  it('rejects planned options (sheetIndex, aspectRatio, fastStart, duration) with 422 option_not_supported and unchanged quota', async () => {
    const plannedOptionCases: Array<{ name: string; optionPayload: Record<string, any> }> = [
      { name: 'sheetIndex', optionPayload: { sheetIndex: 2 } },
      { name: 'aspectRatio', optionPayload: { aspectRatio: '16:9' } },
      { name: 'fastStart', optionPayload: { fastStart: true } },
      { name: 'duration', optionPayload: { duration: 45 } },
    ];

    for (const testCase of plannedOptionCases) {
      const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);

      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${writeKey.secretKey}`,
        },
        body: JSON.stringify({
          filename: 'test.mp4',
          targetFormat: 'mkv',
          inputBufferBase64: Buffer.from('dummy media bytes').toString('base64'),
          options: testCase.optionPayload,
        }),
      });

      const res = await jobsPostHandler(req);
      expect(res.status).toBe(422);
      expect(res.headers.get('content-type')).toContain('application/problem+json');

      const problem = await res.json();
      expect(problem.status).toBe(422);
      expect(problem.type).toBe('https://api.easyconvert.io/problems/option-not-supported');
      expect(problem.title).toBe('Option Not Supported');
      expect(problem.detail).toContain('option_not_supported');
      expect(problem.invalidParams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: expect.stringContaining(testCase.name),
            reason: 'option_not_supported',
          }),
        ])
      );

      const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
      expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
      expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
    }
  });

  it('rejects invalid options in multipart POST /api/v1/convert before quota reservation', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);

    const formData = new FormData();
    formData.append('file', new File(['sample image content'], 'sample.jpg', { type: 'image/jpeg' }));
    formData.append('targetFormat', 'png');
    formData.append('options', JSON.stringify({ dpi: 9999 })); // Out of bounds

    const req = new NextRequest('http://localhost:3000/api/v1/convert', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeKey.secretKey}`,
      },
      body: formData,
    });

    const res = await convertPostHandler(req);
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const problem = await res.json();
    expect(problem.status).toBe(422);
    expect(problem.type).toBe('https://api.easyconvert.io/problems/unprocessable-entity');
    expect(problem.invalidParams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'dpi',
        }),
      ])
    );

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
  });

  it('rejects planned options in multipart POST /api/v1/convert with 422 option_not_supported', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);

    const formData = new FormData();
    formData.append('file', new File(['document text'], 'document.pdf', { type: 'application/pdf' }));
    formData.append('targetFormat', 'txt');
    formData.append('options', JSON.stringify({ sheetIndex: 2 })); // Planned option

    const req = new NextRequest('http://localhost:3000/api/v1/convert', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeKey.secretKey}`,
      },
      body: formData,
    });

    const res = await convertPostHandler(req);
    expect(res.status).toBe(422);

    const problem = await res.json();
    expect(problem.status).toBe(422);
    expect(problem.type).toBe('https://api.easyconvert.io/problems/option-not-supported');
    expect(problem.detail).toContain('option_not_supported');

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
  });

  it('rejects invalid non-object options in multipart POST /api/v1/jobs with 422 ProblemDetails and unchanged quota', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

    const formData = new FormData();
    formData.append('file', new File([pngHeader], 'sample.png', { type: 'image/png' }));
    formData.append('targetFormat', 'webp');
    formData.append('options', '123'); // Primitive number, not a valid object

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeKey.secretKey}`,
      },
      body: formData,
    });

    const res = await jobsPostHandler(req);
    expect(res.status).toBe(422);

    const problem = await res.json();
    expect(problem.status).toBe(422);
    expect(problem.type).toBe('https://api.easyconvert.io/problems/unprocessable-entity');
    expect(problem.invalidParams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'must be object',
        }),
      ])
    );

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
  });

  it('rejects planned options in multipart POST /api/v1/jobs with 422 option_not_supported and unchanged quota', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

    const formData = new FormData();
    formData.append('file', new File([pngHeader], 'sample.png', { type: 'image/png' }));
    formData.append('targetFormat', 'webp');
    formData.append('options', JSON.stringify({ sheetIndex: 2 })); // Planned option

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeKey.secretKey}`,
      },
      body: formData,
    });

    const res = await jobsPostHandler(req);
    expect(res.status).toBe(422);

    const problem = await res.json();
    expect(problem.status).toBe(422);
    expect(problem.type).toBe('https://api.easyconvert.io/problems/option-not-supported');
    expect(problem.detail).toContain('option_not_supported');

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
  });

  it('rejects planned options inside multipart tasks in POST /api/v1/jobs with 422 option_not_supported and unchanged quota', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

    const formData = new FormData();
    formData.append('file', new File([pngHeader], 'sample.png', { type: 'image/png' }));
    formData.append('targetFormat', 'webp');
    formData.append('tasks', JSON.stringify([
      {
        name: 'extract-sheet',
        operation: 'convert',
        targetFormat: 'webp',
        options: { sheetIndex: 2 },
      },
    ]));

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeKey.secretKey}`,
      },
      body: formData,
    });

    const res = await jobsPostHandler(req);
    expect(res.status).toBe(422);

    const problem = await res.json();
    expect(problem.status).toBe(422);
    expect(problem.type).toBe('https://api.easyconvert.io/problems/option-not-supported');
    expect(problem.detail).toContain('option_not_supported');

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
  });

  it('rejects malformed JSON body in POST /api/v1/jobs with 400 Bad Request without consuming quota', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${writeKey.secretKey}`,
      },
      body: '{"targetFormat": "pdf", broken_json_payload',
    });

    const res = await jobsPostHandler(req);
    expect(res.status).toBe(400);

    const problem = await res.json();
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain('Invalid JSON body provided in request.');

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
  });

  it('accurately resolves nested missingProperty fieldPath when task operation is omitted', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${writeKey.secretKey}`,
      },
      body: JSON.stringify({
        filename: 'input.docx',
        targetFormat: 'pdf',
        inputBufferBase64: Buffer.from('dummy content').toString('base64'),
        tasks: [
          {
            name: 'stage-missing-operation',
            targetFormat: 'pdf',
          },
        ],
      }),
    });

    const res = await jobsPostHandler(req);
    expect(res.status).toBe(422);

    const problem = await res.json();
    expect(problem.status).toBe(422);
    expect(problem.invalidParams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'tasks.0.operation',
          reason: expect.stringContaining("must have required property 'operation'"),
        }),
      ])
    );

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining);
  });
});
