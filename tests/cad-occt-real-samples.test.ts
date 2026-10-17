import { describe, expect, it } from 'vitest';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { haveCadOracles } from './helpers/cad-kernel';
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
        const { buffer, mimeType } = await convertVectorCad(bytes, format, 'obj', {}, id);
        expect(mimeType).toBe('model/obj');
        const facts = meshFacts(buffer, 'obj');
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
        const { buffer } = await convertVectorCad(bytes, 'step', target, { outputUnit: unit }, ID);
        const facts = meshFacts(buffer, target);
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

describe.skipIf(!haveTools)('known defect: pyocc-testfile.igs', () => {
  // Rhino wrote this file with a wrong Hollerith count in its Global section (38 for the 32 characters of the file name), so the kernel
  // reads every following parameter one place late, takes the unit for inches and makes the model 25.4 times too large in every output
  // (and in the independent reader, which is the same kernel). The facts below do not come from the kernel: the Global section spells
  // the unit `2HMM`, and the control points of the file's one surface are in its parameter data. A repair of the Global section by the
  // specification (not by the file name) makes the ratio 1: this test then fails, and the expected ratio becomes 1 (issue #783 checklist row).
  const ID = 'pyocc-testfile.igs';
  const KERNEL_SCALE_OF_THE_DEFECT = 25.4;

  it('still reads the file at 25.4 times the size its own control points and unit name give', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, ID);
    const text = bytes.toString('latin1');
    expect(igesDeclaredUnitName(text)).toBe('MM');
    const points = igesFirstSurfaceControlPoints(text);
    const extentOfFile = [0, 1].map((axis) => Math.max(...points.map((p) => p[axis])) - Math.min(...points.map((p) => p[axis])));

    const { buffer } = await convertVectorCad(bytes, 'igs', 'stl', {}, ID);
    const facts = meshFacts(buffer, 'stl');
    const extentOfOutput = [0, 1].map((axis) => facts.max[axis] - facts.min[axis]);
    expect(extentOfOutput[0] / extentOfFile[0]).toBeCloseTo(KERNEL_SCALE_OF_THE_DEFECT, 3);
    expect(extentOfOutput[1] / extentOfFile[1]).toBeCloseTo(KERNEL_SCALE_OF_THE_DEFECT, 3);
  });
});
