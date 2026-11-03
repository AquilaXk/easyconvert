import { describe, expect, it } from 'vitest';
import { AudioResampleError, AudioResampleFaultError, resampleInterleavedInt16 } from '../src/lib/conversions/audio-resampler';
import { AvifEncoderFailedError } from '../src/lib/conversions/avif-cli';
import { LoudnessMeasurementError, LoudnessReportMissingError, parseLoudnormMeasurement } from '../src/lib/conversions/media-audio-quality';
import { measureInk } from '../src/lib/conversions/ocr-bands';
import { sauvolaBinarize, SAUVOLA_MAX_PIXELS } from '../src/lib/conversions/ocr-sauvola';
import { OcrPreprocessError, OcrPreprocessFaultError, typedFailureOf } from '../src/lib/types';

/**
 * A class that names a fault of the server's own code or tools declares 500, so that both convert routes answer it with the
 * fixed sentence of a fault and log it as a failure, and the queue records 500. The throw sites that judge the request keep
 * the 400 of their class: a sample rate or a picture over a limit is the caller's.
 */

const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const SAMPLE_RATE_44K = 44_100;
const SAMPLE_RATE_48K = 48_000;
const FRAMES = 5000;

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('The call did not throw.');
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('The call did not reject.');
}

describe('a failure of the resampler', () => {
  it('is a fault of the server when a kernel or an invariant of the resampler fails', () => {
    const error = caught(() => resampleInterleavedInt16(new Int16Array(FRAMES * 3), SAMPLE_RATE_44K, SAMPLE_RATE_48K, 3, { kernel: 'simd' }));

    expect(error).toBeInstanceOf(AudioResampleFaultError);
    expect(error).toBeInstanceOf(AudioResampleError);
    expect(typedFailureOf(error)).toEqual({ status: HTTP_INTERNAL_SERVER_ERROR, code: 'conversion_failed' });
  });

  it('is a refusal when the sample rate the request leads to is out of range', () => {
    const error = caught(() => resampleInterleavedInt16(new Int16Array(FRAMES), 1, SAMPLE_RATE_48K, 1));

    expect(error).toBeInstanceOf(AudioResampleError);
    expect(error).not.toBeInstanceOf(AudioResampleFaultError);
    expect(typedFailureOf(error)).toEqual({ status: HTTP_BAD_REQUEST, code: 'conversion_failed' });
  });
});

describe('a failure of the page preparation for OCR', () => {
  it('is a fault of the server when the buffers disagree with the size', async () => {
    const error = caught(() => measureInk(new Uint8Array(5), 3, 2));

    expect(error).toBeInstanceOf(OcrPreprocessFaultError);
    expect(error).toBeInstanceOf(OcrPreprocessError);
    expect(typedFailureOf(error)?.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(typedFailureOf(await rejection(() => sauvolaBinarize(new Uint8Array(10), 4, 4, { windowSize: 5 })))?.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
  });

  it('is a refusal when the picture is over the pixel limit', async () => {
    const side = Math.ceil(Math.sqrt(SAUVOLA_MAX_PIXELS)) + 1;

    const error = await rejection(() => sauvolaBinarize(new Uint8Array(4), side, side, { windowSize: 5 }));

    expect(error).toBeInstanceOf(OcrPreprocessError);
    expect(error).not.toBeInstanceOf(OcrPreprocessFaultError);
    expect(typedFailureOf(error)?.status).toBe(HTTP_BAD_REQUEST);
  });
});

describe('a tool that ran and printed nothing usable', () => {
  it.each(['no report here', '{ "input_i" : "x", broken }'])('is a fault of the server when the loudness pass prints a report that cannot be read (%s)', (stderr) => {
    const error = caught(() => parseLoudnormMeasurement(stderr, SAMPLE_RATE_48K));

    expect(error).toBeInstanceOf(LoudnessReportMissingError);
    expect(error).toBeInstanceOf(LoudnessMeasurementError);
    expect(typedFailureOf(error)?.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
  });

  it('is a refusal when the report says the input is silent', () => {
    const silent = '{ "input_i" : "-inf", "input_tp" : "-inf", "input_lra" : "0.00", "input_thresh" : "-70.00", "target_offset" : "inf" }';

    const error = caught(() => parseLoudnormMeasurement(silent, SAMPLE_RATE_48K));

    expect(error).toBeInstanceOf(LoudnessMeasurementError);
    expect(error).not.toBeInstanceOf(LoudnessReportMissingError);
    expect(typedFailureOf(error)?.status).toBe(HTTP_BAD_REQUEST);
  });

  it('is a fault of the server when the AVIF encoder exits with a failure', () => {
    expect(typedFailureOf(new AvifEncoderFailedError('the AVIF encoder failed on the picture'))?.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
  });
});
