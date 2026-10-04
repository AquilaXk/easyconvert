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
      'archive',
      'optimize',
      'import/url',
      'import/s3',
      'import/gcs',
      'import/azure',
      'import/sftp',
      'import/webdav',
      'export/url',
      'export/s3',
      'export/gcs',
      'export/azure',
      'export/sftp',
      'export/webdav',
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

  it('marks all unread planned options with x-easyconvert-status: planned', () => {
    const plannedKeys = ['aspectRatio', 'fastStart', 'duration'];
    const properties = ConversionOptionsSchema.properties as Record<string, any>;

    for (const plannedKey of plannedKeys) {
      expect(properties[plannedKey]).toBeDefined();
      expect(properties[plannedKey]['x-easyconvert-status']).toBe('planned');
    }

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
    expect(properties.video['x-easyconvert-status']).toBeUndefined();
    expect(properties.trim).toBeDefined();
    expect(properties.trim['x-easyconvert-status']).toBeUndefined();
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
