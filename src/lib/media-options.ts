/**
 * The options of a media conversion that `ConversionOptions` (src/lib/types.ts) names: video and audio encoding, trimming,
 * loudness, subtitles, thumbnails and adaptive streaming packages.
 */

export interface AspectRatioOptions {
  /** "W:H", whole numbers, e.g. "4:3". */
  ratio: string;
  /** `dar` sets the display ratio only (default), `pad` adds bars, `crop` removes picture. */
  mode?: 'dar' | 'pad' | 'crop';
}

export interface VideoRateControlCrf {
  mode: 'crf';
  crf: number;
  /**
   * Caps the peak bitrate of the constant-quality encode (capped CRF): `-maxrate` with a `-bufsize` of twice
   * that. Left unset, quality alone decides the rate and no bitrate is invented.
   */
  maxBitrateK?: number;
}

export interface VideoRateControlVbr {
  mode: 'vbr';
  bitrateK: number;
  maxrateK?: number;
  bufsizeK?: number;
  /** Run the encode in two passes (h264, hevc, vp9): the second reaches the target bitrate more exactly. */
  twoPass?: boolean;
}

export interface VideoRateControlCbr {
  mode: 'cbr';
  bitrateK: number;
}

export type VideoRateControl = VideoRateControlCrf | VideoRateControlVbr | VideoRateControlCbr;

export interface VideoCropOptions {
  w: number;
  h: number;
  x: number;
  y: number;
}

export interface VideoScaleOptions {
  width?: number;
  height?: number;
  fit?: 'contain' | 'cover' | 'stretch';
}

export interface VideoEncodingOptions {
  codec?: 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores';
  profile?: string;
  level?: string;
  rateControl?: VideoRateControl;
  preset?: string;
  fps?: number;
  crop?: VideoCropOptions;
  rotate?: 0 | 90 | 180 | 270;
  deinterlace?: boolean;
  scale?: VideoScaleOptions;
}

export interface MediaTrimOptions {
  start?: string;
  end?: string;
}

export type AudioCodec = 'aac' | 'mp3' | 'opus' | 'flac' | 'vorbis' | 'pcm_s16le';

/** Named EBU R128 / ITU-R BS.1770-4 loudness targets. */
export type LoudnessPreset = 'ebu-r128' | 'streaming' | 'podcast';

export interface LoudnessOptions {
  /** Starting values: `ebu-r128` (-23 LUFS, the default), `streaming` (-14 LUFS) or `podcast` (-16 LUFS). */
  preset?: LoudnessPreset;
  /** Integrated loudness target in LUFS (-70 to -5). */
  integrated?: number;
  /** Maximum true peak in dBTP (-9 to 0). */
  truePeak?: number;
  /** Loudness range target in LU (1 to 50). */
  lra?: number;
}

export type AudioResampler = 'soxr' | 'swr';
export type AudioDither = 'none' | 'rectangular' | 'triangular' | 'triangular_hp';

export interface AudioEncodingOptions {
  codec?: AudioCodec;
  /** Opt-in two-pass loudness normalisation (a measuring pass, then a linear gain). */
  loudness?: LoudnessOptions;
  /** Resampler for rate changes: soxr when the ffmpeg build has it (the default), otherwise swr. */
  resampler?: AudioResampler;
  /** Dither for the reduction to 16-bit PCM; defaults to triangular_hp. */
  dither?: AudioDither;
  bitrateK?: number;
  channels?: 1 | 2 | 6 | 8;
  sampleRate?: number;
  volume?: number;
  downmix?: 'itu-r-bs775';
  track?: number | 'all';
}

export type SubtitleMode = 'burn' | 'soft' | 'extract';
export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

export interface SubtitleOptions {
  mode: SubtitleMode;
  input?: string;
  streamIndex?: number;
  format?: SubtitleFormat;
}

export interface ThumbnailOptions {
  at?: string[];
  format?: 'jpg' | 'png';
  width?: number;
  accurate?: boolean;
}

export interface MediaLadderRung {
  height: number;
  bitrateK: number;
  fps?: number;
  audioBitrateK?: number;
}

export type MediaPackagingFormat = 'hls' | 'dash';

/** HLS segment container: MPEG-2 transport stream, or fragmented MP4 (CMAF). MPEG-DASH always uses fmp4. */
export type MediaPackagingSegmentType = 'ts' | 'fmp4';

export interface MediaPackagingOptions {
  format: MediaPackagingFormat;
  segmentSeconds?: number;
  segmentType?: MediaPackagingSegmentType;
  ladder?: MediaLadderRung[];
  masterPlaylistName?: string;
  audioCodec?: 'aac' | 'opus';
  videoCodec?: 'h264' | 'hevc' | 'vp9' | 'av1';
}
