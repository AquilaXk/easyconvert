import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { mtlMaterials, objFiles, objMaterialAreas } from './helpers/cad-obj-output';
import { haveCadOracles } from './helpers/cad-kernel';
import { getOracleToolPath } from './helpers/differential-oracle';
import { igesDeclaredUnitName, igesEntityCounts, igesFirstSurfaceControlPoints, igesLengthUnitFlag } from './helpers/iges-entities';
import { meshFacts } from './helpers/mesh-facts';
import { oracleFacts, type OracleMesh } from './helpers/occt-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { UnprocessableCadInputError } from '../src/lib/types';

/**
 * STEP and IGES conversions on the real files of the real-world corpus (bench/realworld/manifest.json), read by the Open CASCADE
 * program `cad-convert` (native/cad-convert) that the worker runs as a separate process. Two readers that this repository does
 * not contain judge every output, and the code under test is neither of them:
 * - occt-import-js, a separate WebAssembly build of the kernel with its own mesh settings, meshes the source file, and the file
 *   a converter wrote, so that surface area and bounding box (in millimetres) are compared;
 * - trimesh reads the STL and OBJ files that the program wrote, and the entity types of an IGES file and the entities of a STEP
 *   file are read by plain text parsing of the formats (tests/helpers/iges-entities.ts).
 * The old in-process tessellator read two of these eleven files and both wrongly (the cylinder of the first was dropped and its
 * metres were written as millimetres). Without the program or trimesh a run that is not strict skips; ORACLE_STRICT_MODE=1 fails.
 */

const haveTools = haveCadOracles;

/** The samples: all STEP and IGES files of the corpus, with what is known about each beyond the independent reader's mesh. */
const SAMPLES = [
  'cq-red_cube_blue_cylinder.step',
  'occt-bearing.iges',
  'occt-hammer.iges',
  'occt-screw.step',
  'pyocc-example_45_faces.iges',
  'pyocc-sunglasses_lens.igs',
  'pyocc-as1-oc-214.step',
  'pyocc-as1_pe_203.stp',
  'pyocc-eight_cyl.stp',
  'pyocc-io1-ug-214.stp',
] as const;

/** Share of the area that the meshes of one model may differ by: two meshers cut a curved surface into different triangles. */
const AREA_TOLERANCE = 0.01;
/** Share of the bounding-box diagonal that a corner of the box may differ by, for the same reason and for float32 coordinates. */
const BOX_TOLERANCE = 0.002;
const CONVERSION_TIMEOUT_MS = 120_000;
const MILLIMETRE_UNIT_FLAG = 2;

function expectBox(actual: { min: readonly number[]; max: readonly number[] }, truth: { min: readonly number[]; max: readonly number[] }): void {
  const diagonal = Math.hypot(...truth.max.map((value, axis) => value - truth.min[axis]));
  for (let axis = 0; axis < 3; axis++) {
    expect(Math.abs(actual.min[axis] - truth.min[axis]), `min[${axis}]`).toBeLessThanOrEqual(diagonal * BOX_TOLERANCE);
    expect(Math.abs(actual.max[axis] - truth.max[axis]), `max[${axis}]`).toBeLessThanOrEqual(diagonal * BOX_TOLERANCE);
  }
}

/**
 * A closed solid must have one winding all over its surface and a positive volume: a face the mesher turned the wrong way (the
 * reversed faces of the model, which the writer must swap back) makes trimesh report an inconsistent winding or a smaller or negative volume.
 * Open surface models are left out, because the faces of an IGES surface model come in the orientations the file gives them.
 */
function expectOutwardWhenClosed(facts: { watertight: boolean; windingConsistent: boolean; volume: number }): void {
  if (!facts.watertight) return;
  expect(facts.windingConsistent).toBe(true);
  expect(facts.volume).toBeGreaterThan(0);
}

function expectArea(actual: number, truth: number): void {
  expect(Math.abs(actual / truth - 1)).toBeLessThanOrEqual(AREA_TOLERANCE);
}

const truthOf = new Map<string, Promise<OracleMesh>>();

/** The independent reader's mesh of a source sample, read once per sample. */
function truth(id: string, bytes: Buffer, format: string): Promise<OracleMesh> {
  const kind = format === 'iges' || format === 'igs' ? 'iges' : 'step';
  if (!truthOf.has(id)) truthOf.set(id, oracleFacts(bytes, kind));
  return truthOf.get(id) as Promise<OracleMesh>;
}

const isIges = (format: string): boolean => format === 'iges' || format === 'igs';

/** The format a sample is written to for the exact B-rep route: STEP to IGES and IGES to STEP. */
const crossFormatOf = (format: string): 'iges' | 'step' => (isIges(format) ? 'step' : 'iges');
const crossFormatLabel = (sampleId: string): string => (/\.(iges|igs)$/.test(sampleId) ? 'STEP' : 'IGES');

describe.skipIf(!haveTools)('STEP and IGES samples through cad-convert', () => {
  for (const id of SAMPLES) {
    describe(id, () => {
      it('writes a binary STL in millimetres whose area and box match the independent mesher', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const { bytes, format } = await requireRealworldSample(ctx, id);
        const expected = await truth(id, bytes, format);
        const { buffer, mimeType } = await convertVectorCad(bytes, format, 'stl', {}, id);
        expect(mimeType).toBe('model/stl');
        expect(buffer.length).toBe(84 + 50 * buffer.readUInt32LE(80));
        const facts = meshFacts(buffer, 'stl');
        expect(facts.triangles).toBe(buffer.readUInt32LE(80));
        expectArea(facts.area, expected.area);
        expectBox(facts, expected);
        expectOutwardWhenClosed(facts);
      });

      it('writes an OBJ in millimetres with shared vertices whose area and box match the independent mesher', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const { bytes, format } = await requireRealworldSample(ctx, id);
        const expected = await truth(id, bytes, format);
        const result = await convertVectorCad(bytes, format, 'obj', {}, id);
        // A model with colours comes as the ZIP of the OBJ and its MTL file (the colour tests below), the others as the OBJ alone.
        expect(['model/obj', 'application/zip']).toContain(result.mimeType);
        const facts = meshFacts((await objFiles(result)).obj, 'obj');
        expectArea(facts.area, expected.area);
        expectBox(facts, expected);
        expectOutwardWhenClosed(facts);
        expect(facts.unmergedVertices).toBeLessThan(facts.triangles * 3);
      });

      it('draws one 3DFACE per triangle of the mesh in a DXF', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const { bytes, format } = await requireRealworldSample(ctx, id);
        const stl = meshFacts((await convertVectorCad(bytes, format, 'stl', {}, id)).buffer, 'stl');
        const { buffer, mimeType } = await convertVectorCad(bytes, format, 'dxf', {}, id);
        expect(mimeType).toBe('image/vnd.dxf');
        const faces = buffer.toString('utf-8').split('\n').filter((line) => line === '3DFACE').length;
        expect(faces).toBe(stl.triangles);
      });

      it('rewrites the B-rep in its own format and the independent reader meshes the same model', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const { bytes, format } = await requireRealworldSample(ctx, id);
        const expected = await truth(id, bytes, format);
        const { buffer } = await convertVectorCad(bytes, format, isIges(format) ? 'iges' : 'step', {}, id);
        const again = await oracleFacts(buffer, isIges(format) ? 'iges' : 'step');
        expectArea(again.area, expected.area);
        expectBox(again, expected);
      });

      it(`converts to ${crossFormatLabel(id)} as a B-rep, not a mesh, and the independent reader meshes the same model`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const { bytes, format } = await requireRealworldSample(ctx, id);
        const expected = await truth(id, bytes, format);
        const target = crossFormatOf(format);
        const { buffer, mimeType } = await convertVectorCad(bytes, format, target, {}, id);
        const text = buffer.toString('latin1');
        if (target === 'iges') {
          expect(mimeType).toBe('model/iges');
          const counts = igesEntityCounts(text);
          // One trimmed surface (144) per face of the model, bounded by curves and surfaces: no triangle soup.
          expect(counts.get(144)).toBe(expected.faces);
          const surfaces = [108, 120, 122, 128, 140, 190].reduce((sum, type) => sum + (counts.get(type) ?? 0), 0);
          expect(surfaces).toBeGreaterThan(0);
          expect(igesLengthUnitFlag(text)).toBe(MILLIMETRE_UNIT_FLAG);
        } else {
          expect(mimeType).toBe('model/step');
          expect(text.match(/ADVANCED_FACE/g)?.length).toBeGreaterThanOrEqual(expected.faces);
          expect(text).toContain('B_SPLINE_SURFACE_WITH_KNOTS');
          expect(text.replace(/\s+/g, '')).toContain('SI_UNIT(.MILLI.,.METRE.)');
        }
        const again = await oracleFacts(buffer, target);
        expectArea(again.area, expected.area);
        expectBox(again, expected);
      });
    });
  }
});

describe.skipIf(!haveTools)('the red cube and blue cylinder', () => {
  const ID = 'cq-red_cube_blue_cylinder.step';
  // The file is in metres: a cube of 0.01 and a cylinder of radius 0.005 (CYLINDRICAL_SURFACE) and height 0.01. In millimetres the
  // area is the cube (6 x 10 x 10) plus the cylinder (2 pi r h + 2 pi r r), the numbers of the file's own geometry.
  const CUBE_AREA = 6 * 10 * 10;
  const CYLINDER_AREA = 2 * Math.PI * 5 * 10 + 2 * Math.PI * 5 * 5;
  const EXPECTED_AREA = CUBE_AREA + CYLINDER_AREA;
  const FILE_BOX = { min: [-10, 0, 0], max: [15, 10, 10] };
  const EXPECTED_VOLUME = 10 ** 3 + Math.PI * 5 ** 2 * 10;

  it('keeps the cylinder and writes millimetres to STL', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, ID);
    const { buffer } = await convertVectorCad(bytes, 'step', 'stl', {}, ID);
    const facts = meshFacts(buffer, 'stl');
    // The cylinder is inscribed by triangles, so the mesh holds slightly less than the exact area; the cube alone is 600.
    expect(Math.abs(facts.area / EXPECTED_AREA - 1)).toBeLessThan(0.002);
    expect(facts.area).toBeGreaterThan(CUBE_AREA + 0.99 * CYLINDER_AREA);
    for (let axis = 0; axis < 3; axis++) {
      expect(facts.min[axis]).toBeCloseTo(FILE_BOX.min[axis], 3);
      expect(facts.max[axis]).toBeCloseTo(FILE_BOX.max[axis], 3);
    }
    expect(facts.watertight).toBe(true);
    expect(facts.windingConsistent).toBe(true);
    // The cube (10^3) and the cylinder (pi 5^2 x 10) of the file, as the signed volume of the triangles: the cylinder is inscribed, so
    // a little less than exact, and any face turned inside out would take its own volume away twice.
    expect(Math.abs(facts.volume / EXPECTED_VOLUME - 1)).toBeLessThan(0.003);
  });

  it('keeps both parts with their names and colours in STEP', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, ID);
    const text = (await convertVectorCad(bytes, 'step', 'stp', {}, ID)).buffer.toString('latin1');
    expect(text).toContain("PRODUCT('red_cube'");
    expect(text).toContain("PRODUCT('blue_cylinder'");
    const colours = new Set([...text.matchAll(/COLOUR_RGB\('[^']*',([^;]*)\)/g)].map((match) => match[1].replace(/\s+/g, '')));
    expect(colours.size).toBe(2);
  });

  it('keeps the colours in IGES as colour definition entities (314) and names the unit millimetre', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, ID);
    const text = (await convertVectorCad(bytes, 'step', 'igs', {}, ID)).buffer.toString('latin1');
    expect(igesEntityCounts(text).get(314)).toBeGreaterThanOrEqual(2);
    expect(igesLengthUnitFlag(text)).toBe(MILLIMETRE_UNIT_FLAG);
  });
});

describe.skipIf(!haveTools)('colours in OBJ', () => {
  const ID = 'cq-red_cube_blue_cylinder.step';
  const STEM = 'cq-red_cube_blue_cylinder';
  // The colours are the COLOUR_RGB of the STEP file itself, read from its text; the parts are the cube (6 x 10 x 10) and the cylinder.
  const RED = [0.8666666746, 0.3215686381, 0.1568627506];
  const BLUE = [0.2313725501, 0.380392164, 0.7058823705];
  const CUBE_AREA = 6 * 10 * 10;
  const CYLINDER_AREA = 2 * Math.PI * 5 * 10 + 2 * Math.PI * 5 * 5;

  function expectColour(actual: readonly number[] | undefined, expected: readonly number[], tolerance: number): void {
    expect(actual).toBeDefined();
    for (let channel = 0; channel < 3; channel++) expect(Math.abs((actual as readonly number[])[channel] - expected[channel])).toBeLessThanOrEqual(tolerance);
  }

  /** The material whose faces cover `area`, and its colour. */
  function colourOfPartWithArea(files: { obj: Buffer; mtl: Buffer | null }, area: number): readonly number[] | undefined {
    const colours = mtlMaterials(files.mtl as Buffer);
    const material = [...objMaterialAreas(files.obj)].find(([, covered]) => Math.abs(covered / area - 1) < 0.01);
    return material === undefined ? undefined : (colours.get(material[0]) ?? undefined);
  }

  it('comes with the colours of the STEP file in an MTL file, each on the faces of its own part', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, ID);
    const text = bytes.toString('latin1');
    expect(text).toContain('0.866666674600000, 0.321568638100000, 0.156862750600000');
    expect(text).toContain('0.231372550100000, 0.380392164000000, 0.705882370500000');

    const result = await convertVectorCad(bytes, 'step', 'obj', {}, ID);
    expect(result.mimeType).toBe('application/zip');
    expect(result.filename).toBe(`${STEM}.zip`);
    const files = await objFiles(result);
    expect(files.names).toEqual([`${STEM}.mtl`, `${STEM}.obj`]);
    expect(files.obj.toString('utf-8')).toMatch(new RegExp(`^mtllib ${STEM}\\.mtl$`, 'm'));
    expectColour(colourOfPartWithArea(files, CUBE_AREA), RED, 1e-5);
    expectColour(colourOfPartWithArea(files, CYLINDER_AREA), BLUE, 1e-5);
  });

  it('keeps the colours when the model went through IGES first, which stores them as percentages', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, ID);
    const iges = (await convertVectorCad(bytes, 'step', 'iges', {}, ID)).buffer;
    const files = await objFiles(await convertVectorCad(iges, 'iges', 'obj', {}, 'part.iges'));
    expect(files.mtl).not.toBeNull();
    expectColour(colourOfPartWithArea(files, CUBE_AREA), RED, 0.01);
    // The IGES file the kernel writes colours the two end faces of the cylinder and not its side, so the blue covers 2 pi r^2, not the part.
    expectColour(colourOfPartWithArea(files, 2 * Math.PI * 5 * 5), BLUE, 0.01);
  });

  it('is an OBJ alone, with no material file and no material, when the model holds no colour', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes, format } = await requireRealworldSample(ctx, 'occt-hammer.iges');
    const result = await convertVectorCad(bytes, format, 'obj', {}, 'hammer.iges');
    expect(result.mimeType).toBe('model/obj');
    expect(result.filename).toBe('hammer.obj');
    const text = result.buffer.toString('utf-8');
    expect(text).not.toMatch(/^(mtllib|usemtl) /m);
  });

  it('names the OBJ and its MTL file by the file name of the request, safe to read back, and the unit option scales the OBJ and not the colours', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, ID);
    const result = await convertVectorCad(bytes, 'step', 'obj', { outputUnit: 'cm' }, 'Müller part (1).step');
    expect(result.filename).toBe('Müller part (1).zip');
    const files = await objFiles(result);
    expect(files.names).toEqual(['M_ller_part__1_.mtl', 'M_ller_part__1_.obj']);
    expect(files.obj.toString('utf-8')).toMatch(/^mtllib M_ller_part__1_\.mtl$/m);
    expectColour(colourOfPartWithArea(files, CUBE_AREA * 0.01), RED, 1e-5);
  });

  it('is consistent for every sample: each material an OBJ uses is defined in the MTL file its mtllib line names', { timeout: CONVERSION_TIMEOUT_MS * 2 }, async (ctx) => {
    let withColours = 0;
    for (const id of SAMPLES) {
      const { bytes, format } = await requireRealworldSample(ctx, id);
      const files = await objFiles(await convertVectorCad(bytes, format, 'obj', {}, id));
      const obj = files.obj.toString('utf-8');
      const used = new Set([...obj.matchAll(/^usemtl (.+)$/gm)].map((match) => match[1]));
      if (files.mtl === null) {
        expect(obj, id).not.toMatch(/^mtllib /m);
        expect(used.size, id).toBe(0);
        continue;
      }
      withColours++;
      const library = /^mtllib (.+)$/m.exec(obj)?.[1];
      expect(files.names, id).toContain(library);
      const defined = new Set(mtlMaterials(files.mtl).keys());
      expect(used.size, id).toBeGreaterThan(0);
      for (const material of used) expect(defined.has(material), `${id}: ${material}`).toBe(true);
    }
    expect(withColours).toBeGreaterThanOrEqual(2);
  });
});

describe.skipIf(!haveTools)('the outputUnit option', () => {
  const ID = 'cq-red_cube_blue_cylinder.step';
  /** How many of each unit make one millimetre, and the unit flag IGES 5.3 gives it (Global parameter 14: 1 inch, 2 mm, 6 m, 10 cm). */
  const UNITS = [
    { unit: 'cm', perMillimetre: 0.1, igesFlag: 10, stepUnit: 'SI_UNIT(.CENTI.,.METRE.)' },
    { unit: 'm', perMillimetre: 0.001, igesFlag: 6, stepUnit: 'SI_UNIT($,.METRE.)' },
    { unit: 'in', perMillimetre: 1 / 25.4, igesFlag: 1, stepUnit: "CONVERSION_BASED_UNIT('INCH'" },
  ] as const;
  const CUBE_AND_CYLINDER_AREA_MM2 = 6 * 10 * 10 + 2 * Math.PI * 5 * 10 + 2 * Math.PI * 5 * 5;
  const FILE_BOX_MM = { min: [-10, 0, 0], max: [15, 10, 10] };

  for (const { unit, perMillimetre, igesFlag, stepUnit } of UNITS) {
    it(`writes STL and OBJ in ${unit}: the box scales by ${perMillimetre.toPrecision(4)} and the area by its square`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, ID);
      for (const target of ['stl', 'obj'] as const) {
        const result = await convertVectorCad(bytes, 'step', target, { outputUnit: unit }, ID);
        const facts = meshFacts(target === 'obj' ? (await objFiles(result)).obj : result.buffer, target);
        expect(Math.abs(facts.area / (CUBE_AND_CYLINDER_AREA_MM2 * perMillimetre ** 2) - 1), `${target} area`).toBeLessThan(0.002);
        for (let axis = 0; axis < 3; axis++) {
          expect(facts.min[axis], `${target} min[${axis}]`).toBeCloseTo(FILE_BOX_MM.min[axis] * perMillimetre, 5);
          expect(facts.max[axis], `${target} max[${axis}]`).toBeCloseTo(FILE_BOX_MM.max[axis] * perMillimetre, 5);
        }
      }
    });

    it(`writes STEP and IGES in ${unit}, declares it, and the independent reader still measures the same millimetres`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, ID);
      const expected = await truth(ID, bytes, 'step');
      const iges = (await convertVectorCad(bytes, 'step', 'iges', { outputUnit: unit }, ID)).buffer;
      expect(igesLengthUnitFlag(iges.toString('latin1'))).toBe(igesFlag);
      const fromIges = await oracleFacts(iges, 'iges');
      expectArea(fromIges.area, expected.area);
      expectBox(fromIges, expected);

      const step = (await convertVectorCad(bytes, 'step', 'step', { outputUnit: unit }, ID)).buffer;
      expect(step.toString('latin1').replace(/\s+/g, '')).toContain(stepUnit.replace(/\s+/g, ''));
      const fromStep = await oracleFacts(step, 'step');
      expectArea(fromStep.area, expected.area);
      expectBox(fromStep, expected);
    });
  }

  it('converts an IGES file to STEP in centimetres and the independent reader measures the same millimetres', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes, format } = await requireRealworldSample(ctx, 'occt-hammer.iges');
    const expected = await truth('occt-hammer.iges', bytes, format);
    const step = (await convertVectorCad(bytes, format, 'step', { outputUnit: 'cm' }, 'hammer')).buffer;
    expect(step.toString('latin1').replace(/\s+/g, '').match(/LENGTH_UNIT\(\)NAMED_UNIT\(\*\)SI_UNIT\(([^)]*)\)/)?.[1]).toBe('.CENTI.,.METRE.');
    const again = await oracleFacts(step, 'step');
    expectArea(again.area, expected.area);
    expectBox(again, expected);
  });
});

const EMPTY_STEP = Buffer.from(
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('a','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
);

const refusedWith = (reason: string): string => `The CAD converter could not convert this model: it exited with status ${reason}.`;
const NOT_STEP = refusedWith('3 (unreadable: the file is not a STEP file Open CASCADE can read)');
const NOT_IGES = refusedWith('3 (unreadable: the file is not an IGES file Open CASCADE can read)');
const NO_SHAPES = refusedWith('4 (no-shapes: the STEP file holds no shape that could be transferred)');

describe.skipIf(!haveTools)('files the kernel cannot use', () => {
  async function refusal(input: Buffer, source: string, target: string): Promise<Error> {
    try {
      await convertVectorCad(input, source, target, {}, `model.${source}`);
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected the conversion to fail');
  }

  /** A 422: the file is the problem, not the engine (an engine-unavailable answer would be retried on another worker). */
  function expectUnprocessable(failure: Error, message: string): void {
    expect(failure).toBeInstanceOf(UnprocessableCadInputError);
    expect((failure as UnprocessableCadInputError).status).toBe(422);
    expect(failure.message).toBe(message);
  }

  it('refuses text that is no STEP file with a 422 that names the reason', async () => {
    expectUnprocessable(await refusal(Buffer.from('this is not a model\n'), 'step', 'stl'), NOT_STEP);
  });

  it('refuses a STEP file under the name of IGES, and an IGES file under the name of STEP', async (ctx) => {
    const { bytes: step } = await requireRealworldSample(ctx, 'occt-screw.step');
    const { bytes: iges } = await requireRealworldSample(ctx, 'occt-hammer.iges');
    expectUnprocessable(await refusal(step, 'iges', 'stl'), NOT_IGES);
    expectUnprocessable(await refusal(iges, 'step', 'stl'), NOT_STEP);
  });

  it('refuses a STEP file cut off in its data with a 422', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'occt-screw.step');
    expectUnprocessable(await refusal(bytes.subarray(0, bytes.length / 2), 'step', 'obj'), NOT_STEP);
  });

  it('refuses an IGES file cut off in its data before the kernel reads it, where the kernel would convert part of the model or fault', async (ctx) => {
    for (const [id, share] of [['occt-hammer.iges', 0.5], ['occt-hammer.iges', 0.99], ['pyocc-testfile.igs', 0.75], ['pyocc-sunglasses_lens.igs', 0.9]] as const) {
      const { bytes } = await requireRealworldSample(ctx, id);
      const failure = await refusal(bytes.subarray(0, Math.floor(bytes.length * share)), 'iges', 'stl');
      expect(failure, `${id} cut at ${share}`).toBeInstanceOf(UnprocessableCadInputError);
      expect((failure as UnprocessableCadInputError).status).toBe(422);
      expect(failure.message, `${id} cut at ${share}`).toBe('The IGES file is cut off or damaged: it has no Terminate line where the format has one.');
    }
  });

  it('refuses an IGES file whose Terminate line counts a Parameter Data record the file does not hold, and names both counts', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'occt-hammer.iges');
    const text = bytes.toString('latin1');
    expect(text.trimEnd().split(/\r?\n/).at(-1)?.slice(0, 32)).toBe('S      1G      4D   1302P  11517');
    const damaged = Buffer.from(text.replace('P  11517', 'P  11518'), 'latin1');
    expectUnprocessable(
      await refusal(damaged, 'iges', 'step'),
      'The IGES file is cut off or damaged: its Terminate line counts 11,518 Parameter Data records, but the file holds 11,517.'
    );
  });

  it('refuses a STEP file whose entities refer to each other in a cycle and one cut off in the middle of an entity, without hanging', async () => {
    const cyclic = Buffer.from(
      "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Cyclic'), '2;1');\nFILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));\nENDSEC;\nDATA;\n" +
        "#10=ADVANCED_FACE('F', (#20), #30, .T.);\n#20=FACE_OUTER_BOUND('B', #40, .T.);\n#40=EDGE_LOOP('L', (#50));\n" +
        "#50=ORIENTED_EDGE('O', *, *, #60, .T.);\n#60=EDGE_CURVE('E', #70, #80, #60, .T.);\n#70=VERTEX_POINT('V', #10);\n" +
        "#80=VERTEX_POINT('W', #20);\n#30=PLANE('P', #10);\nENDSEC;\nEND-ISO-10303-21;"
    );
    expectUnprocessable(await refusal(cyclic, 'step', 'stl'), NO_SHAPES);
    expectUnprocessable(await refusal(Buffer.from('ISO-10303-21; HEADER; #10=CARTESIAN_POINT((('), 'step', 'stl'), NOT_STEP);
  });

  it('refuses a STEP file that holds no shape instead of writing an empty model', async () => {
    for (const target of ['stl', 'step', 'iges']) {
      expectUnprocessable(await refusal(EMPTY_STEP, 'step', target), NO_SHAPES);
    }
  });
});

describe.skipIf(!haveTools)('pyocc-testfile.igs, whose Global section counts 38 characters for a 32-character file name', () => {
  // Rhino wrote this file with a wrong Hollerith count in its Global section (38 for the 32 characters of the file name). The kernel
  // honours the count, so it read every following parameter one place late and took the unit for inches: the model came out 25.4 times
  // too large. The facts below do not come from the kernel: the Global section spells the unit `2HMM`, and the control points of the
  // file's one surface are in its parameter data. The worker repairs the count before the kernel reads the file (cad-iges-preflight.ts),
  // so the output has the size of the file's own numbers.
  const ID = 'pyocc-testfile.igs';

  it('writes the model at the size its own control points and unit name give', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, ID);
    const text = bytes.toString('latin1');
    expect(igesDeclaredUnitName(text)).toBe('MM');
    const points = igesFirstSurfaceControlPoints(text);
    const extentOfFile = [0, 1].map((axis) => Math.max(...points.map((p) => p[axis])) - Math.min(...points.map((p) => p[axis])));

    const { buffer } = await convertVectorCad(bytes, 'igs', 'stl', {}, ID);
    const facts = meshFacts(buffer, 'stl');
    const extentOfOutput = [0, 1].map((axis) => facts.max[axis] - facts.min[axis]);
    expect(extentOfOutput[0] / extentOfFile[0]).toBeCloseTo(1, 3);
    expect(extentOfOutput[1] / extentOfFile[1]).toBeCloseTo(1, 3);
  });
});

describe.skipIf(!haveTools)('the mesh input of the program, which a damaged or hostile input must not make allocate or crash', () => {
  const PROGRAM = getOracleToolPath('cad-convert') as string;

  /** The input form: vertex count, triangle count, float64 vertices, uint32 indices. */
  function meshFile(vertexCount: number, triangleCount: number, vertices: number[], indices: number[]): Buffer {
    const file = Buffer.alloc(8 + 8 * vertices.length + 4 * indices.length);
    file.writeUInt32LE(vertexCount, 0);
    file.writeUInt32LE(triangleCount, 4);
    vertices.forEach((value, i) => file.writeDoubleLE(value, 8 + 8 * i));
    indices.forEach((value, i) => file.writeUInt32LE(value, 8 + 8 * vertices.length + 4 * i));
    return file;
  }

  /** Runs the program on `file`; its exit status and the error line. */
  function run(file: Buffer): { status: number | null; stderr: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-mesh-'));
    try {
      fs.writeFileSync(path.join(dir, 'input.mesh'), file);
      const result = spawnSync(PROGRAM, ['--from', 'mesh', '--to', 'iges', path.join(dir, 'input.mesh'), path.join(dir, 'output.iges')], { encoding: 'utf8', timeout: 20_000 });
      return { status: result.status, stderr: result.stderr };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];

  it('writes a triangle and refuses every input that is not a mesh, each with its own exit status and message', () => {
    expect(run(meshFile(3, 1, TRIANGLE, [0, 1, 2])).status).toBe(0);
    const unreadable = (file: Buffer, message: string): void => {
      const result = run(file);
      expect(result.status, message).toBe(3);
      expect(result.stderr, message).toContain(message);
    };
    unreadable(Buffer.alloc(0), 'shorter than its header');
    unreadable(Buffer.alloc(5), 'shorter than its header');
    unreadable(meshFile(3, 1, TRIANGLE, [0, 1, 2]).subarray(0, 40), 'not the size its header gives');
    unreadable(Buffer.concat([meshFile(3, 1, TRIANGLE, [0, 1, 2]), Buffer.alloc(1)]), 'not the size its header gives');
    unreadable(meshFile(3, 1, TRIANGLE, [0, 1, 3]), 'names a vertex it does not list');
    unreadable(meshFile(3, 1, TRIANGLE, [0, 1, 0xffffffff]), 'names a vertex it does not list');
    unreadable(meshFile(3, 1, [0, 0, 0, 1, Number.NaN, 0, 0, 1, 0], [0, 1, 2]), 'not a finite number');
    unreadable(meshFile(3, 1, [0, 0, 0, 1, Number.POSITIVE_INFINITY, 0, 0, 1, 0], [0, 1, 2]), 'not a finite number');
  });

  it('allocates nothing for counts that the file does not hold, however large they are', () => {
    for (const [vertices, triangles] of [[0xffffffff, 1], [1, 0xffffffff], [0xffffffff, 0xffffffff], [0x80000000, 0]]) {
      const started = Date.now();
      const result = run(meshFile(vertices, triangles, [], []));
      expect(result.status, `${vertices} ${triangles}`).not.toBeNull();
      expect(result.status, `${vertices} ${triangles}`).toBeGreaterThan(0);
      expect(result.stderr).toMatch(/too-large|not the size its header gives/);
      expect(Date.now() - started).toBeLessThan(10_000);
    }
  });

  it('refuses more than 50,000 triangles with exit status 5 and the count and limit named', () => {
    const result = run(meshFile(3, 50_001, [], []));
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('too-large: the mesh has 50001 triangles; the most that is written is 50000');
  });

  it('writes a mesh close to the limit (49,928 triangles), and the kernel reads every triangle back', { timeout: 120_000 }, () => {
    const side = 158;
    const vertices: number[] = [];
    const indices: number[] = [];
    for (let j = 0; j <= side; j++) for (let i = 0; i <= side; i++) vertices.push(i, j, Math.sin(i / 20) * Math.cos(j / 20) * 3);
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const a = j * (side + 1) + i;
        indices.push(a, a + 1, a + side + 2, a, a + side + 2, a + side + 1);
      }
    }
    const triangles = indices.length / 3;
    expect(triangles).toBeLessThanOrEqual(50_000);
    expect(triangles).toBeGreaterThan(49_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-mesh-big-'));
    try {
      const input = path.join(dir, 'input.mesh');
      fs.writeFileSync(input, meshFile((side + 1) ** 2, triangles, vertices, indices));
      const written = spawnSync(PROGRAM, ['--from', 'mesh', '--to', 'iges', input, path.join(dir, 'output.iges')], { encoding: 'utf8', timeout: 100_000, maxBuffer: 1 << 24 });
      expect(written.status).toBe(0);
      const read = spawnSync(PROGRAM, ['--from', 'iges', '--to', 'stl', path.join(dir, 'output.iges'), path.join(dir, 'output.stl')], { encoding: 'utf8', timeout: 100_000, maxBuffer: 1 << 24 });
      expect(read.status).toBe(0);
      expect(fs.readFileSync(path.join(dir, 'output.stl')).readUInt32LE(80)).toBe(triangles);
      expect(fs.statSync(path.join(dir, 'output.iges')).size).toBeLessThan(256 * 1024 * 1024);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
