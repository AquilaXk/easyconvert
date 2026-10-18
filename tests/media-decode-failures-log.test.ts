import { describe, expect, it } from 'vitest';
import { explainFfmpegFailure, partialDecodeIn, undecodableStreamIn, unsupportedCodecIn } from '../src/lib/conversions/media-decode-failures';
import { UnprocessableMediaInputError, UnsupportedMediaCodecError } from '../src/lib/types';

/*
 * The lines below follow the format strings of FFmpeg's own sources: `Error submitting packet to decoder: %s` and
 * `Decode error rate %g exceeds maximum %g` in fftools/ffmpeg_dec.c, `Audio object type %d is not implemented` in
 * libavcodec/aacdec, each behind the `[name @ 0x...]` prefix of av_log.
 */
const BANNER = 'ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2025 the FFmpeg developers\n';
const NOT_YET_IMPLEMENTED = '[dec:aac @ 0x5581c1e3a2c0] Error submitting packet to decoder: Not yet implemented in FFmpeg, patch welcome\n';
const ERROR_RATE = '[aist#0:1/aac @ 0x55f0c4e8b440] [dec:aac @ 0x55f0c4e8c100] Decode error rate 1 exceeds maximum 0.666667\n';
const OBJECT_TYPE = '[aac @ 0x55d0a1b2c3d4] Audio object type 42 is not implemented. Update your FFmpeg version to the newest one from Git.\n';

/** A metadata tag as the default log level echoes it, holding `count` copies of a pattern start and no closing bracket. */
function hostileTag(start: string, count: number): string {
  return `${BANNER}Input #0, matroska,webm, from 'input.mka':\n  Metadata:\n    COMMENT         : ${start.repeat(count)}\n`;
}

describe('FFmpeg log classification', () => {
  it('names the decoder and the build for a decoder that lacks a coding tool', () => {
    const refusal = partialDecodeIn(`${BANNER}${NOT_YET_IMPLEMENTED}`);
    expect(refusal).toBeInstanceOf(UnsupportedMediaCodecError);
    expect(refusal?.codec).toBe('aac');
    expect(refusal?.message).toContain('FFmpeg 7.1.5-0+deb13u1 cannot decode this stream completely');
  });

  it('names the kind, index and codec of a stream whose packets are nearly all invalid', () => {
    const refusal = undecodableStreamIn(ERROR_RATE);
    expect(refusal).toBeInstanceOf(UnprocessableMediaInputError);
    expect(refusal?.message).toBe(
      'The audio stream #1 (aac) cannot be decoded: nearly every packet of it is invalid, so the data is damaged or is not aac.'
    );
  });

  it('names xHE-AAC for audio object type 42 and prefers it over the other classifications', () => {
    const refusal = explainFfmpegFailure(`${OBJECT_TYPE}${ERROR_RATE}`);
    expect(refusal).toBeInstanceOf(UnsupportedMediaCodecError);
    expect((refusal as UnsupportedMediaCodecError).codec).toBe('xHE-AAC (USAC)');
  });

  it('finds nothing in a clean log or in a pattern split across lines', () => {
    expect(explainFfmpegFailure(`${BANNER}size=     128KiB time=00:00:01.00\n`)).toBeUndefined();
    expect(partialDecodeIn('[dec:aac @ 0x1\n] Error submitting packet to decoder: Not yet implemented in FFmpeg\n')).toBeUndefined();
    expect(undecodableStreamIn('[aist#0:1/aac @ 0x1\n] Decode error rate 1 exceeds maximum 0.666667\n')).toBeUndefined();
  });

  it.each([
    ['[dec:a', partialDecodeIn],
    ['[aist#0:1/aac @', undecodableStreamIn],
    ['[aist#0:1/aac @ 0x1] [dec:', undecodableStreamIn],
    ['Audio object type 1', unsupportedCodecIn],
  ])('reads a megabyte tag of repeated %j in linear time', (start, classify) => {
    const log = hostileTag(start, Math.ceil((1024 * 1024) / start.length));
    // An unbounded `[^\]]*` rescans to the end of the log from every start: about a minute for this log, quadratic in its
    // length. Bounded, one pass takes milliseconds, so the 2 s bound leaves a wide margin for a loaded runner either way.
    const started = performance.now();
    expect(classify(log)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
