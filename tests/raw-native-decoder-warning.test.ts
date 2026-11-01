import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RawDecodeError } from '../src/lib/types';
import { requireBenchSample } from './helpers/bench-sample';
import { requireOracleTool } from './helpers/differential-oracle';
import { withBinaryAt } from './helpers/native-tools';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * LibRaw prints `<file>: data corrupted at <offset>` when a decoded sample lies outside the bit depth the file states (derror() in
 * src/utils/utils_libraw.cpp, called from ljpeg_row in src/decoders/decoders_dcraw.cpp) and goes on decoding, so the image it writes is
 * whole. A Samsung Galaxy S23 DNG states 12 bits and stores 7,489 green samples up to 4183 in a bright patch, which prints the line and
 * develops completely: the lossless JPEG of its strip decodes sample for sample the same in libjpeg-turbo, which does not warn. The
 * real file is converted here, and a stand-in decoder that prints chosen lines runs the engine's own checks (sandbox, completeness,
 * repeated tail) over images it writes, so that every other kind of report keeps refusing the file.
 */

const TEST_TIMEOUT_MS = 180_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

const S23 = 'raw-samsung-s23.dng';
const S23_WIDTH = 4000;
const S23_HEIGHT = 2252;
const WARNING_PATTERN = /out of range.*byte 4384328/;
const PREVIEW_GRID_WIDTH = 64;
const PREVIEW_GRID_HEIGHT = 36;
const PREVIEW_BANDS = 4;
const MIN_BAND_CORRELATION = 0.9;
const MIN_IMAGE_CORRELATION = 0.98;
const TEMP_PREFIX = 'easyconvert-raw-';

const stubDirectory = mkdtempSync(path.join(os.tmpdir(), 'raw-warning-stub-'));
afterAll(() => rmSync(stubDirectory, { recursive: true, force: true }));

describe('a camera file whose decoder warns about samples outside the stated bit depth', () => {
  const noTool = skipWithoutTools('dcraw_emu', 'exiftool');

  for (const target of ['jpg', 'png']) {
    it.skipIf(noTool)(`the Samsung Galaxy S23 DNG is developed to ${target} in full and the result carries the warning`, async (ctx) => {
      const bytes = await requireBenchSample(ctx, S23);
      const result = await dispatchConversion(bytes, 'dng', target, {}, S23);
      expect(result.engineUsed).toBe('native-raw');
      expect(result.metadata?.warnings).toEqual([expect.stringMatching(WARNING_PATTERN)]);
      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe(target === 'jpg' ? 'jpeg' : 'png');
      expect({ width: meta.width, height: meta.height }).toEqual({ width: S23_WIDTH, height: S23_HEIGHT });

      const decoded = await lumaGrid(result.buffer);
      const preview = await lumaGrid(embeddedPreview(bytes));
      expect(correlation(decoded, preview)).toBeGreaterThan(MIN_IMAGE_CORRELATION);
      const bandCells = decoded.length / PREVIEW_BANDS;
      for (let band = 0; band < PREVIEW_BANDS; band += 1) {
        const cells = [band * bandCells, (band + 1) * bandCells] as const;
        expect(correlation(decoded.slice(...cells), preview.slice(...cells)), `band ${band} of the picture against the camera's own preview`).toBeGreaterThan(MIN_BAND_CORRELATION);
      }
    });
  }
});

describe('what the decoder prints decides whether its image is developed', () => {
  const GOOD_ROWS = 100;
  const WIDTH = 64;

  it('develops a complete image after the data-corrupted line and keeps the line as a warning', async () => {
    const stub = decoderStub('good', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), '"$input: data corrupted at 3"');
    const result = await convertWith(stub);
    expect(result).not.toBeInstanceOf(Error);
    expect((result as { metadata?: { warnings?: string[] } }).metadata?.warnings).toEqual([expect.stringMatching(/out of range.*byte 3\b/)]);
  });

  it('develops a complete image that printed nothing without a warning', async () => {
    const result = await convertWith(decoderStub('silent', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), ''));
    expect(result).not.toBeInstanceOf(Error);
    expect((result as { metadata?: unknown }).metadata).toBeUndefined();
  });

  it('still refuses a cut file whose image ends in repeated rows, warning or not', async () => {
    const stub = decoderStub('repeated', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS / 2), '"$input: data corrupted at 3"');
    const error = await convertWith(stub);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/truncated.*repeated filler rows/);
  });

  it('still refuses an image shorter than its header declares, warning or not', async () => {
    const stub = decoderStub('short', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS, GOOD_ROWS / 2), '"$input: data corrupted at 3"');
    const error = await convertWith(stub);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/shorter than its header declares/);
  });

  it.each([
    ['an unexpected end of file', '"$input: Unexpected end of file"'],
    ['a data-corrupted line of another file', '"other.dng: data corrupted at 3"'],
    ['an offset that is not a number', '"$input: data corrupted at three"'],
    ['an offset beyond the end of the file', '"$input: data corrupted at 99999999"'],
    ['a data-corrupted line followed by another report', '"$input: data corrupted at 3" "Cannot do postprocessing on $input: Bad crop"'],
    ['text of any other kind', '"something went wrong"'],
  ])('still refuses %s even though the image is complete', async (_name, stderrLines) => {
    const stub = decoderStub('refused', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), stderrLines);
    const error = await convertWith(stub);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/reported a problem with the \.dng file/);
  });

  it('removes the working directory after a developed warning and after a refusal', async () => {
    const privateTmp = mkdtempSync(path.join(stubDirectory, 'tmp-'));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = privateTmp;
    try {
      await convertWith(decoderStub('cleanup-good', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), '"$input: data corrupted at 3"'));
      await convertWith(decoderStub('cleanup-bad', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), '"something went wrong"'));
      const leftovers = readdirSync(privateTmp).filter((name) => name.startsWith(TEMP_PREFIX));
      expect(leftovers).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });
});

const DNG_BYTES = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]), Buffer.alloc(200)]);

function convertWith(stub: string): Promise<unknown> {
  return withBinaryAt('DCRAW_EMU_PATH', stub, () => dispatchConversion(DNG_BYTES, 'dng', 'png', {}, 'stub.dng').catch((error: unknown) => error));
}

/**
 * A stand-in for dcraw_emu that copies `decoded` to the `-Z` path and prints `stderrLines` (shell words, `$input` is the file it was
 * given) to stderr, one line each, after the way LibRaw does.
 */
function decoderStub(name: string, decoded: Buffer, stderrLines: string): string {
  const image = path.join(stubDirectory, `${name}.tiff`);
  writeFileSync(image, decoded);
  const script = path.join(stubDirectory, `${name}.sh`);
  const print = stderrLines === '' ? '' : `printf '%s\\n' ${stderrLines} >&2\n`;
  writeFileSync(script, `#!/bin/sh\nfor input; do :; done\nwhile [ $# -gt 0 ]; do if [ "$1" = "-Z" ]; then cp '${image}' "$2"; fi; shift; done\n${print}`);
  chmodSync(script, 0o755);
  return script;
}

const TIFF_ENTRIES = 8;
const TIFF_HEADER_BYTES = 8;
const TIFF_ENTRY_BYTES = 12;
const TIFF_DIRECTORY_BYTES = 2 + TIFF_ENTRIES * TIFF_ENTRY_BYTES + 4;
const TIFF_SAMPLE_BITS_OFFSET = TIFF_HEADER_BYTES + TIFF_DIRECTORY_BYTES;
const TIFF_PIXEL_OFFSET = TIFF_SAMPLE_BITS_OFFSET + 6;
const SHORT = 3;
const LONG = 4;

/**
 * The 16-bit RGB TIFF dcraw_emu writes, in one strip. Every row differs from its neighbours except the rows from `distinctRows` on,
 * which repeat the row before (what a decoder leaves when the file ends), and `writtenRows` cuts the pixel data short.
 */
function decodedTiff(width: number, height: number, distinctRows: number, writtenRows = height): Buffer {
  const rowBytes = width * 6;
  const pixels = Buffer.alloc(rowBytes * writtenRows);
  for (let row = 0; row < writtenRows; row += 1) {
    const source = Math.min(row, distinctRows - 1);
    for (let index = 0; index < width * 3; index += 1) pixels.writeUInt16LE((index * 517 + source * 131 + 977) & 0xffff, row * rowBytes + index * 2);
  }
  const header = Buffer.alloc(TIFF_PIXEL_OFFSET);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(TIFF_HEADER_BYTES, 4);
  header.writeUInt16LE(TIFF_ENTRIES, TIFF_HEADER_BYTES);
  const entries: Array<[number, number, number]> = [
    [256, LONG, width],
    [257, LONG, height],
    [258, SHORT, TIFF_SAMPLE_BITS_OFFSET],
    [262, SHORT, 2],
    [273, LONG, TIFF_PIXEL_OFFSET],
    [277, SHORT, 3],
    [278, LONG, height],
    [279, LONG, rowBytes * height],
  ];
  entries.forEach(([tag, type, value], index) => {
    const at = TIFF_HEADER_BYTES + 2 + index * TIFF_ENTRY_BYTES;
    header.writeUInt16LE(tag, at);
    header.writeUInt16LE(type, at + 2);
    header.writeUInt32LE(type === SHORT && tag === 258 ? 3 : 1, at + 4);
    if (type === SHORT && tag !== 258) header.writeUInt16LE(value, at + 8);
    else header.writeUInt32LE(value, at + 8);
  });
  for (let sample = 0; sample < 3; sample += 1) header.writeUInt16LE(16, TIFF_SAMPLE_BITS_OFFSET + sample * 2);
  return Buffer.concat([header, pixels]);
}

/** The full-size JPEG preview of a DNG, extracted by exiftool. */
function embeddedPreview(dng: Buffer): Buffer {
  return execFileSync(requireOracleTool('exiftool'), ['-b', '-PreviewImage', '-'], { input: dng, maxBuffer: 64 * 1024 * 1024 });
}

/** The brightness of a picture on a coarse grid, row by row. */
async function lumaGrid(image: Buffer): Promise<number[]> {
  const grid = await sharp(image).removeAlpha().toColourspace('b-w').resize(PREVIEW_GRID_WIDTH, PREVIEW_GRID_HEIGHT, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer();
  return [...grid];
}

/** Pearson correlation of two equally long series. */
function correlation(first: readonly number[], second: readonly number[]): number {
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const [meanFirst, meanSecond] = [mean(first), mean(second)];
  let covariance = 0;
  let varianceFirst = 0;
  let varianceSecond = 0;
  first.forEach((value, index) => {
    const [a, b] = [value - meanFirst, second[index] - meanSecond];
    covariance += a * b;
    varianceFirst += a * a;
    varianceSecond += b * b;
  });
  return covariance / Math.sqrt(varianceFirst * varianceSecond);
}
