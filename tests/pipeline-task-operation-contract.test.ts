import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { LEGACY_TASK_OPERATIONS } from '../src/lib/jobs/graph';
import { PipelineTaskSchema } from '../src/lib/api/contracts/schemas';
import { validateOrProblem } from '../src/lib/api/contracts/validate';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';

/**
 * The PipelineTask schema used to accept operations that the legacy-task adapter always rejects,
 * so the contract promised stages no pipeline can run. The oracle is the adapter's own list of
 * translatable operations and a separately authored list of operations it refuses.
 */

const SCHEMA_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/unprocessable-entity';

/** Operations that `linearTasksToJobGraph` rejects with UNSUPPORTED_OPERATION or BYOS_OPERATION_UNSUPPORTED. */
const UNTRANSLATABLE_OPERATIONS = [
  'watermark',
  'pdf.watermark',
  'pdf.protect',
  'media.package',
  'import/url',
  'import/s3',
  'import/gcs',
  'import/azure',
  'import/sftp',
  'import/webdav',
  'export/s3',
  'export/gcs',
  'export/azure',
  'export/sftp',
  'export/webdav',
];

describe('PipelineTask operation contract', () => {
  it('advertises exactly the operations the legacy-task adapter translates', () => {
    const schemaOperations: readonly string[] = PipelineTaskSchema.properties.operation.enum;
    expect(new Set(schemaOperations).size).toBe(schemaOperations.length);
    expect([...schemaOperations].sort()).toEqual([...LEGACY_TASK_OPERATIONS].sort());
  });

  it('publishes the same operation enum in the OpenAPI document', async () => {
    const spec = await (await getOpenApiSpec()).json();
    const published: string[] = spec.components.schemas.PipelineTask.properties.operation.enum;
    expect([...published].sort()).toEqual([...LEGACY_TASK_OPERATIONS].sort());
  });

  it.each(UNTRANSLATABLE_OPERATIONS)('rejects "%s" at schema validation', (operation) => {
    const result = validateOrProblem(PipelineTaskSchema, { name: 'stage', operation, targetFormat: 'pdf' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`schema accepted ${operation}`);
    expect(result.problem.status).toBe(422);
    expect(result.problem.type).toBe(SCHEMA_PROBLEM_TYPE);
    expect(result.problem.invalidParams?.map((p) => p.name)).toEqual(['operation']);
  });

  it('accepts every translatable operation at schema validation', () => {
    for (const operation of LEGACY_TASK_OPERATIONS) {
      const result = validateOrProblem(PipelineTaskSchema, { name: 'stage', operation });
      expect(result.ok, operation).toBe(true);
    }
  });
});

describe('POST /api/v1/jobs with an untranslatable task operation', () => {
  it('answers 422 with the schema problem before reserving quota', async () => {
    const email = `ops_${Date.now()}_${Math.random().toString(36).slice(2)}@ops.test`;
    const user = await userStore.createUser({ email, name: 'ops', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'ops', { scopes: ['convert:write'] });
    const usedBefore = (await redisKeyStore.getQuotaUsage(user.id)).usedToday;

    const res = await createJob(
      new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({
          filename: 'report.pdf',
          targetFormat: 'pdf',
          inputBufferBase64: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64'),
          tasks: [{ name: 'lock', operation: 'pdf.protect' }],
        }),
      })
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.type).toBe(SCHEMA_PROBLEM_TYPE);
    expect(body.invalidParams).toContainEqual({
      name: 'tasks.0.operation',
      reason: 'must be equal to one of the allowed values',
    });
    expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(usedBefore);
  });
});
