import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scoreInk, type CadTruth } from '../bench/cad-ink';
import { ReferenceServer } from '../bench/reference-server';
import { defaultResolver, EZDXF_PSEUDO_TOOL } from '../bench/tools';
import { readRaster, renderPdfPage, renderSvg } from '../bench/vector-raster';
import { convertDwgToDxf } from '../src/lib/conversions/cad-dwg';
import { convertFile } from '../src/lib/conversions';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import {
  CadGeometryError,
  ConversionFailedError,
  CpuTaskTimeoutError,
  EngineMissingError,
  EngineUnavailableError,
  UnprocessableCadInputError,
  UnsupportedDwgVersionError,
} from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { ENTITY_SAMPLE_RELEASES, requireDwgSample } from './helpers/dwg-samples';
import { skipUnless } from './helpers/strict-skip';

/**
 * DWG input: a pinned open-source reader (`dwg2dxf`, run as a separate sandboxed process) writes a DXF that the DXF path draws.
 *
 * Two independent oracles judge the conversion, neither of which is the reader or this repository's DXF code:
 * - the AutoCAD property dump (`Line.txt`, `Arc.txt`, `circle.txt`) that sits beside each single-entity drawing in the sample set,
 *   written by AutoCAD itself for the same entity saved as six releases; the numbers are copied below. The strokes that ezdxf
 *   (an independent DXF library) reads from the converted DXF must match them;
 * - the CAD ink score (bench/cad-ink.ts), which compares a rendered SVG, PDF or PNG with the strokes ezdxf reads.
 * The wrapper around the reader is tested with stand-in programs, which stand for a reader that fails in each way a real one can.
 */

const resolve = defaultResolver();
const python = resolve('python3');
const hasEzdxf = resolve(EZDXF_PSEUDO_TOOL) !== null;
const dwg2dxf = getOracleToolPath('dwg2dxf');
const haveReader = !skipUnless('dwg2dxf, python3 and ezdxf', dwg2dxf !== null && python !== null && hasEzdxf);

/** AutoCAD's own values for the entities of the samples (VLA property dump: StartPoint, EndPoint, Center, Radius, StartAngle, EndAngle). */
const AUTOCAD = {
  line: { start: [21.6078, 2.81192], end: [11.0307, 16.6375] },
  circle: { centre: [23.4493, -1.09239], radius: 13.5304 },
  arc: { centre: [-18.1933, 6.68652], radius: 8.2931, startAngle: 2.00242, endAngle: 1.51876, start: [-21.6627, 14.219], end: [-17.762, 14.9684] },
} as const;
/** The dump prints six significant digits. */
const DUMP_TOLERANCE = 2e-4;
const RELEASE_CODE: Readonly<Record<string, string>> = { '2000': 'AC1015', '2004': 'AC1018', '2007': 'AC1021', '2010': 'AC1024', '2013': 'AC1027', '2018': 'AC1032' };

const scratch: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs `body` with DWG2DXF_PATH pointing at `program`, then restores the environment. */
async function withReader<T>(program: string | undefined, body: () => Promise<T>): Promise<T> {
  const before = process.env.DWG2DXF_PATH;
  if (program === undefined) delete process.env.DWG2DXF_PATH;
  else process.env.DWG2DXF_PATH = program;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.DWG2DXF_PATH;
    else process.env.DWG2DXF_PATH = before;
  }
}

/** A shell script that stands in for the reader: `body` runs with $1.. as the reader's arguments. */
function standIn(name: string, body: string): string {
  const file = path.join(tmpDir('dwg-standin-'), name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** The output file the wrapper asked for: the argument after -o. */
const OUTPUT_ARG = 'out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done';
const MINIMAL_DXF = '  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n  8\n0\n 10\n0.0\n 20\n0.0\n 30\n0.0\n 11\n1.0\n 21\n1.0\n 31\n0.0\n  0\nENDSEC\n  0\nEOF\n';
const ANY_DWG = Buffer.concat([Buffer.from('AC1015'), Buffer.alloc(200, 1)]);

/** The error `run` fails with; the test fails when it does not fail. */
async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the conversion to fail');
}

let server: ReferenceServer | null = null;
beforeAll(() => {
  if (haveReader) {
    process.env.DWG2DXF_PATH ??= dwg2dxf as string;
    server = ReferenceServer.start(python as string);
  }
});
afterAll(async () => {
  await server?.close();
});

async function strokesOf(dxf: Buffer): Promise<Array<Array<[number, number]>>> {
  const file = path.join(tmpDir('dwg-truth-'), 'drawing.dxf');
  fs.writeFileSync(file, dxf);
  const truth = await (server as ReferenceServer).call<CadTruth>('cad.truth', { file });
  return truth.strokes;
}

const near = (a: number, b: number, tolerance = DUMP_TOLERANCE): boolean => Math.abs(a - b) <= tolerance;
const nearPoint = (p: readonly number[], q: readonly number[], tolerance = DUMP_TOLERANCE): boolean => near(p[0], q[0], tolerance) && near(p[1], q[1], tolerance);

describe.skipIf(!haveReader)('the entities AutoCAD wrote, saved as six releases of DWG', () => {
  for (const release of ENTITY_SAMPLE_RELEASES) {
    describe(`AutoCAD ${release} (${RELEASE_CODE[release]})`, () => {
      it('converts a LINE with the end points AutoCAD reports', async (ctx) => {
        const dwg = await requireDwgSample(ctx, `entity-line-${release}.dwg`);
        expect(dwg.subarray(0, 6).toString('latin1')).toBe(RELEASE_CODE[release]);
        const { buffer, mimeType } = await convertVectorCad(dwg, 'dwg', 'dxf', {}, 'line.dwg');
        expect(mimeType).toBe('image/vnd.dxf');
        const strokes = await strokesOf(buffer);
        expect(strokes).toHaveLength(1);
        const [first, last] = [strokes[0][0], strokes[0][strokes[0].length - 1]];
        const forward = nearPoint(first, AUTOCAD.line.start) && nearPoint(last, AUTOCAD.line.end);
        const backward = nearPoint(first, AUTOCAD.line.end) && nearPoint(last, AUTOCAD.line.start);
        expect(forward || backward, JSON.stringify(strokes)).toBe(true);
      });

      it('converts a CIRCLE with the centre and radius AutoCAD reports', async (ctx) => {
        const dwg = await requireDwgSample(ctx, `entity-circle-${release}.dwg`);
        const strokes = await strokesOf((await convertVectorCad(dwg, 'dwg', 'dxf', {}, 'circle.dwg')).buffer);
        expect(strokes).toHaveLength(1);
        const { centre, radius } = AUTOCAD.circle;
        // The library flattens the circle to a polygon: its vertices lie on the circle, and its extremes reach the circle's.
        const flatteningTolerance = radius * 0.01;
        for (const point of strokes[0]) expect(near(Math.hypot(point[0] - centre[0], point[1] - centre[1]), radius, flatteningTolerance), `${point}`).toBe(true);
        const xs = strokes[0].map((p) => p[0]);
        const ys = strokes[0].map((p) => p[1]);
        expect(near(Math.min(...xs), centre[0] - radius, flatteningTolerance)).toBe(true);
        expect(near(Math.max(...xs), centre[0] + radius, flatteningTolerance)).toBe(true);
        expect(near(Math.min(...ys), centre[1] - radius, flatteningTolerance)).toBe(true);
        expect(near(Math.max(...ys), centre[1] + radius, flatteningTolerance)).toBe(true);
      });

      it('converts an ARC that runs counter-clockwise from the start angle AutoCAD reports to its end angle', async (ctx) => {
        const dwg = await requireDwgSample(ctx, `entity-arc-${release}.dwg`);
        const strokes = await strokesOf((await convertVectorCad(dwg, 'dwg', 'dxf', {}, 'arc.dwg')).buffer);
        expect(strokes).toHaveLength(1);
        const { centre, radius, startAngle, endAngle, start, end } = AUTOCAD.arc;
        const points = strokes[0];
        const flatteningTolerance = radius * 0.01;
        for (const point of points) expect(near(Math.hypot(point[0] - centre[0], point[1] - centre[1]), radius, flatteningTolerance), `${point}`).toBe(true);
        const ends = [points[0], points[points.length - 1]];
        const forward = nearPoint(ends[0], start) && nearPoint(ends[1], end);
        const backward = nearPoint(ends[0], end) && nearPoint(ends[1], start);
        expect(forward || backward, JSON.stringify(ends)).toBe(true);
        // Every vertex lies inside the sweep from the start angle counter-clockwise to the end angle (which is below the start, so it wraps).
        const sweep = endAngle + 2 * Math.PI - startAngle;
        for (const point of points) {
          const angle = Math.atan2(point[1] - centre[1], point[0] - centre[0]);
          const along = (((angle - startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          expect(along <= sweep + 1e-3 || along >= 2 * Math.PI - 1e-3, `${angle}`).toBe(true);
        }
      });
    });
  }
});

describe.skipIf(!haveReader)('drawings of the other releases and of several programs', () => {
  const drawings = ['dwg-example-r13.dwg', 'dwg-example-r14.dwg', 'dwg-example-2000.dwg', 'dwg-example-2004.dwg', 'dwg-example-2007.dwg', 'dwg-example-2010.dwg', 'dwg-example-2013.dwg', 'dwg-example-2018.dwg', 'dwg-gdal-circles-2000.dwg'];
  for (const id of drawings) {
    it(`${id} converts to a DXF that ezdxf reads and that holds strokes`, async (ctx) => {
      const dwg = await requireDwgSample(ctx, id);
      const { buffer } = await convertVectorCad(dwg, 'dwg', 'dxf', {}, `${id}`);
      const strokes = await strokesOf(buffer);
      expect(strokes.length).toBeGreaterThan(2);
    });
  }

  const TARGETS = ['svg', 'pdf', 'png'] as const;
  const ffmpeg = resolve('ffmpeg');
  const rsvg = resolve('rsvg-convert');
  const pdftoppm = resolve('pdftoppm');
  const haveRender = !skipUnless('ffmpeg, rsvg-convert and pdftoppm', ffmpeg !== null && rsvg !== null && pdftoppm !== null);

  describe.skipIf(!haveRender)('rendered through the DXF path', () => {
    /** Floor of the ink score for a drawing the reader decodes completely: measured on these drawings with a margin, not a target. */
    const MIN_RECALL = 0.8;
    const MIN_PRECISION = 0.8;
    for (const id of ['dwg-example-2000.dwg', 'dwg-example-2018.dwg', 'dwg-gdal-circles-2000.dwg']) {
      for (const target of TARGETS) {
        it(`${id} to ${target} agrees with the strokes ezdxf reads from the converted DXF`, async (ctx) => {
          const dwg = await requireDwgSample(ctx, id);
          const dxf = (await convertVectorCad(dwg, 'dwg', 'dxf', {}, id)).buffer;
          const dxfFile = path.join(tmpDir('dwg-render-'), 'drawing.dxf');
          fs.writeFileSync(dxfFile, dxf);
          const truth = await (server as ReferenceServer).call<CadTruth>('cad.truth', { file: dxfFile });
          const out = await convertVectorCad(dwg, 'dwg', target, {}, id);
          const dir = tmpDir('dwg-render-out-');
          const file = path.join(dir, `out.${target}`);
          fs.writeFileSync(file, out.buffer);
          const picture = path.join(dir, 'picture.png');
          if (target === 'svg') renderSvg(rsvg as string, file, picture, 1600);
          else if (target === 'pdf') renderPdfPage(pdftoppm as string, file, picture, 1600);
          else fs.copyFileSync(file, picture);
          const score = scoreInk(readRaster(ffmpeg as string, picture), truth);
          expect(score.recall).toBeGreaterThanOrEqual(MIN_RECALL);
          expect(score.precision).toBeGreaterThanOrEqual(MIN_PRECISION);
        });
      }
    }
  });
});

describe('refusing before the reader runs', () => {
  it('refuses a release the reader does not decode reliably with a 422, and never starts the reader', async () => {
    const marker = path.join(tmpDir('dwg-marker-'), 'started');
    const reader = standIn('dwg2dxf', `touch ${marker}`);
    for (const code of ['AC1009', 'AC1006', 'AC1.40', 'AC1033']) {
      const old = Buffer.concat([Buffer.from(code), Buffer.alloc(100)]);
      await withReader(reader, async () => {
        const failure = await convertVectorCad(old, 'dwg', 'svg', {}, 'old.dwg').then(
          () => null,
          (error: unknown) => error
        );
        expect(failure, code).toBeInstanceOf(UnsupportedDwgVersionError);
        expect((failure as UnsupportedDwgVersionError).status).toBe(422);
        expect(failure).not.toBeInstanceOf(EngineMissingError);
      });
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses text that is no DWG with a 400 and never starts the reader', async () => {
    const marker = path.join(tmpDir('dwg-marker-'), 'started');
    const reader = standIn('dwg2dxf', `touch ${marker}`);
    await withReader(reader, async () => {
      const failure = await convertVectorCad(Buffer.from('  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n'), 'dwg', 'svg', {}, 'text.dwg').then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(CadGeometryError);
      expect((failure as CadGeometryError).status).toBe(400);
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('no longer reads an ASCII DXF that was saved under the name .dwg as a drawing', async () => {
    const dxf = Buffer.from(MINIMAL_DXF);
    const failure = await convertVectorCad(dxf, 'dwg', 'svg', {}, 'misnamed.dwg').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(CadGeometryError);
    expect((failure as CadGeometryError).status).toBe(400);
    expect((failure as Error).message).toBe('The file is not a DWG drawing: it does not start with a DWG release code.');
  });
});

describe('a missing or failing reader never passes for a conversion', () => {
  it('answers a typed engine-unavailable error (503, retried on another worker) when the program is not installed', async () => {
    await withReader('/nonexistent/dwg2dxf', async () => {
      const failure = await convertDwgToDxf(ANY_DWG, {}).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(EngineUnavailableError);
      expect(failure).toBeInstanceOf(EngineMissingError);
      expect((failure as EngineUnavailableError).engineName).toBe('dwg2dxf');
    });
  });

  it('answers 422 when the program exits with an error, without the path of its scratch directory in the message', async () => {
    const reader = standIn('dwg2dxf', 'echo "ERROR: cannot read $PWD/input.dwg" >&2; exit 1');
    await withReader(reader, async () => {
      const failure = await convertDwgToDxf(ANY_DWG, {}).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure).not.toBeInstanceOf(EngineMissingError);
      expect((failure as Error).message).not.toContain(os.tmpdir());
    });
  });

  it('answers 422 when the program exits 0 without writing a file', async () => {
    const reader = standIn('dwg2dxf', 'exit 0');
    await withReader(reader, async () => {
      const failure = await failureOf(() => convertDwgToDxf(ANY_DWG, {}));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure.message).toBe('The DWG reader wrote no drawing from this file.');
    });
  });

  it.each([
    ['text that is no DXF', 'this is not a drawing\n'],
    ['a DXF cut off before its EOF record', MINIMAL_DXF.slice(0, MINIMAL_DXF.length - 8)],
    ['a DXF whose pairs are broken (a group code that is no integer)', MINIMAL_DXF.replace('  8\n0', ' XX\n0')],
    ['a DXF with an empty line where a group code belongs', MINIMAL_DXF.replace('  8\n0', '\n0')],
    ['a DXF without an ENTITIES section', '  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n'],
    ['bytes with NUL characters', `${MINIMAL_DXF}\0\0`],
  ])('answers 422 for %s and does not hand it to the DXF path', async (_name, content) => {
    const reader = standIn('dwg2dxf', `${OUTPUT_ARG}\nprintf '%s' '${content.replaceAll("'", '').replaceAll('\0', '')}' > "$out"${content.includes('\0') ? '\nprintf "\\000\\000" >> "$out"' : ''}`);
    await withReader(reader, async () => {
      const failure = await failureOf(() => convertDwgToDxf(ANY_DWG, {}));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect((failure as UnprocessableCadInputError).status).toBe(422);
      expect(failure.message).toMatch(/^The DWG reader wrote no usable drawing: /);
    });
  });

  it('hands over the DXF a program wrote when it is well formed', async () => {
    const reader = standIn('dwg2dxf', `${OUTPUT_ARG}\nprintf '%s' '${MINIMAL_DXF}' > "$out"`);
    await withReader(reader, async () => {
      const dxf = await convertDwgToDxf(ANY_DWG, {});
      expect(dxf.toString('utf8')).toBe(MINIMAL_DXF);
    });
  });

  it('answers 422 when the program is killed by a signal (a crash on a damaged file)', async () => {
    const reader = standIn('dwg2dxf', 'kill -SEGV $$');
    await withReader(reader, async () => {
      const failure = await failureOf(() => convertDwgToDxf(ANY_DWG, {}));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure.message).toBe('The DWG reader ran out of memory or crashed on this drawing.');
    });
  });

  it('stops a program that does not finish within the time of the conversion, with a typed timeout and without waiting for it', async () => {
    const reader = standIn('dwg2dxf', 'sleep 30');
    await withReader(reader, async () => {
      const started = Date.now();
      const failure = await convertDwgToDxf(ANY_DWG, { timeoutMs: 700 }).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(CpuTaskTimeoutError);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  it('stops a program when the job is cancelled', async () => {
    const reader = standIn('dwg2dxf', 'sleep 30');
    await withReader(reader, async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = convertDwgToDxf(ANY_DWG, { signal: controller.signal }).then(
        () => null,
        (error: unknown) => error
      );
      setTimeout(() => controller.abort(new Error('cancelled')), 300);
      expect(await pending).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  it('leaves no scratch directory behind', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('easyconvert_worker_sandbox_')).length;
    const reader = standIn('dwg2dxf', 'exit 1');
    await withReader(reader, async () => {
      await convertDwgToDxf(ANY_DWG, {}).catch(() => undefined);
    });
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('easyconvert_worker_sandbox_')).length).toBe(before);
  });
});

describe.skipIf(!haveReader)('what the reader leaves out is reported', () => {
  it('lists the proxy entities of a drawing as a warning, with the count ezdxf reads from the converted DXF', async (ctx) => {
    const dwg = await requireDwgSample(ctx, 'dwg-gdal-attribs-2013.dwg');
    const dxfFile = path.join(tmpDir('dwg-proxy-'), 'drawing.dxf');
    fs.writeFileSync(dxfFile, (await convertVectorCad(dwg, 'dwg', 'dxf', {}, 'attribs.dwg')).buffer);
    const count = spawnSync(
      python as string,
      ['-I', '-c', 'import sys, ezdxf; d = ezdxf.readfile(sys.argv[1]); print(sum(1 for e in d.modelspace() if e.dxftype() == "ACAD_PROXY_ENTITY"))', dxfFile],
      { encoding: 'utf8' }
    );
    const proxies = Number(count.stdout.trim());
    expect(proxies).toBeGreaterThan(0);
    const out = await convertFile(dwg, 'dwg', 'svg', {}, 'attribs.dwg');
    const warnings = (out.metadata?.warnings ?? []) as string[];
    expect(warnings.filter((line) => line.includes(`${proxies} proxy`)), JSON.stringify(warnings)).toHaveLength(1);
  });

  it('says nothing about proxy entities for a drawing without them', async (ctx) => {
    const dwg = await requireDwgSample(ctx, 'dwg-gdal-circles-2000.dwg');
    const out = await convertFile(dwg, 'dwg', 'svg', {}, 'circles.dwg');
    expect(((out.metadata?.warnings ?? []) as string[]).filter((line) => /proxy/i.test(line))).toEqual([]);
  });
});
