import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { FORMAT_REGISTRY, getAvailableTargetFormats } from '../src/lib/registry';
import { convertFile } from '../src/lib/conversions';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { ConversionFailedError } from '../src/lib/types';
import { parseEmfBinary, parseWmfBinary, parseClearTextCgm } from './helpers/metafile-oracle';

const METAFILE_TARGETS = ['emf', 'wmf', 'cgm'];

const SVG_SAMPLE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="10" y="10" width="50" height="50" fill="red"/></svg>';
const EPS_SAMPLE = [
  '%!PS-Adobe-3.0 EPSF-3.0',
  '%%BoundingBox: 0 0 100 100',
  'newpath 10 10 moveto 90 10 lineto 90 90 lineto closepath 1 0 0 setrgbcolor fill',
  '0 0 moveto 50 50 lineto stroke',
  'showpage',
  '',
].join('\n');
const CGM_SAMPLE = [
  'BEGMF "sample";',
  'MFVERSION 1;',
  'BEGPIC "sample";',
  'VDCEXT (0,100) (100,0);',
  'BEGPICBODY;',
  'POLYGON (10,10) (50,10) (50,50);',
  'POLYLINE (0,0) (90,90);',
  'ENDPIC;',
  'ENDMF;',
  '',
].join('\n');

/** Inputs for every source that may advertise a metafile target. */
const SOURCE_SAMPLES: Record<string, Buffer> = {
  svg: Buffer.from(SVG_SAMPLE, 'utf-8'),
  svgz: zlib.gzipSync(Buffer.from(SVG_SAMPLE, 'utf-8')),
  eps: Buffer.from(EPS_SAMPLE, 'utf-8'),
  ps: Buffer.from(EPS_SAMPLE.replace(' EPSF-3.0', ''), 'utf-8'),
  cgm: Buffer.from(CGM_SAMPLE, 'utf-8'),
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Checks an output against its format's own signature using the independent oracles. */
function assertOutputFormat(target: string, out: Buffer): void {
  switch (target) {
    case 'emf': {
      const emf = parseEmfBinary(out);
      expect(emf.header.signature).toBe(0x464d4520);
      expect(emf.hasEof).toBe(true);
      expect(emf.pointCounts.length).toBeGreaterThan(0);
      break;
    }
    case 'wmf': {
      const wmf = parseWmfBinary(out);
      expect(wmf.header.aldusKey).toBe(0x9ac6cdd7);
      expect(wmf.hasEof).toBe(true);
      expect(wmf.hasPolygon || wmf.hasPolyline).toBe(true);
      break;
    }
    case 'cgm': {
      const cgm = parseClearTextCgm(out.toString('utf-8'));
      expect(cgm.body.some((e) => e.name === 'POLYGON' || e.name === 'POLYLINE' || e.name === 'POLYGONSET')).toBe(true);
      break;
    }
    case 'png':
      expect(out.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
      break;
    case 'pdf':
      expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      break;
    case 'eps':
      expect(out.toString('latin1', 0, 64)).toMatch(/^%!PS-Adobe-\d\.\d EPSF-\d\.\d/);
      break;
    case 'ps':
      expect(out.toString('latin1', 0, 4)).toBe('%!PS');
      break;
    case 'svg':
      expect(out.toString('utf-8')).toMatch(/<svg[\s\S]*<(polygon|polyline|path)\b[\s\S]*<\/svg>/);
      break;
    case 'dxf': {
      const dxf = out.toString('utf-8');
      expect(dxf).toMatch(/^\s*0\r?\nSECTION/);
      expect(dxf).toMatch(/0\r?\nEOF\s*$/);
      break;
    }
    default:
      throw new Error(`No independent format check for advertised target .${target}`);
  }
}

describe('Metafile registry advertises only working conversion pairs', () => {
  it('never advertises EMF or WMF as conversion sources, since no decoder exists', () => {
    for (const source of ['emf', 'wmf']) {
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
    expect(advertised.sort()).toEqual(
      ['cgm->emf', 'cgm->wmf', 'eps->emf', 'eps->wmf', 'ps->emf', 'ps->wmf', 'svg->cgm', 'svg->emf', 'svg->wmf', 'svgz->emf', 'svgz->wmf'].sort()
    );
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

  for (const target of FORMAT_REGISTRY.cgm.targetFormats) {
    it(`converts every advertised CGM target: cgm -> ${target}`, async () => {
      const res = await convertFile(SOURCE_SAMPLES.cgm, 'cgm', target, {}, 'sample.cgm');
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
