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

/** One chunk a WebCodecs encoder produced, in the units the muxers take. */
export interface EncodedMediaChunk {
  data: Uint8Array;
  timestampMicros: number;
  durationMicros?: number;
  isKeyFrame: boolean;
}

/**
 * What the encoder reported about its own output in `EncodedVideoChunkMetadata.decoderConfig` (or the audio
 * equivalent): the codec string and the decoder configuration record (avcC, hvcC, AudioSpecificConfig, ...)
 * that a container has to carry for the chunks to be decodable.
 */
export interface EncoderOutputConfig {
  codec: string;
  description?: Uint8Array;
  codedWidth?: number;
  codedHeight?: number;
  sampleRate?: number;
  numberOfChannels?: number;
}
