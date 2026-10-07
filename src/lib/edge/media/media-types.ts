/**
 * Shapes shared by the edge container demuxers and the WebCodecs worker.
 */

export interface DemuxedMediaSample {
  data: Uint8Array;
  /** Presentation timestamp in microseconds (composition time, edit list applied). Samples are in decode order. */
  timestampMicros: number;
  durationMicros?: number;
  isKeyFrame: boolean;
  type: 'video' | 'audio';
}

export interface DemuxedTrackInfo {
  type: 'video' | 'audio';
  /** WebCodecs codec string (RFC 6381 style) for compressed tracks, or a `pcm-*` label for PCM audio. */
  codec: string;
  timescale: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  /** Decoder configuration record as WebCodecs takes it: avcC, hvcC or AudioSpecificConfig bytes. */
  description?: Uint8Array;
  samples: DemuxedMediaSample[];
  audioTrack?: DemuxedTrackInfo;
}
