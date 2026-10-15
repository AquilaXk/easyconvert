import { describe, expect, it } from 'vitest';
import { decodeOpenExr } from '../src/lib/conversions/raw-hdr';
import { OpenExrDecodeError, type OpenExrErrorKind } from '../src/lib/conversions/openexr-decode';
import { ConversionFailedError } from '../src/lib/types';
import { buildUniformLongCodePizPayload } from './helpers/exr-piz-tools';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS, settle } from './helpers/timing';
import { assembleExr, COMPRESSION_CODES, PIXEL_TYPE_HALF, scanlineChunk } from './helpers/exr-assemble';

/**
 * Timing-ratio checks moved out of openexr-decode.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in openexr-decode.test.ts.
 */

const RGB_COMPONENTS = 3;
const HALF_BYTES = 2;
const LONG_CODE_WIDTH = 100_000;
const LONG_CODE_BITS = 30;
const NUL_RUN_LENGTH = 2_000_000;

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

describe('OpenEXR fail-closed behaviour', () => {
  const halfRgb = ['B', 'G', 'R'].map((name) => ({ name, pixelType: PIXEL_TYPE_HALF }));

  describe('image type attribute with long NUL runs', () => {
    const typeFile = (typeValue: string): Buffer =>
      assembleExr({
        channels: halfRgb,
        compression: COMPRESSION_CODES.none,
        dataWindow: [0, 0, 0, 0],
        extraAttributes: [{ name: 'type', type: 'string', value: Buffer.from(typeValue, 'latin1') }],
        chunks: [scanlineChunk(0, Buffer.alloc(RGB_COMPONENTS * HALF_BYTES))],
      });

    it('still recognises a deep type padded with a long NUL run', async () => {
      const { largeResult } = await expectLinearOnInputs(
        'deep type with NUL padding',
        (file: Buffer) => settle(() => decodeOpenExr(file)),
        {
          small: typeFile(`deepscanline${'\0'.repeat(NUL_RUN_LENGTH)}`),
          large: typeFile(`deepscanline${'\0'.repeat(NUL_RUN_LENGTH * SCALING_FACTOR)}`),
        }
      );
      if (largeResult.ok) throw new Error('the deep image was decoded instead of refused');
      expectDecodeError(() => {
        throw largeResult.error;
      }, 'unsupported', /deep/);
    }, SCALING_TEST_TIMEOUT_MS);
  });

  it('decodes a block of 65537 long Huffman codes in linear time, not by scanning every symbol per code', async () => {
    // All 65537 symbols share one 30-bit length, so canonical codes equal the symbol numbers and the
    // stream (symbol 65535 plus repeat markers) hits the last entry of the only long-code bucket.
    // Scanning every symbol per code would make 4x the codes cost 16x (tests/helpers/timing.ts).
    const longCodeFile = (width: number) => {
      const wordCount = width * RGB_COMPONENTS;
      const payload = buildUniformLongCodePizPayload(wordCount, LONG_CODE_BITS);
      expect(payload.length).toBeLessThan(wordCount * HALF_BYTES);
      return assembleExr({
        channels: halfRgb,
        compression: COMPRESSION_CODES.piz,
        dataWindow: [0, 0, width - 1, 0],
        chunks: [scanlineChunk(0, payload)],
      });
    };
    const { largeResult: decoded } = await expectLinearOnInputs('long Huffman codes', (file: Buffer) => decodeOpenExr(file), {
      small: longCodeFile(LONG_CODE_WIDTH / SCALING_FACTOR),
      large: longCodeFile(LONG_CODE_WIDTH),
    });
    // The block has an empty value bitmap, so every decoded word maps to the implicit zero value.
    expect(decoded.width).toBe(LONG_CODE_WIDTH);
    expect(decoded.rgb).toHaveLength(LONG_CODE_WIDTH * RGB_COMPONENTS);
    expect(decoded.rgb.every((sample) => sample === 0)).toBe(true);
  }, SCALING_TEST_TIMEOUT_MS);
});
