import { describe, it, expect } from 'vitest';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { ConversionOptionsSchema } from '../src/lib/api/contracts/schemas';
import { validateOrProblem } from '../src/lib/api/contracts/validate';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import type { ConversionOptions } from '../src/lib/types';

/**
 * The `background` image option (#rgb or #rrggbb) must be part of the public request contract, not only
 * of the engine: the JSON Schema validator rejects malformed colours with HTTP 422 details, the OpenAPI
 * document publishes the same pattern, and the image formats advertise the option in the registry.
 */

const VALID_COLOURS = ['#fff', '#FFF', '#ff0000', '#0A1b2C'];
const INVALID_COLOURS = ['red', '#12', '#12345', '#gggggg', 'ff0000', '#ff000080', '', 'rgb(1,2,3)'];
const IMAGE_FORMATS_WITH_FIT = Object.values(FORMAT_REGISTRY).filter(
  (format) => format.category === 'image' && format.optionsSchema?.fit
);

describe('background option contract', () => {
  it.each(VALID_COLOURS)('accepts %s', (background) => {
    const options: ConversionOptions = { background };
    const result = validateOrProblem(ConversionOptionsSchema, options);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ background });
  });

  it.each(INVALID_COLOURS)('rejects %j with a 422 problem naming the field', async (background) => {
    const result = validateOrProblem(ConversionOptionsSchema, { background });
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(422);
    const body = await result.response?.json();
    expect(JSON.stringify(body.invalidParams ?? body)).toContain('background');
  });

  it('rejects a non-string background', () => {
    const result = validateOrProblem(ConversionOptionsSchema, { background: 16711680 });
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(422);
  });

  it('is published in the OpenAPI document with the same pattern', async () => {
    const spec = await (await getOpenApiSpec()).json();
    const property = spec.components.schemas.ConversionOptions.properties.background;
    expect(property.type).toBe('string');
    expect(property.pattern).toBe('^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$');
    expect(property.description).toMatch(/white/i);
  });

  it('is advertised by every image format that supports fit', () => {
    expect(IMAGE_FORMATS_WITH_FIT.length).toBeGreaterThan(0);
    for (const format of IMAGE_FORMATS_WITH_FIT) {
      expect(format.optionsSchema?.background, `format ${format.id}`).toBe(true);
    }
  });
});
