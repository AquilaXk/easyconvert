import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { FORMAT_REGISTRY, getAvailableTargetFormats } from '../src/lib/registry';
import { convertFile } from '../src/lib/conversions';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { EngineUnavailableError } from '../src/lib/types';
import { isOfficeSuiteOnlySource } from '../src/lib/conversions/office/office-suite-sources';
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
  it('advertises EMF, WMF and CGM as conversion sources only through the office suite, which imports them: none has an in-process reader', () => {
    for (const source of ['emf', 'wmf', 'cgm']) {
      expect(isOfficeSuiteOnlySource(source)).toBe(true);
      expect(FORMAT_REGISTRY[source].targetFormats.length).toBeGreaterThan(0);
      expect(getAvailableTargetFormats(source).map((format) => format.id)).toEqual(FORMAT_REGISTRY[source].targetFormats);
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
    // A PDF, a Visio, CorelDRAW, CGM, EMF or WMF drawing and a presentation (EMF only) reach EMF and WMF through the SVG that Poppler
    // draws from the office suite's PDF, and a page the in-process writers refuse through the office suite (entry 453); the SVG pairs
    // are written from SVG by the in-process encoders. tests/vector-sources-real-samples.test.ts and
    // tests/office-metafile-real-samples.test.ts convert real files. SVG to CGM is withdrawn (entry 357): the reference offers CGM only from DWF, DWG and DXF.
    expect(sorted).toEqual([
      'cdr->emf', 'cdr->wmf', 'cgm->emf', 'cgm->wmf', 'emf->emf', 'emf->wmf', 'pdf->emf', 'pdf->wmf', 'pot->emf', 'potx->emf', 'ppt->emf', 'pptm->emf', 'pptx->emf',
      'svg->emf', 'svg->wmf', 'svgz->emf', 'svgz->wmf', 'vsd->emf', 'vsd->wmf', 'wmf->emf', 'wmf->wmf',
    ]);
  });

  const metafilePairs = Object.entries(FORMAT_REGISTRY).flatMap(([sourceId, def]) =>
    def.targetFormats.filter((t) => METAFILE_TARGETS.includes(t) && sourceId in SOURCE_SAMPLES).map((t) => [sourceId, t] as const)
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

  it('answers binary EMF/WMF input in process with the typed engine error: the office suite reads them, the SVG converter never takes their bytes for a drawing', async () => {
    const emfLike = Buffer.alloc(88);
    emfLike.writeUInt32LE(1, 0);
    emfLike.writeUInt32LE(88, 4);
    emfLike.write(' EMF', 40, 'latin1');
    for (const [source, target] of [['emf', 'png'], ['wmf', 'png'], ['emf', 'svg']] as const) {
      const err = await convertVectorCad(emfLike, source, target, {}, `in.${source}`).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(EngineUnavailableError);
      expect((err as Error).message).toContain(`.${source} files are imported by LibreOffice`);
    }
  });
});
