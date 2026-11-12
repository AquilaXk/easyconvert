import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/lib/api/openapi';
import { normalizeOpenApiForSdk } from '../scripts/lib/sdk-openapi';

/** What the SDK generators read (scripts/lib/sdk-openapi.ts) against the served document, which it must leave as it is. */

type Operation = { 'x-internal'?: boolean; parameters?: { in: string; schema?: { const?: string } }[] };
type Doc = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { $id?: string; properties?: Record<string, unknown> }> };
};

const served = JSON.stringify(buildOpenApiDocument());
const normalized = normalizeOpenApiForSdk(JSON.parse(served)) as Doc;
const text = JSON.stringify(normalized);

describe('the OpenAPI document as the SDK generators read it', () => {
  it('keeps public operations only', () => {
    const operations = Object.values(normalized.paths).flatMap((item) => Object.values(item));
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.filter((operation) => operation['x-internal'])).toEqual([]);
    expect(Object.keys(normalized.paths)).toContain('/api/v1/convert');
    expect(Object.keys(normalized.paths)).not.toContain('/api/auth/login');
  });

  it('refers to component schemas locally and drops their $id', () => {
    expect(text).not.toContain('easyconvert.local');
    expect(text).not.toContain('"$id"');
    // `tasks` is the array of a pipeline or the object of named tasks.
    expect(normalized.components.schemas.JobCreateRequest.properties?.tasks).toMatchObject({
      oneOf: [{ items: { $ref: '#/components/schemas/PipelineTask' } }, { additionalProperties: { $ref: '#/components/schemas/NamedTask' } }],
    });
  });

  it('moves the inline enums of ConversionOptions into components under distinct names', () => {
    const { schemas } = normalized.components;
    expect(schemas.ConversionOptions.properties?.audioChannels).toEqual({ $ref: '#/components/schemas/AudioChannels' });
    expect(schemas.AudioChannels).toMatchObject({ type: 'string', enum: ['mono', 'stereo', '5.1', '7.1'] });
    expect(schemas.ChannelsOfAudio).toMatchObject({ type: 'integer', enum: [1, 2, 6, 8] });
  });

  it('leaves no constant in a header parameter', () => {
    const headers = Object.values(normalized.paths)
      .flatMap((item) => Object.values(item))
      .flatMap((operation) => operation.parameters ?? [])
      .filter((parameter) => parameter.in === 'header');
    expect(headers.some((parameter) => parameter.schema?.const !== undefined)).toBe(false);
  });

  it('does not change the document it is given', () => {
    const input = JSON.parse(served) as object;
    normalizeOpenApiForSdk(input);
    expect(JSON.stringify(input)).toBe(served);
  });
});
