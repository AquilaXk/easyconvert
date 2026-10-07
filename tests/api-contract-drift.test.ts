import { describe, it, expect } from 'vitest';
import { Validator } from '@seriousme/openapi-schema-validator';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { PIPELINE_OPERATIONS } from '../src/lib/api/contracts/enums';
import {
  PipelineTaskSchema,
  ConversionOptionsSchema,
  JobCreateRequestSchema,
  ProblemDetailsSchema,
  JobResourceSchema,
} from '../src/lib/api/contracts/schemas';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { validateOrProblem } from '../src/lib/api/contracts/validate';

describe('API Contract SSOT & Schema Drift Safeguards', () => {
  it('(a) validates OpenAPI 3.1 specification document using third-party OpenAPI schema validator', async () => {
    const res = await getOpenApiSpec();
    expect(res.status).toBe(200);

    const openApiSpec = await res.json();
    expect(openApiSpec.openapi).toBe('3.1.0');
    expect(openApiSpec.info.title).toContain('EasyConvert');

    const validator = new Validator();
    const validationResult = await validator.validate(openApiSpec);

    expect(validationResult.valid).toBe(true);
    expect(validationResult.errors).toBeUndefined();
  });

  it('(b) guarantees PipelineTaskSchema operation enum strictly mirrors PIPELINE_OPERATIONS SSOT', () => {
    const schemaOperationEnum = Array.from(PipelineTaskSchema.properties.operation.enum);
    const expectedOperations = [
      'convert',
      'ocr',
      'optimize',
      'thumbnail',
      'media.thumbnail',
      'archive',
      'archive/create',
      'archive.create',
      'metadata',
      'export/url',
    ];

    expect(schemaOperationEnum).toEqual(expectedOperations);
    expect(schemaOperationEnum).toEqual(Array.from(PIPELINE_OPERATIONS));
  });

  it('(c) verifies every format optionsSchema key across the registry exists in ConversionOptionsSchema', () => {
    const registryOptionKeys = new Set<string>();

    for (const format of Object.values(FORMAT_REGISTRY)) {
      if (format.optionsSchema) {
        for (const key of Object.keys(format.optionsSchema)) {
          registryOptionKeys.add(key);
        }
      }
    }

    expect(registryOptionKeys.size).toBeGreaterThan(15);
    const schemaPropertyKeys = Object.keys(ConversionOptionsSchema.properties);

    for (const registryKey of registryOptionKeys) {
      expect(schemaPropertyKeys).toContain(registryKey);
      const propDefinition = (ConversionOptionsSchema.properties as Record<string, any>)[registryKey];
      expect(propDefinition).toBeDefined();
      expect(typeof propDefinition).toBe('object');
    }
  });

  it('carries no planned marker on the media options that are now implemented', () => {
    const properties = ConversionOptionsSchema.properties as Record<string, any>;

    // aspectRatio, fastStart and duration were planned; the engines read them now, with ranges.
    for (const key of ['aspectRatio', 'fastStart', 'duration']) {
      expect(properties[key]).toBeDefined();
      expect(properties[key]['x-easyconvert-status']).toBeUndefined();
    }
    expect(properties.duration.exclusiveMinimum).toBe(0);
    expect(properties.fastStart.type).toBe('boolean');
    expect(properties.aspectRatio.oneOf).toHaveLength(2);

    // WP-40 promoted 'pages' to a fully active, supported conversion option
    expect(properties.pages).toBeDefined();
    expect(properties.pages['x-easyconvert-status']).toBeUndefined();

    // WP-43 promoted 'sheetIndex' and added 'sheetMode' as fully active, supported conversion options
    expect(properties.sheetIndex).toBeDefined();
    expect(properties.sheetIndex['x-easyconvert-status']).toBeUndefined();
    expect(properties.sheetMode).toBeDefined();
    expect(properties.sheetMode['x-easyconvert-status']).toBeUndefined();

    // WP-44a added 'video' and 'trim' as fully active, supported conversion options
    expect(properties.video).toBeDefined();
    expect(properties.video.type).toBe('object');
    expect(properties.video['x-easyconvert-status']).toBeUndefined();
    expect(properties.trim).toBeDefined();
    expect(properties.trim.type).toBe('object');
    expect(properties.trim['x-easyconvert-status']).toBeUndefined();

    // WP-44b added 'audio', 'subtitles', and 'thumbnail' as fully active, supported conversion options
    expect(properties.audio).toBeDefined();
    expect(properties.audio.type).toBe('object');
    expect(properties.audio['x-easyconvert-status']).toBeUndefined();
    expect(properties.subtitles).toBeDefined();
    expect(properties.subtitles.type).toBe('object');
    expect(properties.subtitles['x-easyconvert-status']).toBeUndefined();
    expect(properties.thumbnail).toBeDefined();
    expect(properties.thumbnail.type).toBe('object');
    expect(properties.thumbnail['x-easyconvert-status']).toBeUndefined();

    // WP-44c added 'packaging' as a fully active, supported conversion option
    expect(properties.packaging).toBeDefined();
    expect(properties.packaging.type).toBe('object');
    expect(properties.packaging['x-easyconvert-status']).toBeUndefined();
  });

  it('still rejects an option a schema marks planned with 422 option_not_supported', () => {
    // No shipped option is planned now, so the keyword is exercised on a schema of its own.
    const schema = { type: 'object', properties: { later: { type: 'string', 'x-easyconvert-status': 'planned' }, now: { type: 'string' } } };
    expect(validateOrProblem(schema, { now: 'x' }).ok).toBe(true);
    const rejected = validateOrProblem(schema, { later: 'x' });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('schema accepted a planned option');
    expect(rejected.problem.status).toBe(422);
    expect(rejected.problem.type).toBe('https://api.easyconvert.io/problems/option-not-supported');
    expect(rejected.problem.invalidParams?.map((p) => p.name)).toEqual(['later']);
  });

  it('enforces canonical $id URIs across all contract schemas', () => {
    expect(ConversionOptionsSchema.$id).toBe('https://easyconvert.local/schemas/conversion-options.json');
    expect(PipelineTaskSchema.$id).toBe('https://easyconvert.local/schemas/pipeline-task.json');
    expect(JobCreateRequestSchema.$id).toBe('https://easyconvert.local/schemas/job-create-request.json');
    expect(ProblemDetailsSchema.$id).toBe('https://easyconvert.local/schemas/problem-details.json');
    expect(JobResourceSchema.$id).toBe('https://easyconvert.local/schemas/job-resource.json');
  });

  it('guarantees /api/v1/jobs OpenAPI JSON request body is derived from JobCreateRequest contract', async () => {
    const res = await getOpenApiSpec();
    const openApiSpec = await res.json();
    const jobsPost = openApiSpec.paths['/api/v1/jobs'].post;
    const jsonReqSchema = jobsPost.requestBody.content['application/json'].schema;

    expect(jsonReqSchema.properties.tasks).toEqual(JobCreateRequestSchema.properties.tasks);
    expect(openApiSpec.components.schemas.JobCreateRequest).toEqual(JobCreateRequestSchema);
  });
});
