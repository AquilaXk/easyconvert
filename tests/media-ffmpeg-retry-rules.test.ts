import { describe, expect, it } from 'vitest';
import { firstAdjustment } from '../src/lib/conversions/media-ffmpeg-run';

/**
 * The encoder restarts of runFfmpegTranscode apply once: when the arguments already carry a rule's change, the same failure
 * is passed on instead of starting FFmpeg again, so one job cannot run it up to the restart limit for one cause.
 */

const FLAC_LOG = '[flac @ 0x5591] invalid block size: 1\n';
const OPUS_LOG =
  'Stream #0:1 -> #0:0 (ac3 (native) -> opus (libopus))\n' +
  '[libopus @ 0x5591] Invalid channel layout 5.1(side) for specified mapping family -1.\n' +
  '[aost#0:0/libopus @ 0x5591] Error while opening encoder\n';

describe('the restarts of an encoder that refuses to start', () => {
  it('sets the FLAC frame size once, and passes the same failure on after that', () => {
    const first = firstAdjustment(['-i', 'in.wav', '-c:a', 'flac', 'out.flac'], FLAC_LOG);
    expect(first).toEqual(['-i', 'in.wav', '-c:a', 'flac', '-frame_size:a', '4096', 'out.flac']);
    expect(firstAdjustment(first as string[], FLAC_LOG)).toBeUndefined();
  });

  it('relabels the side-surround Opus stream once, and passes the same failure on after that', () => {
    const first = firstAdjustment(['-i', 'in.mts', '-c:a', 'libopus', 'out.webm'], OPUS_LOG);
    expect(first).toEqual(['-i', 'in.mts', '-c:a', 'libopus', '-filter:a:0', 'channelmap=channel_layout=5.1', 'out.webm']);
    expect(firstAdjustment(first as string[], OPUS_LOG)).toBeUndefined();
  });
});
