import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { decodeOpenExr } from '../src/lib/conversions/raw-hdr';
import { MAX_OPENEXR_PIXELS, OpenExrDecodeError, type OpenExrErrorKind } from '../src/lib/conversions/openexr-decode';
import { ConversionFailedError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { decodeExrWithFfmpeg } from './helpers/ffmpeg-exr';
import { oracleTest } from './helpers/oracle-test';
import { halfBitsToFloat, floatToHalfBits } from './helpers/openexr-writer';
import {
  assembleExr,
  COMPRESSION_CODES,
  EXR_FLAG_MULTIPART,
  EXR_FLAG_NON_IMAGE,
  EXR_FLAG_TILED,
  exrChunkOffsets,
  exrOffsetTableStart,
  PIXEL_TYPE_FLOAT,
  PIXEL_TYPE_HALF,
  scanlineChunk,
  tileChunk,
  withChunkOffset,
  withWindowMovedToOrigin,
} from './helpers/exr-assemble';

/**
 * OpenEXR decoder: compressed scanline files, tiled files and fail-closed rejection.
 *
 * The golden corpus in tests/fixtures/exr was written by the OpenEXR reference library and its
 * expected pixels were read back with the same library (see generate-exr-fixtures.py), so neither
 * the inputs nor the oracle depend on this repository's code. FFmpeg's exr decoder and encoder are
 * a second, separate oracle. Hostile containers are assembled by tests/helpers/exr-assemble.ts.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'exr');
const RGB_COMPONENTS = 3;
const FLOAT_BYTES = 4;
const HALF_BYTES = 2;
const HALF_RELATIVE_TOLERANCE = 2 ** -10;
const HALF_ABSOLUTE_TOLERANCE = 2 ** -24;
const REFERENCE_PEAK_MINIMUM = 7;
const OFFSET_TABLE_ENTRY_BYTES = 8;
const FFMPEG_CROSS_CHECK_TIMEOUT_MS = 60_000;
const BOMB_ZERO_BYTES = 4 * 1024 * 1024;
const OVERSIZED_WINDOW_MAX = 99_999;
const TRUNCATION_TAIL_BYTES = 5;
const HEADER_CUT_BYTES = 40;
const TILE_HEADER_AND_FEW_BYTES = 26;

interface FixtureEntry {
  file: string;
  golden: string;
  compression: string;
  layout: 'scanline' | 'tiled';
  levelMode?: string;
  sample: 'half' | 'float' | 'uint';
  lossy: boolean;
  channelNames?: string;
}

interface Manifest {
  width: number;
  height: number;
  xMin: number;
  yMin: number;
  fixtures: FixtureEntry[];
  goldens: Record<string, string>;
  reject: { file: string; reason: string }[];
}

const manifest = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as Manifest;

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, name));
}

function golden(name: string): Float32Array {
  const bytes = fixture(name);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

/** Index of the first sample whose bit pattern differs (NaN-safe), or -1 when identical. */
function firstMismatch(actual: Float32Array, expected: Float32Array): number {
  if (actual.length !== expected.length) return Math.min(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    if (!Object.is(actual[i], expected[i])) return i;
  }
  return -1;
}

function expectDecodeError(run: () => unknown, kind: OpenExrErrorKind, message?: RegExp): OpenExrDecodeError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OpenExrDecodeError);
  expect(caught).toBeInstanceOf(ConversionFailedError);
  const failure = caught as OpenExrDecodeError;
  expect(failure.kind).toBe(kind);
  if (message) expect(failure.message).toMatch(message);
  return failure;
}

function fixtureByName(file: string): FixtureEntry {
  const entry = manifest.fixtures.find((candidate) => candidate.file === file);
  if (!entry) throw new Error(`fixture ${file} missing from the manifest`);
  return entry;
}

describe('OpenEXR reference corpus', () => {
  it('covers every supported compression, layout, level mode and sample type', () => {
    const compressions = new Set(manifest.fixtures.map((entry) => entry.compression));
    expect([...compressions].sort()).toEqual(['none', 'piz', 'pxr24', 'rle', 'zip', 'zips']);
    const scanlineCompressions = new Set(manifest.fixtures.filter((e) => e.layout === 'scanline').map((e) => e.compression));
    expect([...scanlineCompressions].sort()).toEqual(['none', 'piz', 'pxr24', 'rle', 'zip', 'zips']);
    const levelModes = new Set(manifest.fixtures.filter((e) => e.layout === 'tiled').map((e) => e.levelMode));
    expect([...levelModes].sort()).toEqual(['mipmap', 'one', 'ripmap']);
    const samples = new Set(manifest.fixtures.map((entry) => entry.sample));
    expect([...samples].sort()).toEqual(['float', 'half', 'uint']);
  });

  it('pins the golden pixel files to the digests recorded by the generator', () => {
    for (const [name, digest] of Object.entries(manifest.goldens)) {
      expect(createHash('sha256').update(fixture(name)).digest('hex')).toBe(digest);
    }
  });

  it('uses HDR reference content, not flat or clipped data', () => {
    const half = golden('golden-rgb-half.f32');
    expect(Math.max(...half)).toBeGreaterThan(REFERENCE_PEAK_MINIMUM);
    expect(Math.min(...half)).toBeLessThan(0);
    // The float golden keeps full mantissas in the noise band, so it has more distinct values than half.
    expect(new Set(golden('golden-rgb-float.f32')).size).toBeGreaterThan(new Set(half).size);
  });

  it.each(manifest.fixtures.map((entry) => [entry.file, entry] as const))('decodes %s to the reference pixels', (_file, entry) => {
    const decoded = decodeOpenExr(fixture(entry.file));
    const expected = golden(entry.golden);
    expect(decoded.width).toBe(manifest.width);
    expect(decoded.height).toBe(manifest.height);
    expect(decoded.rgb.length).toBe(manifest.width * manifest.height * RGB_COMPONENTS);
    expect(decoded.isHalf).toBe(entry.sample === 'half');
    expect(firstMismatch(decoded.rgb, expected)).toBe(-1);
  });

  it('feeds the codecs compressed blocks, not raw fallbacks, in every compressed scanline fixture', () => {
    const bytesPerPixel = (entry: FixtureEntry): number => {
      if (entry.channelNames === 'Y') return HALF_BYTES;
      if (entry.channelNames?.includes('diffuse')) return 4 * HALF_BYTES;
      if (entry.channelNames) return 3 * HALF_BYTES + HALF_BYTES + 2 * FLOAT_BYTES;
      return RGB_COMPONENTS * (entry.sample === 'half' ? HALF_BYTES : FLOAT_BYTES);
    };
    const perChunk: Record<string, number> = { rle: 1, zips: 1, zip: 16, pxr24: 16, piz: 32 };
    for (const entry of manifest.fixtures.filter((e) => e.layout === 'scanline' && e.compression !== 'none')) {
      const file = fixture(entry.file);
      const [first] = exrChunkOffsets(file, 1);
      const stored = file.readInt32LE(first + 4);
      const raw = manifest.width * perChunk[entry.compression] * bytesPerPixel(entry);
      expect(stored, entry.file).toBeLessThan(raw);
    }
  });

  it('keeps the original header attributes available to callers', () => {
    const decoded = decodeOpenExr(fixture('scanline-piz-half.exr'));
    expect(decoded.attrs.compression.val[0]).toBe(COMPRESSION_CODES.piz);
    const window = decoded.attrs.dataWindow.val;
    expect([window.readInt32LE(0), window.readInt32LE(4)]).toEqual([manifest.xMin, manifest.yMin]);
    expect(decoded.attrs.channels.type).toBe('chlist');
  });

  it('places the first dataWindow pixel at output index 0 regardless of the window origin', () => {
    const decoded = decodeOpenExr(fixture('scanline-zip-float.exr'));
    const expected = golden('golden-rgb-float.f32');
    expect([decoded.rgb[0], decoded.rgb[1], decoded.rgb[2]]).toEqual([expected[0], expected[1], expected[2]]);
    const last = decoded.rgb.length - RGB_COMPONENTS;
    expect([decoded.rgb[last], decoded.rgb[last + 1], decoded.rgb[last + 2]]).toEqual([expected[last], expected[last + 1], expected[last + 2]]);
  });

  it.each(manifest.fixtures.filter((e) => ['zip', 'piz', 'none'].includes(e.compression)).map((e) => [e.file, e] as const))(
    'gives %s the same pixels wherever its dataWindow sits',
    (_file, entry) => {
      const original = fixture(entry.file);
      const moved = withWindowMovedToOrigin(original, entry.layout === 'scanline');
      expect(moved.equals(original)).toBe(false);
      expect(firstMismatch(decodeOpenExr(moved).rgb, decodeOpenExr(original).rgb)).toBe(-1);
    }
  );

  it('reads colour from a named layer and ignores alpha, depth and id channels', () => {
    const expected = golden('golden-rgb-half.f32');
    for (const file of ['scanline-piz-layered.exr', 'scanline-piz-mixed-channels.exr', 'scanline-pxr24-mixed-channels.exr']) {
      expect(firstMismatch(decodeOpenExr(fixture(file)).rgb, expected)).toBe(-1);
    }
  });

  it('replicates a lone luminance channel into R, G and B', () => {
    const decoded = decodeOpenExr(fixture('scanline-piz-gray.exr'));
    for (let i = 0; i < decoded.rgb.length; i += RGB_COMPONENTS) {
      expect(decoded.rgb[i + 1]).toBe(decoded.rgb[i]);
      expect(decoded.rgb[i + 2]).toBe(decoded.rgb[i]);
    }
    expect(firstMismatch(decoded.rgb, golden('golden-gray-half.f32'))).toBe(-1);
  });
});

describe('OpenEXR FFmpeg cross-check', () => {
  // FFmpeg picks its own channel subset for UINT, layered, gray and extra-channel files, so those
  // are checked against the reference-library goldens only.
  const crossChecked = manifest.fixtures.filter((entry) => entry.sample !== 'uint' && !entry.channelNames);

  for (const entry of crossChecked) {
    oracleTest(
      `matches the FFmpeg exr decoder for ${entry.file}`,
      ['ffmpeg', 'ffprobe'],
      () => {
        // FFmpeg mishandles windows that do not start at the origin, so it decodes a copy moved there.
        const original = fixture(entry.file);
        const ours = decodeOpenExr(original);
        const theirs = decodeExrWithFfmpeg(withWindowMovedToOrigin(original, entry.layout === 'scanline'));
        expect([ours.width, ours.height]).toEqual([theirs.width, theirs.height]);
        expect(firstMismatch(ours.rgb, theirs.rgb)).toBe(-1);
      },
      FFMPEG_CROSS_CHECK_TIMEOUT_MS
    );
  }

  const FFMPEG_WIDTH = 41;
  const FFMPEG_HEIGHT = 37;
  const ffmpegCompressions = ['none', 'rle', 'zip1', 'zip16'] as const;

  /** Planar G,B,R float source with HDR range, authored here and fed to the FFmpeg encoder. */
  function planarSource(): { raw: Buffer; rgb: Float32Array } {
    const pixels = FFMPEG_WIDTH * FFMPEG_HEIGHT;
    const g = new Float32Array(pixels);
    const b = new Float32Array(pixels);
    const r = new Float32Array(pixels);
    for (let y = 0; y < FFMPEG_HEIGHT; y++) {
      for (let x = 0; x < FFMPEG_WIDTH; x++) {
        const i = y * FFMPEG_WIDTH + x;
        r[i] = (x * 7 + y * 3) / 13 - 1.5;
        g[i] = Math.fround(Math.sin(x / 5) * Math.cos(y / 7) * 3);
        b[i] = ((x * y) % 29) / 4 + 2 ** -9;
      }
    }
    const raw = Buffer.concat([g, b, r].map((plane) => Buffer.from(plane.buffer)));
    const rgb = new Float32Array(pixels * RGB_COMPONENTS);
    for (let i = 0; i < pixels; i++) {
      rgb[i * RGB_COMPONENTS] = r[i];
      rgb[i * RGB_COMPONENTS + 1] = g[i];
      rgb[i * RGB_COMPONENTS + 2] = b[i];
    }
    return { raw, rgb };
  }

  function makeExrWithFfmpeg(raw: Buffer, compression: string, format: 'half' | 'float'): Buffer {
    const ffmpeg = getOracleToolPath('ffmpeg');
    if (!ffmpeg) throw new Error('ffmpeg is not installed');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'exr-encode-'));
    try {
      const input = path.join(dir, 'source.gbrpf32le');
      const output = path.join(dir, 'out.exr');
      writeFileSync(input, raw);
      execFileSync(ffmpeg, [
        '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', `${FFMPEG_WIDTH}x${FFMPEG_HEIGHT}`,
        '-i', input, '-frames:v', '1', '-c:v', 'exr', '-compression', compression, '-format', format, output,
      ]);
      return readFileSync(output);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const compression of ffmpegCompressions) {
    for (const format of ['half', 'float'] as const) {
      oracleTest(
        `decodes an FFmpeg-written ${compression} ${format} image to the source samples`,
        ['ffmpeg', 'ffprobe'],
        () => {
          const { raw, rgb } = planarSource();
          const file = makeExrWithFfmpeg(raw, compression, format);
          const decoded = decodeOpenExr(file);
          expect([decoded.width, decoded.height]).toEqual([FFMPEG_WIDTH, FFMPEG_HEIGHT]);
          expect(decoded.isHalf).toBe(format === 'half');
          expect(firstMismatch(decoded.rgb, decodeExrWithFfmpeg(file).rgb)).toBe(-1);
          if (format === 'float') {
            expect(firstMismatch(decoded.rgb, rgb)).toBe(-1);
          } else {
            for (let i = 0; i < rgb.length; i++) {
              const quantised = halfBitsToFloat(floatToHalfBits(rgb[i]));
              const allowed = Math.abs(quantised) * HALF_RELATIVE_TOLERANCE + HALF_ABSOLUTE_TOLERANCE;
              expect(Math.abs(decoded.rgb[i] - rgb[i])).toBeLessThanOrEqual(allowed);
            }
          }
        },
        FFMPEG_CROSS_CHECK_TIMEOUT_MS
      );
    }
  }
});

describe('OpenEXR fail-closed behaviour', () => {
  it.each(manifest.reject.filter((entry) => ['dwaa', 'dwab', 'b44', 'b44a'].includes(entry.reason)))(
    'rejects $reason compression with a typed unsupported error',
    ({ file, reason }) => {
      expectDecodeError(() => decodeOpenExr(fixture(file)), 'unsupported', new RegExp(reason, 'i'));
    }
  );

  it('rejects luminance/chroma images', () => {
    expectDecodeError(() => decodeOpenExr(fixture('reject-luma-chroma.exr')), 'unsupported', /luminance\/chroma/);
  });

  it('rejects an image without colour channels instead of emitting black', () => {
    expectDecodeError(() => decodeOpenExr(fixture('reject-no-color.exr')), 'malformed', /no R,G,B or Y/);
  });

  const scanlineWindow = [0, 0, 7, 3] as const;
  const halfRgb = ['B', 'G', 'R'].map((name) => ({ name, pixelType: PIXEL_TYPE_HALF }));

  it('rejects an empty channel list instead of assuming half BGR', () => {
    const file = assembleExr({
      channels: [],
      compression: COMPRESSION_CODES.none,
      dataWindow: scanlineWindow,
      chunks: [0, 1, 2, 3].map((y) => scanlineChunk(y, Buffer.alloc(0))),
    });
    expectDecodeError(() => decodeOpenExr(file), 'malformed', /channel list is empty/);
  });

  it('rejects deep and multipart files by their version flags and type attribute', () => {
    const chunks = [0, 1, 2, 3].map((y) => scanlineChunk(y, Buffer.alloc(8 * 3 * 2)));
    const base = { channels: halfRgb, compression: COMPRESSION_CODES.none, dataWindow: scanlineWindow, chunks };
    expectDecodeError(() => decodeOpenExr(assembleExr({ ...base, flags: EXR_FLAG_NON_IMAGE })), 'unsupported', /deep/);
    expectDecodeError(() => decodeOpenExr(assembleExr({ ...base, flags: EXR_FLAG_MULTIPART })), 'unsupported', /multipart/);
    const deepType = { name: 'type', type: 'string', value: Buffer.from('deepscanline') };
    expectDecodeError(() => decodeOpenExr(assembleExr({ ...base, extraAttributes: [deepType] })), 'unsupported', /deep/);
  });

  it('rejects sub-sampled channels', () => {
    const channels = [...halfRgb, { name: 'Z', pixelType: PIXEL_TYPE_FLOAT, xSampling: 2, ySampling: 2 }];
    const file = assembleExr({
      channels,
      compression: COMPRESSION_CODES.none,
      dataWindow: scanlineWindow,
      chunks: [0, 1, 2, 3].map((y) => scanlineChunk(y, Buffer.alloc(8 * 3 * 2))),
    });
    expectDecodeError(() => decodeOpenExr(file), 'unsupported', /sub-sampled/);
  });

  it('rejects an incomplete RGB layer', () => {
    const file = assembleExr({
      channels: [{ name: 'G', pixelType: PIXEL_TYPE_HALF }, { name: 'R', pixelType: PIXEL_TYPE_HALF }],
      compression: COMPRESSION_CODES.none,
      dataWindow: scanlineWindow,
      chunks: [0, 1, 2, 3].map((y) => scanlineChunk(y, Buffer.alloc(8 * 2 * 2))),
    });
    expectDecodeError(() => decodeOpenExr(file), 'malformed', /not all of R, G and B/);
  });

  it('rejects an unknown compression code and unknown version flags', () => {
    const chunks = [0, 1, 2, 3].map((y) => scanlineChunk(y, Buffer.alloc(8 * 3 * 2)));
    expectDecodeError(() => decodeOpenExr(assembleExr({ channels: halfRgb, compression: 42, dataWindow: scanlineWindow, chunks })), 'malformed', /compression code 42/);
    expectDecodeError(
      () => decodeOpenExr(assembleExr({ channels: halfRgb, compression: 0, dataWindow: scanlineWindow, chunks, flags: 0x10000 })),
      'unsupported',
      /version flags/
    );
  });

  it('rejects a bad magic number and a short file', () => {
    const file = Buffer.from(fixture('scanline-none-half.exr'));
    file[0] = 0x00;
    expectDecodeError(() => decodeOpenExr(file), 'malformed', /magic header/);
    expectDecodeError(() => decodeOpenExr(Buffer.from([0x76, 0x2f, 0x31])), 'truncated');
  });

  it('rejects a window above the pixel cap before allocating output', () => {
    const file = assembleExr({
      channels: halfRgb,
      compression: COMPRESSION_CODES.none,
      dataWindow: [0, 0, OVERSIZED_WINDOW_MAX, OVERSIZED_WINDOW_MAX],
      chunks: [],
    });
    expect((OVERSIZED_WINDOW_MAX + 1) ** 2).toBeGreaterThan(MAX_OPENEXR_PIXELS);
    expectDecodeError(() => decodeOpenExr(file), 'too-large', /pixel limit/);
  });

  it('rejects a block whose uncompressed size exceeds the block cap', () => {
    const wideChannels = Array.from({ length: 64 }, (_, i) => ({ name: `c${String(i).padStart(2, '0')}`, pixelType: PIXEL_TYPE_FLOAT }));
    const file = assembleExr({
      channels: [...wideChannels, ...halfRgb],
      compression: COMPRESSION_CODES.none,
      dataWindow: [0, 0, MAX_OPENEXR_PIXELS - 1, 0],
      chunks: [],
    });
    expectDecodeError(() => decodeOpenExr(file), 'too-large', /block needs/);
  });

  it('bounds decompression: a zip bomb is rejected, not inflated', () => {
    const width = 1000;
    const channels = ['B', 'G', 'R'].map((name) => ({ name, pixelType: PIXEL_TYPE_FLOAT }));
    const expectedBytes = width * 3 * FLOAT_BYTES;
    const bomb = deflateSync(Buffer.alloc(BOMB_ZERO_BYTES));
    expect(bomb.length).toBeLessThan(expectedBytes);
    const file = assembleExr({
      channels,
      compression: COMPRESSION_CODES.zips,
      dataWindow: [0, 0, width - 1, 0],
      chunks: [scanlineChunk(0, bomb)],
    });
    expectDecodeError(() => decodeOpenExr(file), 'malformed', /not a valid zlib stream/);
  });

  it('rejects a short uncompressed chunk as truncated', () => {
    const file = assembleExr({
      channels: halfRgb,
      compression: COMPRESSION_CODES.none,
      dataWindow: [0, 0, 7, 0],
      chunks: [scanlineChunk(0, Buffer.alloc(8 * 3 * 2 - 1))],
    });
    expectDecodeError(() => decodeOpenExr(file), 'truncated', /uncompressed chunk holds/);
  });

  it('rejects a chunk larger than its uncompressed size', () => {
    const file = assembleExr({
      channels: halfRgb,
      compression: COMPRESSION_CODES.zip,
      dataWindow: [0, 0, 7, 0],
      chunks: [scanlineChunk(0, Buffer.alloc(8 * 3 * 2 + 1))],
    });
    expectDecodeError(() => decodeOpenExr(file), 'malformed', /exceeds its/);
  });

  it('rejects a negative chunk size', () => {
    const chunk = scanlineChunk(0, Buffer.alloc(8 * 3 * 2));
    chunk.writeInt32LE(-1, 4);
    const file = assembleExr({ channels: halfRgb, compression: COMPRESSION_CODES.none, dataWindow: [0, 0, 7, 0], chunks: [chunk] });
    expectDecodeError(() => decodeOpenExr(file), 'malformed', /negative data size/);
  });

  describe('truncated files', () => {
    const truncatable = [
      'scanline-none-half.exr',
      'scanline-rle-float.exr',
      'scanline-zips-half.exr',
      'scanline-zip-float.exr',
      'scanline-pxr24-half.exr',
      'scanline-piz-half.exr',
      'scanline-piz-mixed-channels.exr',
      'tiled-zip-half-one-level.exr',
    ];

    it.each(truncatable)('rejects %s cut inside its last chunk', (file) => {
      const full = fixture(file);
      expectDecodeError(() => decodeOpenExr(full.subarray(0, full.length - TRUNCATION_TAIL_BYTES)), 'truncated');
    });

    it.each(truncatable)('rejects %s cut inside the offset table', (file) => {
      const full = fixture(file);
      const cut = exrOffsetTableStart(full) + OFFSET_TABLE_ENTRY_BYTES + 3;
      expectDecodeError(() => decodeOpenExr(full.subarray(0, cut)), 'truncated', /offset table/);
    });

    it('rejects a mipmap file cut inside its last full-resolution tile', () => {
      const mipmap = fixture('tiled-piz-half-mipmap.exr');
      const tilesAtLevel0 = Math.ceil(manifest.width / 16) * Math.ceil(manifest.height / 16);
      const lastLevel0 = Math.max(...exrChunkOffsets(mipmap, tilesAtLevel0));
      expectDecodeError(() => decodeOpenExr(mipmap.subarray(0, lastLevel0 + TILE_HEADER_AND_FEW_BYTES)), 'truncated');
    });

    it('rejects a file cut inside its header', () => {
      expectDecodeError(() => decodeOpenExr(fixture('scanline-zip-half.exr').subarray(0, HEADER_CUT_BYTES)), 'truncated');
    });
  });

  describe('bad chunk offsets', () => {
    const scanline = fixture('scanline-zip-half.exr');
    const scanlineChunkCount = Math.ceil(manifest.height / 16);

    it('rejects an offset beyond the end of the file', () => {
      expectDecodeError(() => decodeOpenExr(withChunkOffset(scanline, 1, scanline.length + 100)), 'truncated', /beyond the end/);
    });

    it('rejects an offset that was never written (zero)', () => {
      expectDecodeError(() => decodeOpenExr(withChunkOffset(scanline, 0, 0)), 'malformed', /no offset/);
    });

    it('rejects an offset that points into the header', () => {
      expectDecodeError(() => decodeOpenExr(withChunkOffset(scanline, 0, 12)), 'malformed', /inside the header/);
    });

    it('rejects an offset that overflows the safe integer range', () => {
      expectDecodeError(() => decodeOpenExr(withChunkOffset(scanline, 2, 2n ** 63n)), 'malformed', /out of range/);
    });

    it('rejects two chunks pointing at the same data (wrong first line)', () => {
      const [first] = exrChunkOffsets(scanline, scanlineChunkCount);
      expectDecodeError(() => decodeOpenExr(withChunkOffset(scanline, 1, first)), 'malformed', /starts at line/);
    });

    it('rejects swapped chunk offsets', () => {
      const [first, second] = exrChunkOffsets(scanline, scanlineChunkCount);
      expectDecodeError(() => decodeOpenExr(withChunkOffset(withChunkOffset(scanline, 0, second), 1, first)), 'malformed', /starts at line/);
    });

    it('rejects swapped tile offsets', () => {
      const tiled = fixture('tiled-zip-half-one-level.exr');
      const [first, second] = exrChunkOffsets(tiled, 2);
      expectDecodeError(() => decodeOpenExr(withChunkOffset(withChunkOffset(tiled, 0, second), 1, first)), 'malformed', /tile chunk 0/);
    });

    it('rejects a tile chunk that belongs to another resolution level', () => {
      const mipmap = fixture('tiled-piz-half-mipmap.exr');
      const tilesAtLevel0 = Math.ceil(manifest.width / 16) * Math.ceil(manifest.height / 16);
      const offsets = exrChunkOffsets(mipmap, tilesAtLevel0 + 1);
      expectDecodeError(() => decodeOpenExr(withChunkOffset(mipmap, 0, offsets[tilesAtLevel0])), 'malformed', /level/);
    });

    it('rejects a chunk whose payload size runs past the end of the file', () => {
      const copy = Buffer.from(scanline);
      const [first] = exrChunkOffsets(copy, 1);
      copy.writeInt32LE(copy.length, first + 4);
      expectDecodeError(() => decodeOpenExr(copy), 'truncated', /declares/);
    });
  });

  describe('corrupt codec streams', () => {
    function corruptFirstChunk(file: string, mutate: (copy: Buffer, dataStart: number, dataSize: number) => void): Buffer {
      const copy = Buffer.from(fixture(file));
      const [first] = exrChunkOffsets(copy, 1);
      const dataSize = copy.readInt32LE(first + 4);
      mutate(copy, first + 8, dataSize);
      return copy;
    }

    it.each(['scanline-zip-half.exr', 'scanline-zips-half.exr', 'scanline-pxr24-half.exr'])('rejects a damaged zlib stream in %s', (file) => {
      const damaged = corruptFirstChunk(file, (copy, start, size) => {
        copy[start + Math.floor(size / 2)] ^= 0xff;
        copy[start + size - 1] ^= 0xff;
      });
      expectDecodeError(() => decodeOpenExr(damaged), 'malformed', /zlib/);
    });

    it.each([
      ['more data than the block holds', [0x7f, 0x00], /more data than expected/],
      ['fewer bytes than the block holds', [0x01, 0x00], /decodes to 2 bytes/],
    ])('rejects an RLE stream that decodes to %s', (_label, stream, message) => {
      const file = assembleExr({
        channels: halfRgb,
        compression: COMPRESSION_CODES.rle,
        dataWindow: [0, 0, 7, 0],
        chunks: [scanlineChunk(0, Buffer.from(stream))],
      });
      expectDecodeError(() => decodeOpenExr(file), 'malformed', message);
    });

    it('rejects an RLE literal run that is cut off', () => {
      const file = assembleExr({
        channels: halfRgb,
        compression: COMPRESSION_CODES.rle,
        dataWindow: [0, 0, 7, 0],
        chunks: [scanlineChunk(0, Buffer.from([0xf0, 1, 2]))],
      });
      expectDecodeError(() => decodeOpenExr(file), 'truncated', /literal run/);
    });

    it('rejects a PIZ block whose bitmap range is out of bounds', () => {
      const damaged = corruptFirstChunk('scanline-piz-half.exr', (copy, start) => {
        copy.writeUInt16LE(0xffff, start + 2);
      });
      expectDecodeError(() => decodeOpenExr(damaged), 'malformed', /bitmap range/);
    });

    it('rejects a PIZ block whose Huffman stream length overruns the chunk', () => {
      const damaged = corruptFirstChunk('scanline-piz-half.exr', (copy, start) => {
        const minNonZero = copy.readUInt16LE(start);
        const maxNonZero = copy.readUInt16LE(start + 2);
        const lengthField = start + 4 + (minNonZero <= maxNonZero ? maxNonZero - minNonZero + 1 : 0);
        copy.writeInt32LE(0x7fffff00, lengthField);
      });
      expectDecodeError(() => decodeOpenExr(damaged), 'truncated', /Huffman stream is cut off/);
    });

    it('rejects a PIZ Huffman stream that declares more bits than it holds', () => {
      const damaged = corruptFirstChunk('scanline-piz-half.exr', (copy, start) => {
        const minNonZero = copy.readUInt16LE(start);
        const maxNonZero = copy.readUInt16LE(start + 2);
        const huffmanStart = start + 4 + (minNonZero <= maxNonZero ? maxNonZero - minNonZero + 1 : 0) + 4;
        copy.writeUInt32LE(0x7fffffff, huffmanStart + 12);
      });
      expectDecodeError(() => decodeOpenExr(damaged), 'truncated', /bit stream/);
    });

    it('rejects a PXR24 block that inflates to the wrong size', () => {
      const bomb = deflateSync(Buffer.alloc(10));
      const file = assembleExr({
        channels: halfRgb,
        compression: COMPRESSION_CODES.pxr24,
        dataWindow: [0, 0, 63, 0],
        chunks: [scanlineChunk(0, bomb)],
      });
      expectDecodeError(() => decodeOpenExr(file), 'malformed', /PXR24/);
    });

    it('rejects a tile chunk with a non-zero level in a one-level image', () => {
      const tiled = fixture('tiled-zip-half-one-level.exr');
      const copy = Buffer.from(tiled);
      const [first] = exrChunkOffsets(copy, 1);
      copy.writeInt32LE(1, first + 8);
      expectDecodeError(() => decodeOpenExr(copy), 'malformed', /level \(1,0\)/);
    });
  });

  it('builds a tiled container the decoder can address by tile (assembler self-check)', () => {
    // A 2x1 tile image with raw (NONE) tiles of 1x1 half pixels: pins tile ordering and edge clipping.
    const tiles = new Uint8Array([1, 0, 2, 0, 3, 0].map((value) => value));
    const pixel = (r: number, g: number, b: number) => {
      const buf = Buffer.alloc(6);
      // Channel order on disk is B, G, R.
      buf.writeUInt16LE(b, 0);
      buf.writeUInt16LE(g, 2);
      buf.writeUInt16LE(r, 4);
      return buf;
    };
    expect(tiles.length).toBe(6);
    const tileDesc = Buffer.alloc(9);
    tileDesc.writeUInt32LE(1, 0);
    tileDesc.writeUInt32LE(1, 4);
    tileDesc[8] = 0;
    const file = assembleExr({
      channels: halfRgb,
      compression: COMPRESSION_CODES.none,
      dataWindow: [3, 5, 4, 5],
      flags: EXR_FLAG_TILED,
      extraAttributes: [{ name: 'tiles', type: 'tiledesc', value: tileDesc }],
      chunks: [tileChunk(0, 0, 0, 0, pixel(0x3c00, 0x4000, 0x4200)), tileChunk(1, 0, 0, 0, pixel(0x4400, 0x4500, 0x4600))],
    });
    const decoded = decodeOpenExr(file);
    expect([decoded.width, decoded.height]).toEqual([2, 1]);
    expect(Array.from(decoded.rgb)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
