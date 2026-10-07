import { describe, it, expect } from 'vitest';
import {
  synthesizeCadNurbsCorpus,
  synthesizeCMapPdfCorpus,
  synthesizeHwp5CompoundCorpus,
  synthesizeMultiColumnDocumentCorpus,
  synthesizeDrawingMlTableCorpus,
  synthesizeVariableFontCorpus,
  synthesizeParquetColumnarCorpus,
  synthesizeAudioBitstreamCorpus,
} from './helpers/corpus-synthesizer';
import { compareImages, computeSsim, pixelmatch } from './helpers/vrt-engine';
import { renderDrawingMlToSvg } from '../src/lib/conversions/office';
import {
  evaluateBSplineCurve,
  evaluateBSplineSurface,
  evaluateSurfaceCurvature,
  tessellateBSplineSurfaceAdaptive,
  tessellateTrimmedFaceCDT,
  type TessellatedMesh,
} from '../src/lib/conversions/cad-nurbs';
import { CadGeometryError, CorruptStreamError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { xmlWellFormed, xpathCount, xpathString } from './helpers/xml-oracle';
import { parseToUnicodeCMap, recursiveXyCut } from '../src/lib/conversions/pdf-utils';
import { parseHwpDocument, hwpEquationToMathML, hwpEquationToLaTeX } from '../src/lib/conversions/hwp';
import sharp from 'sharp';

type ControlNet = ReadonlyArray<ReadonlyArray<{ x: number; y: number; z: number }>>;
type Vector3 = [number, number, number];

/** The corpus patch spans 30 units along x and y: x = 30u and y = 30v, because a Bezier patch reproduces a linear control grid. */
const SURFACE_EXTENT = 30;
const DISK_EULER_CHARACTERISTIC = 1;
const ANNULUS_EULER_CHARACTERISTIC = 0;
/** Flat triangles under-cover a curved patch by less than this fraction at the tessellation tolerances used. */
const MESH_AREA_TOLERANCE = 0.01;
/** Midpoint-rule cells per axis for the reference area; the integrand is smooth, so the error is far below the mesh tolerance. */
const AREA_GRID_CELLS = 300;
const ON_SURFACE_DIGITS = 6;
/** A graded constrained-Delaunay mesh of the trimmed patch measures 1.2 % to 1.7 % above the integral; flat facets of unequal size do not converge from below. */
const TRIMMED_MESH_AREA_TOLERANCE = 0.02;
const LOOP_SAMPLES_PER_SIDE = 8;
/** EMU (English Metric Units) in one point. */
const EMU_PER_POINT = 12700;

/** Bernstein basis of degree 3 and its first and second derivatives, written out from the definition. */
function bernstein(t: number): { value: number[]; first: number[]; second: number[] } {
  const s = 1 - t;
  return {
    value: [s ** 3, 3 * t * s ** 2, 3 * t ** 2 * s, t ** 3],
    first: [-3 * s ** 2, 3 * s ** 2 - 6 * t * s, 6 * t * s - 3 * t ** 2, 3 * t ** 2],
    second: [6 * s, -12 * s + 6 * t, 6 * s - 12 * t, 6 * t],
  };
}

/** Sum of control points weighted by `uWeights[i] * vWeights[j]`. */
function combine(net: ControlNet, uWeights: number[], vWeights: number[]): Vector3 {
  const out: Vector3 = [0, 0, 0];
  net.forEach((row, i) =>
    row.forEach((control, j) => {
      const weight = uWeights[i] * vWeights[j];
      out[0] += weight * control.x;
      out[1] += weight * control.y;
      out[2] += weight * control.z;
    })
  );
  return out;
}

const dot3 = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Gaussian and mean curvature from the fundamental forms with exact Bernstein derivatives. */
function bezierCurvature(net: ControlNet, u: number, v: number): { K: number; H: number } {
  const bu = bernstein(u);
  const bv = bernstein(v);
  const pu = combine(net, bu.first, bv.value);
  const pv = combine(net, bu.value, bv.first);
  const puu = combine(net, bu.second, bv.value);
  const puv = combine(net, bu.first, bv.first);
  const pvv = combine(net, bu.value, bv.second);
  const cross = cross3(pu, pv);
  const length = Math.sqrt(dot3(cross, cross));
  const n: Vector3 = [cross[0] / length, cross[1] / length, cross[2] / length];
  const [E, F, G] = [dot3(pu, pu), dot3(pu, pv), dot3(pv, pv)];
  const [L, M, N] = [dot3(puu, n), dot3(puv, n), dot3(pvv, n)];
  const det = E * G - F * F;
  return { K: (L * N - M * M) / det, H: (E * N - 2 * F * M + G * L) / (2 * det) };
}

/** Area of the patch over the parameter cells whose centre satisfies `include`: the integral of |Pu x Pv|. */
function bezierArea(net: ControlNet, include: (u: number, v: number) => boolean): number {
  let area = 0;
  const cell = 1 / AREA_GRID_CELLS;
  for (let i = 0; i < AREA_GRID_CELLS; i++) {
    for (let j = 0; j < AREA_GRID_CELLS; j++) {
      const u = (i + 0.5) * cell;
      const v = (j + 0.5) * cell;
      if (!include(u, v)) continue;
      const bu = bernstein(u);
      const bv = bernstein(v);
      const cross = cross3(combine(net, bu.first, bv.value), combine(net, bu.value, bv.first));
      area += Math.sqrt(dot3(cross, cross)) * cell * cell;
    }
  }
  return area;
}

/** Cuts every side of a closed parametric loop into `segments` equal segments. */
function sampleLoop(loop: Array<{ u: number; v: number }>, segments: number): Array<{ u: number; v: number }> {
  return loop.flatMap((from, i) => {
    const to = loop[(i + 1) % loop.length];
    return Array.from({ length: segments }, (_, k) => ({ u: from.u + ((to.u - from.u) * k) / segments, v: from.v + ((to.v - from.v) * k) / segments }));
  });
}

/** Area of the mesh projected onto the xy plane. */
function projectedArea(mesh: TessellatedMesh): number {
  let area = 0;
  for (const [a, b, c] of mesh.faces) {
    const [p, q, r] = [mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]];
    area += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2;
  }
  return area;
}

function meshArea(mesh: TessellatedMesh): number {
  let area = 0;
  for (const [a, b, c] of mesh.faces) {
    const [p, q, r] = [mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]];
    const cross = cross3([q[0] - p[0], q[1] - p[1], q[2] - p[2]], [r[0] - p[0], r[1] - p[1], r[2] - p[2]]);
    area += Math.sqrt(dot3(cross, cross)) / 2;
  }
  return area;
}

/** Every vertex satisfies the surface equation: (x, y) fixes (u, v), and z must be the patch height there. */
function expectMeshOnBezierSurface(mesh: TessellatedMesh, net: ControlNet): void {
  expect(mesh.vertices.length).toBeGreaterThan(0);
  for (const [x, y, z] of mesh.vertices) {
    const surfacePoint = combine(net, bernstein(x / SURFACE_EXTENT).value, bernstein(y / SURFACE_EXTENT).value);
    expect(surfacePoint[0]).toBeCloseTo(x, ON_SURFACE_DIGITS);
    expect(surfacePoint[1]).toBeCloseTo(y, ON_SURFACE_DIGITS);
    expect(z).toBeCloseTo(surfacePoint[2], ON_SURFACE_DIGITS);
  }
}

/** Edge use counts, Euler characteristic (vertices used - edges + faces) and the number of closed boundary loops, from the triangle list alone. */
function meshTopology(mesh: TessellatedMesh): { edgeUseCounts: number[]; eulerCharacteristic: number; boundaryLoops: number } {
  const uses = new Map<string, number>();
  const used = new Set<number>();
  for (const face of mesh.faces) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [face[k], face[(k + 1) % 3]];
      used.add(a);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  // Boundary edges (used once) form closed loops: count connected components of the boundary graph.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  for (const [key, count] of uses) {
    if (count !== 1) continue;
    const [a, b] = key.split('-').map(Number);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const loops = new Set([...parent.keys()].map(find));
  return { edgeUseCounts: [...uses.values()], eulerCharacteristic: used.size - uses.size + mesh.faces.length, boundaryLoops: loops.size };
}

describe('Phase 4: Universal Golden Binary Corpus & Visual Regression CI Gate (#70)', () => {
  // =========================================================================
  // 1. CAD NURBS & 2D CDT Trimmed Face Golden Corpus
  // =========================================================================
  describe('1. CAD NURBS & 2D CDT Trimmed Face Golden Corpus', () => {
    it('synthesizes bicubic B-Spline surface with accurate midpoint and curvature tensors', () => {
      const corpus = synthesizeCadNurbsCorpus();

      expect(corpus.surface.uDegree).toBe(3);
      expect(corpus.surface.vDegree).toBe(3);
      expect(corpus.surface.controlPoints.length).toBe(4);
      expect(corpus.surface.controlPoints[0].length).toBe(4);

      // A bicubic surface with the clamped knot vector [0,0,0,0,1,1,1,1] is a Bezier patch, so its point at (u, v)
      // is the sum of control points weighted by Bernstein polynomials: an evaluation that shares no code with the
      // Cox-de Boor routine under test. The midpoint of the corpus is checked, and the evaluator at a grid.
      const bernstein = (t: number): number[] => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      const bezierPoint = (u: number, v: number) => {
        const bu = bernstein(u);
        const bv = bernstein(v);
        const point = { x: 0, y: 0, z: 0 };
        corpus.surface.controlPoints.forEach((row, i) =>
          row.forEach((control, j) => {
            point.x += bu[i] * bv[j] * control.x;
            point.y += bu[i] * bv[j] * control.y;
            point.z += bu[i] * bv[j] * control.z;
          })
        );
        return point;
      };
      expect(bezierPoint(0.5, 0.5)).toEqual({ x: 15, y: 15, z: 5.25 });
      expect(corpus.midPoint).toEqual({ x: 15, y: 15, z: 5.25 });
      for (const u of [0, 0.125, 0.5, 0.75, 1]) {
        for (const v of [0, 0.3, 0.5, 1]) {
          const evaluated = evaluateBSplineSurface(corpus.surface, u, v).point;
          const expected = bezierPoint(u, v);
          expect(evaluated.x).toBeCloseTo(expected.x, 9);
          expect(evaluated.y).toBeCloseTo(expected.y, 9);
          expect(evaluated.z).toBeCloseTo(expected.z, 9);
        }
      }

      // Gaussian and mean curvature of the Bezier patch from the first and second fundamental forms, with the
      // derivatives of the Bernstein basis written out: no finite differences, nothing shared with the evaluator.
      const analytic = bezierCurvature(corpus.surface.controlPoints, 0.5, 0.5);
      expect(analytic.K).toBeCloseTo(1 / 900, 12);
      expect(analytic.H).toBeCloseTo(-1 / 30, 12);
      const measured = evaluateSurfaceCurvature(corpus.surface, 0.5, 0.5);
      expect(measured.gaussianCurvature).toBeCloseTo(analytic.K, 6);
      expect(measured.meanCurvature).toBeCloseTo(analytic.H, 6);
      const [k1, k2] = measured.principalCurvatures;
      expect(k1 * k2).toBeCloseTo(analytic.K, 6);
      expect((k1 + k2) / 2).toBeCloseTo(analytic.H, 6);
    });

    it('tessellates the patch adaptively into a mesh on the surface with the area and topology of a disk', () => {
      const corpus = synthesizeCadNurbsCorpus();
      const mesh = tessellateBSplineSurfaceAdaptive(corpus.surface, { chordalTolerance: 0.01, curvatureThreshold: 1e-4, maxDepth: 5 });

      expectMeshOnBezierSurface(mesh, corpus.surface.controlPoints);
      const topology = meshTopology(mesh);
      expect(topology.edgeUseCounts.filter((uses) => uses > 2)).toEqual([]);
      expect(topology.eulerCharacteristic).toBe(DISK_EULER_CHARACTERISTIC);
      expect(topology.boundaryLoops).toBe(1);
      const expectedArea = bezierArea(corpus.surface.controlPoints, () => true);
      expect(Math.abs(meshArea(mesh) - expectedArea) / expectedArea).toBeLessThan(MESH_AREA_TOLERANCE);
    });

    it('triangulates the trimmed face around its hole: the mesh covers the surface outside the hole and none inside', () => {
      const corpus = synthesizeCadNurbsCorpus();
      // Trim curves arrive sampled; the loops are the corpus loops with each side cut into LOOP_SAMPLES_PER_SIDE segments.
      const mesh = tessellateTrimmedFaceCDT(
        {
          surface: corpus.surface,
          outerLoop: sampleLoop(corpus.outerLoop, LOOP_SAMPLES_PER_SIDE),
          innerHoles: corpus.innerHoles.map((hole) => sampleLoop(hole, LOOP_SAMPLES_PER_SIDE)),
        },
        'golden-trimmed'
      );

      expectMeshOnBezierSurface(mesh, corpus.surface.controlPoints);
      const topology = meshTopology(mesh);
      expect(topology.edgeUseCounts.filter((uses) => uses > 2)).toEqual([]);
      // A square with one square hole is an annulus: Euler characteristic 0, two boundary loops.
      expect(topology.eulerCharacteristic).toBe(ANNULUS_EULER_CHARACTERISTIC);
      expect(topology.boundaryLoops).toBe(2);
      const hole = corpus.innerHoles[0];
      const [uLow, uHigh] = [Math.min(...hole.map((p) => p.u)), Math.max(...hole.map((p) => p.u))];
      const [vLow, vHigh] = [Math.min(...hole.map((p) => p.v)), Math.max(...hole.map((p) => p.v))];
      const outsideHole = (u: number, v: number) => u < uLow || u > uHigh || v < vLow || v > vHigh;
      const expectedArea = bezierArea(corpus.surface.controlPoints, outsideHole);
      expect(Math.abs(meshArea(mesh) - expectedArea) / expectedArea).toBeLessThan(TRIMMED_MESH_AREA_TOLERANCE);
      // The parameter domain is covered exactly: the mesh seen from above has the area of the square minus the hole.
      expect(projectedArea(mesh)).toBeCloseTo(SURFACE_EXTENT ** 2 * (1 - (uHigh - uLow) * (vHigh - vLow)), 6);
      // No triangle centroid falls inside the hole.
      for (const [a, b, c] of mesh.faces) {
        const u = (mesh.vertices[a][0] + mesh.vertices[b][0] + mesh.vertices[c][0]) / 3 / SURFACE_EXTENT;
        const v = (mesh.vertices[a][1] + mesh.vertices[b][1] + mesh.vertices[c][1]) / 3 / SURFACE_EXTENT;
        expect(outsideHole(u, v), `centroid (${u}, ${v}) lies inside the hole`).toBe(true);
      }
    });
  });

  // =========================================================================
  // 2. ISO 32000-1 CMap & Multi-Column PDF Reading Order Corpus
  // =========================================================================
  describe('2. ISO 32000-1 CMap & Multi-Column PDF Reading Order Corpus', () => {
    it('parses /ToUnicode CMap character mappings including ligatures and spaces', () => {
      const corpus = synthesizeCMapPdfCorpus();

      expect(corpus.parsedCMap.charMap.size).toBeGreaterThanOrEqual(3);
      // Verify ligature mappings: 0x0001 -> \uFB01 (fi), 0x0002 -> \uFB02 (fl)
      expect(corpus.parsedCMap.charMap.get(0x0001)).toBe('\uFB01');
      expect(corpus.parsedCMap.charMap.get(0x0002)).toBe('\uFB02');
      expect(corpus.parsedCMap.charMap.get(0x00A0)).toBe(' ');
    });

    it('synthesizes valid PDF binary and reconstructs multi-column reading order via Recursive XY-Cut++', () => {
      const corpus = synthesizeCMapPdfCorpus();

      expect(corpus.pdfBuffer.length).toBeGreaterThan(500);
      expect(corpus.pdfBuffer.toString('utf-8')).toContain('%PDF-1.7');
      expect(corpus.pdfBuffer.toString('utf-8')).toContain('/ToUnicode');

      // Verify reading order: Column 1 blocks must precede Column 2 blocks
      const orderedTexts = corpus.orderedBlocks.map((b) => b.text);
      const col1HeaderIdx = orderedTexts.findIndex((t) => t.includes('Left Column: Architecture Overview'));
      const col2HeaderIdx = orderedTexts.findIndex((t) => t.includes('Right Column: Technical Specifications'));

      expect(col1HeaderIdx).toBeGreaterThanOrEqual(0);
      expect(col2HeaderIdx).toBeGreaterThanOrEqual(0);
      expect(col1HeaderIdx).toBeLessThan(col2HeaderIdx);
    });
  });

  // =========================================================================
  // 3. HWP 5.0 CFBF Compound File Binary & EqEdit MathML Corpus
  // =========================================================================
  describe('3. HWP 5.0 CFBF Compound File Binary & EqEdit MathML Corpus', () => {
    it('reads the independently written HWP 5.0 compound file back to the paragraphs and table that were written', () => {
      const corpus = synthesizeHwp5CompoundCorpus();

      // Check CFBF magic bytes
      expect(corpus.buffer.readUInt32LE(0)).toBe(0xe011cfd0);
      expect(corpus.buffer.readUInt32LE(4)).toBe(0xe11ab1a1);

      const doc = parseHwpDocument(corpus.buffer);
      expect(doc.version).toBe('5.0.3.0');
      expect(doc.paragraphs.map((paragraph) => paragraph.text)).toEqual(corpus.doc.paragraphs.map((paragraph) => paragraph.text));
      expect(doc.tables.map((table) => table.rows)).toEqual((corpus.doc.tables ?? []).map((table) => table.rows));
      expect(doc.equations?.map((equation) => equation.script)).toEqual(corpus.rawEquations);
    });

    oracleTest('transpiles the equations of the compound file to MathML that reads as the equations do', ['xmllint'], () => {
      const corpus = synthesizeHwp5CompoundCorpus();
      const [summation, density, energy] = (parseHwpDocument(corpus.buffer).equations ?? []).map((equation) => equation.mathml);

      // sum_{i=1}^{n} i = {n(n+1)} over {2}: a sum with limits, then i = n(n+1)/2
      expect(xmlWellFormed(summation).ok).toBe(true);
      expect(xpathString(summation, 'name(/math/*[1])')).toBe('munderover');
      expect(xpathString(summation, 'string(/math/munderover/*[2])')).toBe('i=1');
      expect(xpathString(summation, 'string(/math/mfrac/*[1])')).toBe('n(n+1)');

      // f(x) = {1} over {sqrt{2 pi}} e^{-{x^2} over {2}}: a fraction over a square root, then e to a fraction
      expect(xmlWellFormed(density).ok).toBe(true);
      expect(xpathString(density, 'string(/math/mfrac/*[2]/self::msqrt)')).toBe('2π');
      expect(xpathString(density, 'name(/math/msup/*[2]/*[2])')).toBe('mfrac');

      // E = m c^2: the exponent sits on c
      expect(xmlWellFormed(energy).ok).toBe(true);
      expect(xpathString(energy, 'string(/math/msup/*[1])')).toBe('c');
      expect(xpathString(energy, 'string(/math/msup/*[2])')).toBe('2');
    });

    it('transpiles the equations of the compound file to LaTeX', () => {
      const corpus = synthesizeHwp5CompoundCorpus();
      expect((parseHwpDocument(corpus.buffer).equations ?? []).map((equation) => equation.latex)).toEqual([
        '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
        'f(x) = \\frac{1}{\\sqrt{2 \\pi}} e^{-\\frac{x^2}{2}}',
        'E = m c^2',
      ]);
    });
  });

  // =========================================================================
  // 4. Perceptual Visual Regression Testing (VRT) Cross-Engine Evaluation
  // =========================================================================
  describe('4. Perceptual Visual Regression Testing (VRT) Cross-Engine Evaluation', () => {
    oracleTest('renders the DrawingML shapes of the document where the document puts them, in the colours it names', ['xmllint'], async () => {
      const drawingCorpus = synthesizeDrawingMlTableCorpus();
      const { svg } = renderDrawingMlToSvg(drawingCorpus.drawingMlXml);

      // The expected values are the numbers of the DrawingML itself (ECMA-376): offsets and extents in EMU, 12700 EMU to the point.
      const spec = [
        { element: 'rect', x: 100000, y: 100000, width: 1400000, height: 360000, fill: '#5C6BC0', stroke: '#4A58A9' },
        { element: 'ellipse', x: 1600000, y: 100000, width: 1200000, height: 360000, fill: '#5C6BC0', stroke: '#1F2340' },
      ];
      expect(xpathCount(svg, '/*/*')).toBe(spec.length);
      for (const shape of spec) {
        const node = `/*/*[local-name()='${shape.element}']`;
        expect(xpathCount(svg, node), shape.element).toBe(1);
        // The renderer rounds to whole points: within one point of the exact value.
        const left = Number.parseFloat(xpathString(svg, `string(${node}/@${shape.element === 'ellipse' ? 'cx' : 'x'})`));
        const width = Number.parseFloat(xpathString(svg, `string(${node}/@${shape.element === 'ellipse' ? 'rx' : 'width'})`)) * (shape.element === 'ellipse' ? 2 : 1);
        const expectedLeft = shape.x / EMU_PER_POINT + (shape.element === 'ellipse' ? shape.width / EMU_PER_POINT / 2 : 0);
        expect(Math.abs(left - expectedLeft), `${shape.element} left`).toBeLessThanOrEqual(1);
        expect(Math.abs(width - shape.width / EMU_PER_POINT), `${shape.element} width`).toBeLessThanOrEqual(1);
        expect(xpathString(svg, `string(${node}/@fill)`)).toBe(shape.fill);
        expect(xpathString(svg, `string(${node}/@stroke)`)).toBe(shape.stroke);
      }

      // Rasterized by an image decoder, the pixels at the shape centres carry the fill colours and the gap between them is empty.
      const raster = await sharp(Buffer.from(svg, 'utf-8')).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
      const viewBox = xpathString(svg, 'string(/*/@viewBox)').split(' ').map(Number);
      const pixelAt = (xPoints: number, yPoints: number): number[] => {
        const x = Math.round((xPoints - viewBox[0]) * (raster.info.width / viewBox[2]));
        const y = Math.round((yPoints - viewBox[1]) * (raster.info.height / viewBox[3]));
        const at = (y * raster.info.width + x) * raster.info.channels;
        return Array.from(raster.data.subarray(at, at + raster.info.channels));
      };
      const centre = (shape: (typeof spec)[number]) => [(shape.x + shape.width / 2) / EMU_PER_POINT, (shape.y + shape.height / 2) / EMU_PER_POINT];
      expect(pixelAt(centre(spec[0])[0], centre(spec[0])[1])).toEqual([0x5c, 0x6b, 0xc0, 255]);
      expect(pixelAt(centre(spec[1])[0], centre(spec[1])[1])).toEqual([0x5c, 0x6b, 0xc0, 255]);
      const gapX = (spec[0].x + spec[0].width + spec[1].x) / 2 / EMU_PER_POINT;
      expect(pixelAt(gapX, centre(spec[0])[1])[3]).toBe(0);
    });

    it('detects visual discrepancies with strict SSIM, PSNR, and pixel diff mapping', async () => {
      const imgWidth = 80;
      const imgHeight = 80;

      const basePng = await sharp({
        create: {
          width: imgWidth,
          height: imgHeight,
          channels: 4,
          background: { r: 92, g: 107, b: 192, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      // Mutate image with an altered subregion
      const alteredSvg = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${imgWidth}" height="${imgHeight}" fill="#5C6BC0" />
        <circle cx="40" cy="40" r="15" fill="#FFFFFF" />
      </svg>`;
      const alteredPng = await sharp(Buffer.from(alteredSvg, 'utf-8')).png().toBuffer();

      const vrt = await compareImages(basePng, alteredPng, {
        threshold: 0.08,
      });

      expect(vrt.passed).toBe(false);
      expect(vrt.mismatchedPixels).toBeGreaterThan(100);
      expect(vrt.deltaRatio).toBeGreaterThan(0.01);
      expect(vrt.ssim).toBeLessThan(1.0);
      expect(vrt.psnr).toBeLessThan(50);
      expect(vrt.diffImage).toBeDefined();
    });
  });

  // =========================================================================
  // 5. Adversarial Mutation Fuzzing Across Multi-Domain Engines
  // =========================================================================
  describe('5. Adversarial Mutation Fuzzing Across Multi-Domain Engines', () => {
    it('resiliently handles corrupted B-Spline knot vectors fail-closed', () => {
      const corpus = synthesizeCadNurbsCorpus();

      // Degenerate non-monotonic knot vector
      const corruptedSurface = {
        ...corpus.surface,
        uKnots: [1, 0, 2, 0, 1, 0, 1, 0],
      };

      // A knot vector must not decrease: the surface is refused instead of evaluated to some number.
      expect(() => evaluateBSplineSurface(corpus.surface, 0.5, 0.5)).not.toThrow();
      expect(() => evaluateBSplineSurface(corruptedSurface, 0.5, 0.5)).toThrow(CadGeometryError);
      expect(() => evaluateBSplineSurface(corruptedSurface, 0.5, 0.5)).toThrow(
        /B-spline surface u knot vector decreases at index 1 \(0 follows 1\)/
      );
      // Wrong knot count for 4 control points of degree 3 (8 needed), a NaN knot, and an empty domain.
      expect(() => evaluateBSplineSurface({ ...corpus.surface, vKnots: [0, 0, 0, 1, 1, 1] }, 0.5, 0.5)).toThrow(
        /B-spline surface v knot vector has 6 knots, 8 needed for 4 control points of degree 3/
      );
      expect(() => evaluateBSplineSurface({ ...corpus.surface, uKnots: [0, 0, 0, 0, Number.NaN, 1, 1, 1] }, 0.5, 0.5)).toThrow(
        /B-spline surface u knot vector holds a non-finite knot at index 4/
      );
      expect(() => evaluateBSplineSurface({ ...corpus.surface, uKnots: [1, 1, 1, 1, 1, 1, 1, 1] }, 0.5, 0.5)).toThrow(
        /B-spline surface u knot vector spans no parameter range/
      );

      // The same checks guard curves: a line of 2 control points needs 3 knots, not 2.
      const line = { degree: 1, controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], knots: [0, 0, 1, 1] };
      expect(evaluateBSplineCurve(line, 0.5)).toEqual({ x: 5, y: 0, z: 0 });
      expect(() => evaluateBSplineCurve({ ...line, knots: [0, 1, 1] }, 0.5)).toThrow(CadGeometryError);
      expect(() => evaluateBSplineCurve({ ...line, knots: [0, 1, 1] }, 0.5)).toThrow(
        /B-spline curve knot vector has 3 knots, 4 needed for 2 control points of degree 1/
      );
    });

    it('resiliently handles corrupted CMap streams fail-closed', () => {
      const corruptedCMap = `begincmap
/CMapType 2 def
beginbfrange
<FFFF> <0000> [<0000>]
endbfrange
endcmap`;

      const parsed = parseToUnicodeCMap(corruptedCMap);
      expect(parsed).toBeDefined();
      expect(parsed.charMap instanceof Map).toBe(true);
    });

    it('refuses malformed EqEdit scripts with a typed error and transpiles odd but valid ones to well-formed MathML', () => {
      for (const script of ['{ { { { unclosed braces', 'over over over']) {
        expect(() => hwpEquationToMathML(script), script).toThrow(CorruptStreamError);
        expect(() => hwpEquationToLaTeX(script), script).toThrow(CorruptStreamError);
      }
      // An empty radicand and an empty fraction operand are valid scripts; so are symbols the editor has no keyword for.
      expect(hwpEquationToMathML('sqrt{ } over { }')).toBe('<math><mfrac><msqrt><mrow></mrow></msqrt><mrow></mrow></mfrac></math>');
      expect(hwpEquationToLaTeX('sqrt{ } over { }')).toBe('\\frac{\\sqrt{}}{}');
      expect(hwpEquationToMathML('')).toBe('<math></math>');
      expect(hwpEquationToLaTeX('')).toBe('');
      expect(hwpEquationToMathML('µ_∂_∑')).toBe('<math><msub><msub><mi>µ</mi><mo>∂</mo></msub><mo>∑</mo></msub></math>');
    });
  });
});
