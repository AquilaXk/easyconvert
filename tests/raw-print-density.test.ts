import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requireOracleTool, type ExternalOracleTool } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
import { oracleTest } from './helpers/oracle-test';
import { pdfPageSizes, postscriptInkSizes, type PageSize } from './helpers/page-sizes';

/**
 * A camera RAW file states no print size, so a page written from it is one pixel to the point on every route: the native decoder (whose
 * TIFF states a constant 300 dpi of its own), the embedded preview (a JPEG whose Exif resolution is the camera's, 72 to 600 among these
 * samples) and the in-process sensor decoders. The expected page is the picture's pixel size, read by LibRaw's identify tool (native
 * decoder) or by the image library from the PNG of the same conversion (preview); the stated resolutions are read back by exiftool to show
 * that the samples would give another page if they were honoured.
 */

const RAW_CACHE_DIR = path.join(__dirname, 'fixtures', 'raw', '.cache');
const TOOLS: readonly ExternalOracleTool[] = ['gs', 'pdfinfo', 'exiftool', 'raw-identify', 'dcraw_emu'];
const CONVERSION_TIMEOUT_MS = 300_000;
const PAGE_TOLERANCE_POINTS = 0.1;
const POINTS_PER_INCH = 72;
const TARGETS = ['ps', 'eps', 'pdf'] as const;
/** Samples whose camera states a resolution other than 72 dpi. */
const SOURCES = ['orf', 'rw2', 'cr2', 'nef', 'arw'] as const;
/** Samples whose embedded preview the in-process route can extract. */
const PREVIEW_SOURCES = ['orf', 'rw2', 'cr3'] as const;
const OUTPUT_SIZE_PATTERN = /Output size:\s+(\d+) x (\d+)/;
const SENSOR_SOURCES = ['x3f', 'raw'] as const;

function sample(source: string): Buffer | null {
  const file = path.join(RAW_CACHE_DIR, `${source}.${source}`);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function requireSample(source: string): Buffer {
  const bytes = sample(source);
  if (bytes === null) throw new Error(`RAW sample ${source} is missing; run npm run fixtures:raw`);
  return bytes;
}

function identifiedSize(source: string): PageSize {
  const text = execFileSync(requireOracleTool('raw-identify'), ['-v', path.join(RAW_CACHE_DIR, `${source}.${source}`)], { encoding: 'utf-8' });
  const match = OUTPUT_SIZE_PATTERN.exec(text);
  if (match === null) throw new Error(`raw-identify reported no output size for ${source}`);
  return [Number(match[1]), Number(match[2])];
}

/** The resolution the camera file itself states (Exif, dots per inch), read by exiftool. */
function statedDpi(source: string): number {
  const text = execFileSync(requireOracleTool('exiftool'), ['-s3', '-n', '-IFD0:XResolution', path.join(RAW_CACHE_DIR, `${source}.${source}`)], { encoding: 'utf-8' });
  return Number(text.trim() || POINTS_PER_INCH);
}

function pageSizes(output: Buffer, target: string): PageSize[] {
  return target === 'pdf' ? pdfPageSizes(output) : postscriptInkSizes(output);
}

function expectPages(actual: PageSize[], expected: PageSize): void {
  expect(actual).toHaveLength(1);
  expect(Math.abs(actual[0][0] - expected[0])).toBeLessThanOrEqual(PAGE_TOLERANCE_POINTS);
  expect(Math.abs(actual[0][1] - expected[1])).toBeLessThanOrEqual(PAGE_TOLERANCE_POINTS);
}

describe('a page written from camera RAW is one pixel to the point', () => {
  for (const source of SOURCES) {
    for (const target of TARGETS) {
      oracleTest(
        `${source} -> ${target} through the native decoder`,
        [...TOOLS],
        async () => {
          const result = await dispatchConversion(requireSample(source), source, target, {}, `sample.${source}`);
          expectPages(pageSizes(result.buffer, target), identifiedSize(source));
        },
        CONVERSION_TIMEOUT_MS
      );
    }
  }

  for (const source of PREVIEW_SOURCES) {
    for (const target of TARGETS) {
      oracleTest(
        `${source} -> ${target} through the embedded preview`,
        [...TOOLS],
        async () => {
          const bytes = requireSample(source);
          const options = { allowEmbeddedPreview: true };
          const [picture, result] = await withMissingBinary('DCRAW_EMU_PATH', async () => [
            await dispatchConversion(bytes, source, 'png', options, `sample.${source}`),
            await dispatchConversion(bytes, source, target, options, `sample.${source}`),
          ]);
          expect(result.engineUsed).toBe('internal-fallback');
          const meta = await sharp(picture.buffer).metadata();
          expectPages(pageSizes(result.buffer, target), [meta.width ?? 0, meta.height ?? 0]);
        },
        CONVERSION_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'the samples do state resolutions other than 72 dpi, so the check above can tell',
    [...TOOLS],
    () => {
      expect(new Set(SOURCES.map(statedDpi)).size).toBeGreaterThan(1);
      expect(SOURCES.map(statedDpi).filter((dpi) => dpi !== POINTS_PER_INCH).length).toBeGreaterThan(0);
    }
  );

  for (const source of SENSOR_SOURCES) {
    for (const target of TARGETS) {
      oracleTest(
        `${source} -> ${target} through the in-process sensor decoder`,
        [...TOOLS],
        async () => {
          const bytes = requireSample(source);
          const result = await dispatchConversion(bytes, source, target, {}, `sample.${source}`);
          const picture = await dispatchConversion(bytes, source, 'png', {}, `sample.${source}`);
          const meta = await sharp(picture.buffer).metadata();
          expectPages(pageSizes(result.buffer, target), [meta.width ?? 0, meta.height ?? 0]);
        },
        CONVERSION_TIMEOUT_MS
      );
    }
  }
});
