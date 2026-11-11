import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { resolveNativeBinary } from '../src/worker/engines';
import { RawDecodeError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { buildNef } from './helpers/nef-builder';
import { withBinaryAt, withMissingBinary } from './helpers/native-tools';
import { rawSamplePath, skipUnless, skipWithoutRawSamples, skipWithoutTools } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 232).
runWithoutFileConfinement();

/**
 * A Nikon NEF with High Efficiency (HE) or High Efficiency* (HE*) compression is read by the `dcraw_emu` of the pinned LibRaw snapshot
 * (scripts/install-libraw-he.sh); every other camera file, NEF or not, keeps the distribution's `dcraw_emu`. The choice is made from the
 * maker note before any decoder runs. Stand-in decoders that log their name show which program ran for which file; the real samples
 * (a Nikon Z f and a Nikon Z 9, both High Efficiency) are developed where the pinned build is installed and compared with the
 * full-size picture the camera embedded in each.
 */

const TEST_TIMEOUT_MS = 240_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

const stubDirectory = mkdtempSync(path.join(os.tmpdir(), 'raw-he-stub-'));
afterAll(() => rmSync(stubDirectory, { recursive: true, force: true }));

/** The stand-ins write pictures of different sizes, so that the size of the result names the program that developed it. */
const SIZES = { he: { width: 64, height: 48 }, distro: { width: 80, height: 60 } } as const;
type Stub = keyof typeof SIZES;
const HE_COMPRESSION = 13;
const HE_STAR_COMPRESSION = 14;
const LOSSLESS_COMPRESSION = 3;

const TIFF_HEADER_BYTES = 8;
const TIFF_ENTRY_COUNT = 8;
const TIFF_SAMPLE_BITS_AT = TIFF_HEADER_BYTES + 2 + TIFF_ENTRY_COUNT * 12 + 4;
const TIFF_PIXELS_AT = TIFF_SAMPLE_BITS_AT + 6;
const TIFF_SHORT = 3;
const TIFF_LONG = 4;

/** The 16-bit RGB TIFF `dcraw_emu` writes: little endian, one uncompressed strip behind the directory, every row different. */
function stubPicture({ width, height }: { width: number; height: number }): Buffer {
  const rowBytes = width * 6;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let index = 0; index < width * height * 3; index += 1) pixels.writeUInt16LE((index * 517 + Math.floor(index / (width * 3)) * 131 + 977) & 0xffff, index * 2);
  const header = Buffer.alloc(TIFF_PIXELS_AT);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(TIFF_HEADER_BYTES, 4);
  header.writeUInt16LE(TIFF_ENTRY_COUNT, TIFF_HEADER_BYTES);
  const entries: Array<[tag: number, type: number, value: number]> = [
    [256, TIFF_LONG, width],
    [257, TIFF_LONG, height],
    [258, TIFF_SHORT, TIFF_SAMPLE_BITS_AT],
    [262, TIFF_SHORT, 2],
    [273, TIFF_LONG, TIFF_PIXELS_AT],
    [277, TIFF_SHORT, 3],
    [278, TIFF_LONG, height],
    [279, TIFF_LONG, rowBytes * height],
  ];
  entries.forEach(([tag, type, value], index) => {
    const at = TIFF_HEADER_BYTES + 2 + index * 12;
    header.writeUInt16LE(tag, at);
    header.writeUInt16LE(type, at + 2);
    header.writeUInt32LE(tag === 258 ? 3 : 1, at + 4);
    if (type === TIFF_SHORT && tag !== 258) header.writeUInt16LE(value, at + 8);
    else header.writeUInt32LE(value, at + 8);
  });
  for (let sample = 0; sample < 3; sample += 1) header.writeUInt16LE(16, TIFF_SAMPLE_BITS_AT + sample * 2);
  return Buffer.concat([header, pixels]);
}

/** A stand-in for `dcraw_emu` that writes `picture` to the `-Z` path and prints `stderr` (shell words) after the way LibRaw does. */
function decoderStub(name: string, picture: string, stderr = ''): string {
  const script = path.join(stubDirectory, `${name}.sh`);
  const print = stderr === '' ? '' : `printf '%s\\n' ${stderr} >&2\n`;
  writeFileSync(script, `#!/bin/sh\nfor input; do :; done\nwhile [ $# -gt 0 ]; do if [ "$1" = "-Z" ]; then cp '${picture}' "$2"; fi; shift; done\n${print}`);
  chmodSync(script, 0o755);
  return script;
}

/** Which stand-in developed the result of a conversion, by the size of its picture; the error when the conversion failed. */
async function developedBy(result: unknown): Promise<Stub | Error> {
  if (result instanceof Error) return result;
  const meta = await sharp((result as { buffer: Buffer }).buffer).metadata();
  const found = (Object.keys(SIZES) as Stub[]).find((name) => SIZES[name].width === meta.width && SIZES[name].height === meta.height);
  if (found === undefined) throw new Error(`unexpected picture size ${meta.width}x${meta.height}`);
  return found;
}

describe('which dcraw_emu develops a NEF', () => {
  let stubs: { distro: string; he: string; refusing: string } | null = null;
  const setup = async () => {
    if (stubs === null) {
      const files = {} as Record<Stub, string>;
      for (const name of Object.keys(SIZES) as Stub[]) {
        files[name] = path.join(stubDirectory, `${name}.tiff`);
        writeFileSync(files[name], stubPicture(SIZES[name]));
      }
      stubs = {
        distro: decoderStub('distro', files.distro),
        he: decoderStub('he', files.he),
        refusing: decoderStub('refusing', files.distro, '"$input: data corrupted at 4275203"'),
      };
    }
    return stubs;
  };
  const convert = (distro: string, he: string, input: Buffer, format = 'nef') =>
    withBinaryAt('DCRAW_EMU_PATH', distro, () =>
      withBinaryAt('DCRAW_EMU_HE_PATH', he, () => dispatchConversion(input, format, 'png', {}, `stub.${format}`).catch((error: unknown) => error))
    );

  it.each([
    ['High Efficiency', HE_COMPRESSION],
    ['High Efficiency*', HE_STAR_COMPRESSION],
  ])('develops a NEF that says %s with the pinned build and the distribution build is not run', async (_name, value) => {
    const { distro, he } = await setup();
    expect(await developedBy(await convert(distro, he, buildNef({ tag: 0x51, value })))).toBe('he');
  });

  it('develops a NEF of any other compression, in either maker note layout, with the distribution build', async () => {
    const { distro, he } = await setup();
    for (const shape of [{ tag: 0x51 as const, value: LOSSLESS_COMPRESSION }, { tag: 0x93 as const, value: LOSSLESS_COMPRESSION }, { tag: 0x93 as const, value: 10 }]) {
      expect(await developedBy(await convert(distro, he, buildNef(shape)))).toBe('distro');
    }
  });

  it('develops a NEF whose maker note cannot be read with the distribution build', async () => {
    const { distro, he } = await setup();
    const damaged = buildNef({ tag: 0x51, value: HE_COMPRESSION }).subarray(0, 60);
    expect(await developedBy(await convert(distro, he, damaged))).toBe('distro');
  });

  it('keeps the distribution build for a camera format other than NEF, whatever its maker note says', async () => {
    const { distro, he } = await setup();
    const result = await developedBy(await convert(distro, he, buildNef({ tag: 0x51, value: HE_COMPRESSION }), 'dng'));
    expect(result).not.toBe('he');
  });

  it("refuses a High Efficiency NEF with the distribution build's own words where the pinned build is not installed", async () => {
    const { refusing } = await setup();
    const error = await withMissingBinary('DCRAW_EMU_HE_PATH', () =>
      withBinaryAt('DCRAW_EMU_PATH', refusing, () => dispatchConversion(buildNef({ tag: 0x51, value: HE_COMPRESSION }), 'nef', 'png', {}, 'z-f.nef').catch((caught: unknown) => caught))
    );
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/Native RAW decoder reported a problem with the \.nef file: .*data corrupted at 4275203/);
  });
});

const SAMPLES = ['nef-zf', 'nef-z9he'] as const;
const GRID_WIDTH = 64;
const GRID_HEIGHT = 44;
const MIN_CORRELATION = 0.95;
/** Sensor size of each sample and the size of the picture `dcraw_emu` develops from it. */
const DEVELOPED: Record<(typeof SAMPLES)[number], { width: number; height: number }> = {
  'nef-zf': { width: 6064, height: 4040 },
  'nef-z9he': { width: 8280, height: 5520 },
};

/** A 64 x 44 grid of luma values of `bytes`. */
async function lumaGrid(bytes: Buffer): Promise<number[]> {
  const grid = await sharp(bytes).greyscale().resize(GRID_WIDTH, GRID_HEIGHT, { fit: 'fill' }).raw().toBuffer();
  return [...grid];
}

function correlation(a: number[], b: number[]): number {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const [meanA, meanB] = [mean(a), mean(b)];
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  a.forEach((value, index) => {
    covariance += (value - meanA) * (b[index] - meanB);
    varianceA += (value - meanA) ** 2;
    varianceB += (b[index] - meanB) ** 2;
  });
  return covariance / Math.sqrt(varianceA * varianceB);
}

describe('the Nikon High Efficiency samples with the pinned build', () => {
  const noBuild = skipUnless('the pinned LibRaw build for Nikon HE files (scripts/install-libraw-he.sh)', resolveNativeBinary('dcrawEmuHe') !== null);
  const noSamples = skipWithoutRawSamples(...SAMPLES);
  const noTools = skipWithoutTools('dcraw_emu', 'exiftool');
  const skip = noBuild || noSamples || noTools;

  for (const sample of SAMPLES) {
    for (const target of ['jpg', 'png'] as const) {
      it.skipIf(skip)(`${sample} is developed to ${target} at the sensor size and matches the picture the camera embedded`, async () => {
        const file = rawSamplePath(sample);
        const result = await dispatchConversion(readFileSync(file), 'nef', target, {}, `${sample}.nef`);
        expect(result.engineUsed).toBe('native-raw');
        expect(result.metadata?.warnings).toBeUndefined();
        const meta = await sharp(result.buffer).metadata();
        expect(meta.format).toBe(target === 'jpg' ? 'jpeg' : 'png');
        expect({ width: meta.width, height: meta.height }).toEqual(DEVELOPED[sample]);
        const embedded = execFileSync(requireOracleTool('exiftool'), ['-b', '-JpgFromRaw', file], { maxBuffer: 64 * 1024 * 1024 });
        expect(correlation(await lumaGrid(embedded), await lumaGrid(result.buffer))).toBeGreaterThan(MIN_CORRELATION);
      });
    }
  }
});
