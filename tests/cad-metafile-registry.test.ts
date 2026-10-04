import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { FORMAT_REGISTRY, getAvailableTargetFormats } from '../src/lib/registry';
import { convertFile } from '../src/lib/conversions';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { ConversionFailedError } from '../src/lib/types';
import { emfOraclePlayback, wmfOraclePlayback, cgmOracleDocument, cgmOracleColour, cgmOraclePoints } from './helpers/metafile-oracle';

const METAFILE_TARGETS = ['emf', 'wmf', 'cgm'];

/** A red triangle; every advertised pair must reproduce its colour and vertices. */
const TRIANGLE: [number, number][] = [[10, 10], [90, 20], [40, 80]];
const RED = 0xff0000;
const VERTEX_TOLERANCE_PX = 1;
const SVG_SAMPLE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
  `<polygon points="${TRIANGLE.map(([x, y]) => `${x},${y}`).join(' ')}" fill="#ff0000"/></svg>`;

/** Inputs for every source that may advertise a metafile target. */
const SOURCE_SAMPLES: Record<string, Buffer> = {
  svg: Buffer.from(SVG_SAMPLE, 'utf-8'),
  svgz: zlib.gzipSync(Buffer.from(SVG_SAMPLE, 'utf-8')),
};

function expectTriangle(ring: { x: number; y: number }[]): void {
  const pts = [...ring];
  const last = pts[pts.length - 1];
  if (pts.length > TRIANGLE.length && last.x === pts[0].x && last.y === pts[0].y) pts.pop();
  expect(pts).toHaveLength(TRIANGLE.length);
  pts.forEach((p, i) => {
    expect(Math.abs(p.x - TRIANGLE[i][0])).toBeLessThanOrEqual(VERTEX_TOLERANCE_PX);
    expect(Math.abs(p.y - TRIANGLE[i][1])).toBeLessThanOrEqual(VERTEX_TOLERANCE_PX);
  });
}

/** Decodes the output with the independent oracles and checks the red triangle. */
function assertOutputFormat(target: string, out: Buffer): void {
  switch (target) {
    case 'emf':
    case 'wmf': {
      const shapes = target === 'emf' ? emfOraclePlayback(out) : wmfOraclePlayback(out);
      const filled = shapes.filter((s) => s.kind === 'polygon' && s.brush !== null);
      expect(filled.map((s) => s.brush)).toEqual([RED]);
      expect(filled[0].rings).toHaveLength(1);
      expectTriangle(filled[0].rings[0]);
      break;
    }
    case 'cgm': {
      const cgm = cgmOracleDocument(out.toString('utf-8'));
      expect(cgm.body.filter((e) => e.name === 'FILLCOLR').map((e) => cgmOracleColour(e.params))).toEqual([[255, 0, 0]]);
      const polygons = cgm.body.filter((e) => e.name === 'POLYGON');
      expect(polygons).toHaveLength(1);
      expectTriangle(cgmOraclePoints(polygons[0].params));
      break;
    }
    default:
      throw new Error(`No independent format check for advertised target .${target}`);
  }
}

describe('Metafile registry advertises only working conversion pairs', () => {
  it('never advertises EMF, WMF or CGM as conversion sources, since no faithful decoder exists', () => {
    for (const source of ['emf', 'wmf', 'cgm']) {
      expect(FORMAT_REGISTRY[source].targetFormats).toEqual([]);
      expect(getAvailableTargetFormats(source)).toEqual([]);
    }
  });

  it('only advertises EMF/WMF/CGM targets for sources whose engine encodes them', () => {
    const advertised: string[] = [];
    for (const [sourceId, def] of Object.entries(FORMAT_REGISTRY)) {
      for (const target of def.targetFormats) {
        if (METAFILE_TARGETS.includes(target)) advertised.push(`${sourceId}->${target}`);
      }
    }
    const sorted = [...advertised].sort((a, b) => a.localeCompare(b));
    expect(sorted).toEqual(['svg->cgm', 'svg->emf', 'svg->wmf', 'svgz->emf', 'svgz->wmf']);
  });

  const metafilePairs = Object.entries(FORMAT_REGISTRY).flatMap(([sourceId, def]) =>
    def.targetFormats.filter((t) => METAFILE_TARGETS.includes(t)).map((t) => [sourceId, t] as const)
  );
  for (const [source, target] of metafilePairs) {
    it(`converts advertised pair ${source} -> ${target} through convertFile`, async () => {
      const input = SOURCE_SAMPLES[source];
      expect(input, `no sample for advertised source .${source}`).toBeInstanceOf(Buffer);
      const res = await convertFile(input, source, target, {}, `sample.${source}`);
      expect(res.filename).toBe(`sample.${target}`);
      assertOutputFormat(target, res.buffer);
    });
  }

  it('rejects binary EMF/WMF input with a typed conversion error', async () => {
    const emfLike = Buffer.alloc(88);
    emfLike.writeUInt32LE(1, 0);
    emfLike.writeUInt32LE(88, 4);
    emfLike.write(' EMF', 40, 'latin1');
    for (const [source, target] of [['emf', 'png'], ['wmf', 'png'], ['emf', 'svg']] as const) {
      const err = await convertVectorCad(emfLike, source, target, {}, `in.${source}`).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ConversionFailedError);
      expect((err as Error).message).toMatch(new RegExp(`\\.${source}`));
    }
  });
});
