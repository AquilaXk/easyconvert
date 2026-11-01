import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RawDecodeError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { PHOTOMETRIC, RAW_SIZE, TAG, TYPE, buildTiff, imageEntries, minimalDng, withIfd0Values } from './helpers/dng-builder';
import { withBinaryAt } from './helpers/native-tools';
import { rawSamplePath, skipWithoutRawSamples, skipWithoutTools } from './helpers/strict-skip';

/**
 * LibRaw prints `<file>: data corrupted at <offset>` when a decoded sample lies outside the bit depth the file states (derror() in
 * src/utils/utils_libraw.cpp, called from ljpeg_row in src/decoders/decoders_dcraw.cpp) and goes on decoding. A Samsung Galaxy S23 DNG
 * states 12 bits and stores 7,489 green samples up to 4183 in a bright patch, which prints the line and develops completely: the
 * lossless JPEG of its strip decodes sample for sample the same in libjpeg-turbo, which does not warn. After that first report derror()
 * no longer checks for the end of the stream, so the same file cut short also decodes to a full-size image with only that line; the
 * engine accepts the line for a DNG that holds every strip of its raw image and whose decoded image does not end in repeated rows. The
 * real file and cut copies of it are converted here, and a stand-in decoder that prints chosen lines runs the engine's own checks
 * (sandbox, completeness, repeated tail) over images it writes, so that every other kind of report keeps refusing the file.
 */

const TEST_TIMEOUT_MS = 180_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

const S23 = 'dng-s23';
const S23_WIDTH = 4000;
const S23_HEIGHT = 2252;
const WARNING_PATTERN = /corrupted data at byte 4384328 of the file; some samples of the picture may be wrong/;
/** The S23 file is 25,412,616 bytes; its one strip ends at byte 25,412,551. */
const S23_STRIP_END = 25_412_551;
/** A cut where only about 10 % of the S23 rows are left to fill. */
const S23_LATE_CUT = 23_000_000;
const PREVIEW_GRID_WIDTH = 64;
const PREVIEW_GRID_HEIGHT = 36;
const PREVIEW_BANDS = 4;
const MIN_BAND_CORRELATION = 0.97;
const MIN_IMAGE_CORRELATION = 0.98;
const TEMP_PREFIX = 'easyconvert-raw-';

const stubDirectory = mkdtempSync(path.join(os.tmpdir(), 'raw-warning-stub-'));
afterAll(() => rmSync(stubDirectory, { recursive: true, force: true }));

describe('a camera file whose decoder warns about samples outside the stated bit depth', () => {
  const noTool = skipWithoutTools('dcraw_emu', 'exiftool') || skipWithoutRawSamples(S23);
  const s23 = () => readFileSync(rawSamplePath(S23));

  for (const target of ['jpg', 'png']) {
    it.skipIf(noTool)(`the Samsung Galaxy S23 DNG is developed to ${target} in full and the result carries the warning`, async () => {
      const bytes = s23();
      const result = await dispatchConversion(bytes, 'dng', target, {}, 'samsung-s23.dng');
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

  it.skipIf(noTool).each([S23_LATE_CUT, S23_STRIP_END - 1])('the same file cut to %i bytes is refused as truncated, though the decoder prints only the warning', async (cut) => {
    const error = await dispatchConversion(s23().subarray(0, cut), 'dng', 'jpg', {}, 'samsung-s23.dng').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/\.dng file is truncated: its raw image data runs past the end of the file/);
  });

  it.skipIf(noTool)('the same file cut where its strip ends, without the bytes after it, is developed with the warning', async () => {
    const result = await dispatchConversion(s23().subarray(0, S23_STRIP_END), 'dng', 'jpg', {}, 'samsung-s23.dng');
    expect(result.metadata?.warnings).toEqual([expect.stringMatching(WARNING_PATTERN)]);
  });

  // A download that stopped early but kept the file's size, the rest zeros, holds every strip in the directory's eyes; the bottom-run
  // test of the decoded image is what refuses it.
  it.skipIf(noTool)('the same file cut late and padded with zeros to its full size is refused by its repeated bottom rows', async () => {
    const padded = Buffer.alloc(s23().length);
    s23().copy(padded, 0, 0, S23_LATE_CUT);
    const error = await dispatchConversion(padded, 'dng', 'jpg', {}, 'samsung-s23.dng').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/\.dng file is truncated: the decoded image ends in repeated filler rows/);
  });
});

describe('a DNG whose decoder writes a picture of another size than its raw directory', () => {
  const noTool = skipWithoutTools('dcraw_emu') || skipWithoutRawSamples('dng');

  // The Canon CFA DNG is 960 x 540 with ActiveArea 0 0 540 960. LibRaw drops a row or a column to start on an even Bayer margin and
  // stretches non-square pixels, so these copies decode smaller or taller than their directory says; a decoder that also prints the line
  // must still develop them.
  it.skipIf(noTool).each([
    ['ActiveArea 1 1 540 960', TAG.activeArea, [1, 1, 540, 960], { width: 958, height: 538 }],
    ['ActiveArea 1 0 540 960', TAG.activeArea, [1, 0, 540, 960], { width: 960, height: 538 }],
    ['ActiveArea 0 1 540 960', TAG.activeArea, [0, 1, 540, 960], { width: 958, height: 540 }],
    ['ActiveArea 3 3 540 960', TAG.activeArea, [3, 3, 540, 960], { width: 956, height: 536 }],
    ['DefaultScale 1:2', TAG.defaultScale, [1, 1, 2, 1], { width: 960, height: 1080 }],
  ])('develops the Canon CFA DNG with %s at the size LibRaw writes, with the warning', async (_name, tag, values, size) => {
    const input = withIfd0Values(readFileSync(rawSamplePath('dng')), tag, values);
    const result = await convertWith(warningDecoder(), input);
    expect(result).not.toBeInstanceOf(Error);
    const developed = result as { buffer: Buffer; metadata?: { warnings?: string[] } };
    expect(developed.metadata?.warnings).toEqual([expect.stringMatching(/corrupted data at byte 3 of the file/)]);
    const meta = await sharp(developed.buffer).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual(size);
  });
});

describe('what the decoder prints decides whether its image is developed', () => {
  it('develops a complete image after the data-corrupted line and keeps the line as a warning', async () => {
    const stub = decoderStub('good', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), '"$input: data corrupted at 3"');
    const result = await convertWith(stub);
    expect(result).not.toBeInstanceOf(Error);
    expect((result as { metadata?: { warnings?: string[] } }).metadata?.warnings).toEqual([expect.stringMatching(/corrupted data at byte 3 of the file/)]);
  });

  it('refuses the line for a DNG whose raw strip runs past the end of the file, though the image is complete', async () => {
    const stub = decoderStub('cut-dng', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), '"$input: data corrupted at 3"');
    const error = await convertWith(stub, minimalDng(DNG_STRIP_BYTES, DNG_BYTES.length - 1));
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/\.dng file is truncated: its raw image data runs past the end of the file/);
  });

  it('refuses the line for a DNG whose full-resolution IFD0 is no raw image and whose raw SubIFD is cut inside its strip', async () => {
    const stub = decoderStub('cut-subifd', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), '"$input: data corrupted at 3"');
    const file = buildTiff(4096, [
      { at: 8, entries: [...imageEntries([[2000, 1000]], { photometric: PHOTOMETRIC.yCbCr }), { tag: TAG.subIfds, type: TYPE.ifd, values: [200] }] },
      { at: 200, entries: imageEntries([[3000, 1200]]) },
    ]);
    const error = await convertWith(stub, file);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/\.dng file is truncated: its raw image data runs past the end of the file/);
  });

  it.each([
    ['a picture the size of a preview of its raw image', decodedTiff(WIDTH / 2, GOOD_ROWS / 2, GOOD_ROWS / 2), DNG_BYTES, /its raw image is not the size of the decoded picture/],
    ['a file that is no classic TIFF', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), bigTiff(), /the file is not a classic TIFF/],
    ['a DNG that lists no raw image', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), buildTiff(4096, [{ at: 8, entries: imageEntries([[200, 100]], { photometric: PHOTOMETRIC.yCbCr }) }]), /it lists no CFA or Linear Raw image/],
    [
      'a DNG with an entry through which the decoder reads a directory the check does not follow',
      decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS),
      buildTiff(4096, [{ at: 8, entries: [...imageEntries([[200, 100]]), { tag: TAG.hasselblad, type: TYPE.long, values: [300] }] }]),
      /it holds an entry through which the decoder reads a directory this check does not follow/,
    ],
    [
      'a DNG whose ActiveArea runs backwards',
      decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS),
      buildTiff(4096, [{ at: 8, entries: [...imageEntries([[200, 100]]), { tag: TAG.activeArea, type: TYPE.long, values: [100, 0, 50, 64], at: 300 }] }]),
      /its ActiveArea is negative or wider or taller than 65535/,
    ],
  ])('refuses the line for %s, saying why it could not be checked', async (_name, decoded, input, reason) => {
    const error = await convertWith(decoderStub('unchecked', decoded, '"$input: data corrupted at 3"'), input);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/reported corrupted data in the \.dng file, and the file cannot be shown to be whole/);
    expect((error as RawDecodeError).message).toMatch(reason);
  });

  it('refuses the line for a camera format other than DNG, whose directory does not show a cut', async () => {
    const stub = decoderStub('nef', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), '"$input: data corrupted at 3"');
    const error = await withBinaryAt('DCRAW_EMU_PATH', stub, () => dispatchConversion(DNG_BYTES, 'nef', 'png', {}, 'stub.nef').catch((caught: unknown) => caught));
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/reported a problem with the \.nef file: .*data corrupted at 3/);
  });

  it('refuses the line over an image whose last 9 rows each repeat the row two above, and accepts 8, or 9 when the decoder printed nothing', async () => {
    const line = '"$input: data corrupted at 3"';
    const nine = await convertWith(decoderStub('nine', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS - 10), line));
    expect(nine).toBeInstanceOf(RawDecodeError);
    expect((nine as RawDecodeError).message).toMatch(/truncated: the decoded image ends in repeated filler rows/);
    expect(await convertWith(decoderStub('eight', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS - 9), line))).not.toBeInstanceOf(Error);
    expect(await convertWith(decoderStub('nine-silent', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS - 10), ''))).not.toBeInstanceOf(Error);
  });

  it('develops a complete image that printed nothing without a warning', async () => {
    const result = await convertWith(decoderStub('silent', decodedTiff(WIDTH, GOOD_ROWS, GOOD_ROWS), ''));
    expect(result).not.toBeInstanceOf(Error);
    expect((result as { metadata?: unknown }).metadata).toBeUndefined();
  });

  it.each([
    ['a DNG that printed a line it is refused for', 'dng', '"something went wrong"', /reported a problem with the \.dng file: something went wrong/],
    ['a NEF that printed the data-corrupted line', 'nef', '"$input: data corrupted at 3"', /reported a problem with the \.nef file: .*data corrupted at 3/],
  ])('reports what the decoder printed, not the unreadable image it wrote, for %s', async (_name, format, line, message) => {
    const stub = decoderStub(`unreadable-${format}`, Buffer.from('not a TIFF image'), line);
    const error = await withBinaryAt('DCRAW_EMU_PATH', stub, () => dispatchConversion(DNG_BYTES, format, 'png', {}, `stub.${format}`).catch((caught: unknown) => caught));
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(message);
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

const DNG_STRIP_BYTES = 200;
const DNG_BYTES = minimalDng(DNG_STRIP_BYTES);
const WIDTH = RAW_SIZE.width;
const GOOD_ROWS = RAW_SIZE.height;

/** The stand-in DNG with the magic number of BigTIFF. */
function bigTiff(): Buffer {
  const file = minimalDng(DNG_STRIP_BYTES);
  file.writeUInt16LE(43, 2);
  return file;
}

function convertWith(stub: string, input = DNG_BYTES): Promise<unknown> {
  return withBinaryAt('DCRAW_EMU_PATH', stub, () => dispatchConversion(input, 'dng', 'png', {}, 'stub.dng').catch((error: unknown) => error));
}

/** The real dcraw_emu, followed by LibRaw's data-corrupted line for the file it was given. */
function warningDecoder(): string {
  const script = path.join(stubDirectory, 'warning-decoder.sh');
  writeFileSync(script, `#!/bin/sh\n'${requireOracleTool('dcraw_emu')}' "$@" || exit $?\nfor input; do :; done\nprintf '%s\\n' "$input: data corrupted at 3" >&2\n`);
  chmodSync(script, 0o755);
  return script;
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
  const eightBit = await sharp(image).removeAlpha().toColourspace('srgb').png().toBuffer();
  const grid = await sharp(eightBit).greyscale().resize(PREVIEW_GRID_WIDTH, PREVIEW_GRID_HEIGHT, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer();
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
