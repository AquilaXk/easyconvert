import { describe, expect, it } from 'vitest';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { ConversionOptionsSchema } from '../src/lib/api/contracts/schemas';
import { validateOrProblem } from '../src/lib/api/contracts/validate';

/**
 * The CAD options of the public request contract. `outputUnit` is the one option STEP and IGES conversions take (the unit of the
 * result); the four options of the old in-process tessellator (sample grid, watertightness gate, crease angle) are gone, because
 * nothing applies them. A request that still sends one is not rejected: the options schema leaves unknown keys alone for every key.
 */

const REMOVED_OPTIONS = ['uSamples', 'vSamples', 'allowOpenMesh', 'smoothingAngleDeg'];

describe('CAD options contract', () => {
  it.each(['mm', 'cm', 'm', 'in'])('accepts the unit %s', (outputUnit) => {
    const result = validateOrProblem(ConversionOptionsSchema, { outputUnit });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ outputUnit });
  });

  it.each(['furlong', 'MM', '', 7])('rejects the unit %j with a 422', (outputUnit) => {
    const result = validateOrProblem(ConversionOptionsSchema, { outputUnit });
    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(422);
  });

  it('lists outputUnit and none of the removed options in the schema and in the OpenAPI document', async () => {
    const listed = Object.keys(ConversionOptionsSchema.properties);
    expect(listed).toContain('outputUnit');
    for (const name of REMOVED_OPTIONS) expect(listed, name).not.toContain(name);
    const document = JSON.stringify(await (await getOpenApiSpec()).json());
    expect(document).toContain('outputUnit');
    for (const name of REMOVED_OPTIONS) expect(document, name).not.toContain(name);
  });

  it('treats a removed option like any unknown key: the request is valid and the key is left alone', () => {
    const result = validateOrProblem(ConversionOptionsSchema, { uSamples: 8, allowOpenMesh: true, quality: 80 });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ quality: 80 });
  });
});
