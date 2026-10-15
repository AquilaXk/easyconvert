/**
 * Removes the part of decoded audio that lies before presentation time zero.
 *
 * An MP4 edit list hides the encoder delay (AAC priming) by starting the media after zero, so the demuxer gives
 * the first packets negative timestamps and the decoder returns audio before time zero. That audio is not part
 * of the programme; re-encoding it would shift the audio late against the video by the length of the delay.
 */

const MICROS_PER_SECOND = 1_000_000;

/** The slice of the WebCodecs `AudioData` interface this module uses. */
export interface TrimmableAudioData {
  readonly format: string | null;
  readonly sampleRate: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly timestamp: number;
  copyTo(
    destination: Float32Array,
    options: { planeIndex: number; frameOffset: number; frameCount: number; format: 'f32-planar' }
  ): void;
  close(): void;
}

export interface PlanarAudioDataInit {
  format: 'f32-planar';
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: Float32Array;
}

/**
 * Returns `data` unchanged when it starts at or after zero, `null` (after closing it) when it ends before
 * zero, and otherwise a new planar float `AudioData` holding the frames from zero on (after closing `data`).
 * When the cut itself throws, `data` is closed before the error is passed on.
 * Whole frames are cut: the count is the time before zero rounded to the nearest frame.
 */
export function trimAudioDataStart<T extends TrimmableAudioData>(
  data: T,
  AudioDataClass: new (init: PlanarAudioDataInit) => T
): T | null {
  const framesBeforeZero = Math.round((-data.timestamp * data.sampleRate) / MICROS_PER_SECOND);
  if (data.timestamp >= 0 || framesBeforeZero <= 0) return data;
  if (framesBeforeZero >= data.numberOfFrames) {
    data.close();
    return null;
  }

  const kept = data.numberOfFrames - framesBeforeZero;
  let trimmed: T;
  try {
    const planar = new Float32Array(kept * data.numberOfChannels);
    for (let channel = 0; channel < data.numberOfChannels; channel++) {
      data.copyTo(planar.subarray(channel * kept, (channel + 1) * kept), {
        planeIndex: channel,
        frameOffset: framesBeforeZero,
        frameCount: kept,
        format: 'f32-planar',
      });
    }
    trimmed = new AudioDataClass({
      format: 'f32-planar',
      sampleRate: data.sampleRate,
      numberOfFrames: kept,
      numberOfChannels: data.numberOfChannels,
      timestamp: Math.max(0, Math.round(data.timestamp + (framesBeforeZero * MICROS_PER_SECOND) / data.sampleRate)),
      data: planar,
    });
  } catch (error) {
    // The caller never receives `data` back, so a failed cut must not leave it holding platform memory
    data.close();
    throw error;
  }
  data.close();
  return trimmed;
}
