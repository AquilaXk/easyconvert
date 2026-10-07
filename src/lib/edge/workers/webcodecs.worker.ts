/**
 * WebCodecs Hardware Media Transcoding Worker (Level 1 - L1)
 *
 * Implements GPU/VPU hardware-accelerated video/audio transcoding:
 * 1. Demuxer -> Decoder -> OffscreenCanvas -> Encoder -> Muxer 4-step pipeline.
 * 2. Deterministic VRAM / AudioData cleanup: try ... finally { frame.close(); }.
 * 3. Dual watermark backpressure flow control:
 *    - Pause demuxer when encodeQueueSize >= 6 (high watermark)
 *    - Resume demuxer when encodeQueueSize <= 2 (low watermark)
 * 4. ISO timescale to microsecond normalization:
 *    t_micros = Math.round((PTS * 1,000,000) / timescale).
 * 5. Hardware-specific separation: VideoEncoder/VideoDecoder for video,
 *    AudioEncoder/AudioDecoder for audio (never misconfiguring VideoEncoder with audio codecs).
 * 6. Zero-copy IPC using Transferable Objects (postMessage([buffer])).
 */

import { trimAudioDataStart } from '../media/audio-trim';
import { levelCodecStrings, levelFamilyLabel, type LevelFamily } from '../media/codec-levels';
import { muxAdtsStream } from '../media/aac';
import { demuxMp4 } from '../media/iso-bmff-demux';
import type {
  DemuxedMediaSample,
  DemuxedTrackInfo,
  EncodedMediaChunk,
  EncoderOutputConfig,
  VideoColour,
} from '../media/media-types';
import { muxMp4 } from '../media/mp4-mux';
import { muxOggOpus } from '../media/ogg-opus-mux';
import { OrderedWorkQueue } from '../media/ordered-work-queue';
import { pcmBlockToAudioData } from '../media/pcm-audio';
import { survivesCanvasRedraw, toWebCodecsColorSpace } from '../media/video-colour';
import { muxWebm } from '../media/webm-mux';
import { demuxWav } from '../media/wav-demux';
import { EdgeUnsupportedError, serializeWorkerError, type SerializedWorkerError } from './worker-errors';

/** Target bitrates used when the request does not name one; they are an encoder choice, not stream metadata. */
const DEFAULT_VIDEO_BITRATE_BPS = 2_000_000;
const DEFAULT_AUDIO_BITRATE_BPS = 128_000;
/** Distance between forced key frames in the re-encoded video, in frames. */
const OUTPUT_KEYFRAME_INTERVAL_FRAMES = 15;
const MICROS_PER_SECOND = 1_000_000;

/** Progress milestones, in percent: input read, encoding finished, container written. */
const PROGRESS_INPUT_READ = 25;
const PROGRESS_VIDEO_ENCODED_WITH_AUDIO = 70;
const PROGRESS_ENCODED = 85;
const PROGRESS_MUXING = 90;
const PROGRESS_DONE = 100;

export interface WebCodecsConversionRequest {
  jobId: string;
  sourceFormat: string;
  targetFormat: string;
  fileBuffer: ArrayBuffer;
  options?: {
    width?: number;
    height?: number;
    framerate?: number;
    videoBitrate?: number;
    audioBitrate?: number;
    audioSampleRate?: number;
    audioChannels?: number;
    codec?: string;
  };
}

export interface WebCodecsWorkerProgress {
  type: 'PROGRESS';
  jobId: string;
  progress: number;
}

export interface WebCodecsWorkerCompleted {
  type: 'COMPLETED';
  jobId: string;
  buffer: ArrayBuffer;
  mimeType: string;
}

export interface WebCodecsWorkerError {
  type: 'ERROR';
  jobId: string;
  message: string;
  /** The typed error as plain data, so the main thread can rebuild its class. */
  error?: SerializedWorkerError;
}

export type WebCodecsWorkerMessage =
  | WebCodecsWorkerProgress
  | WebCodecsWorkerCompleted
  | WebCodecsWorkerError;

export type { DemuxedMediaSample, DemuxedTrackInfo } from '../media/media-types';

/**
 * Normalizes an arbitrary container/stream PTS with a given timescale to microseconds.
 * WebCodecs VideoFrame and AudioData require timestamps in integer microseconds.
 */
export function normalizeTimestampToMicros(pts: number, timescale: number): number {
  if (timescale <= 0) {
    throw new Error(`Invalid timescale ${timescale}: timescale must be positive.`);
  }
  return Math.round((pts * 1_000_000) / timescale);
}

/**
 * Denormalizes microseconds back to container timescale.
 */
export function denormalizeTimestampFromMicros(micros: number, timescale: number): number {
  if (timescale <= 0) {
    throw new Error(`Invalid timescale ${timescale}: timescale must be positive.`);
  }
  return Math.round((micros * timescale) / 1_000_000);
}

/**
 * Flow controller enforcing dual watermark backpressure between Demuxer and Hardware Encoder.
 */
export class WatermarkFlowController {
  private readonly highWatermark: number;
  private readonly lowWatermark: number;
  private isPaused: boolean = false;
  private resumeResolve: (() => void) | null = null;
  private currentQueueSize: number = 0;

  constructor(highWatermark: number = 6, lowWatermark: number = 2) {
    if (lowWatermark >= highWatermark) {
      throw new Error('lowWatermark must be strictly less than highWatermark');
    }
    this.highWatermark = highWatermark;
    this.lowWatermark = lowWatermark;
  }

  public get queueSize(): number {
    return this.currentQueueSize;
  }

  public get paused(): boolean {
    return this.isPaused;
  }

  /**
   * Updates queue size from encoder and pauses if high watermark is reached.
   */
  public async checkBackpressure(queueSize: number): Promise<void> {
    this.currentQueueSize = queueSize;
    if (this.currentQueueSize >= this.highWatermark) {
      this.isPaused = true;
      return new Promise<void>((resolve) => {
        this.resumeResolve = resolve;
      });
    }
  }

  /**
   * Called on encoder `dequeue` event or after each encoded chunk is consumed.
   */
  public onDequeue(currentQueueSize: number): void {
    this.currentQueueSize = currentQueueSize;
    if (this.isPaused && this.currentQueueSize <= this.lowWatermark) {
      this.isPaused = false;
      if (this.resumeResolve) {
        const resolve = this.resumeResolve;
        this.resumeResolve = null;
        resolve();
      }
    }
  }

  public reset(): void {
    this.isPaused = false;
    if (this.resumeResolve) {
      this.resumeResolve();
      this.resumeResolve = null;
    }
    this.currentQueueSize = 0;
  }
}

/**
 * Encoder codec strings of the targets that name no codec, and of the `videoCodec` option names. They are
 * encoder choices, checked against the platform. The H.264, HEVC and VP9 ones stand for a codec family: the
 * level (and for VP9 the profile and colour) is derived from the video, so the string here only names the family.
 */
const MP4_TARGET_VIDEO_CODEC = 'avc1.4d002a';
const HEVC_TARGET_VIDEO_CODEC = 'hvc1.1.6.L93.B0';
const WEBM_TARGET_VIDEO_CODEC = 'vp09.00.10.08';
const AV1_TARGET_VIDEO_CODEC = 'av01.0.04M.08';

/** The `videoCodec` option values of ConversionOptions, and the WebCodecs codec string each asks the encoder for. */
const VIDEO_CODEC_BY_OPTION: ReadonlyMap<string, string> = new Map([
  ['h264', MP4_TARGET_VIDEO_CODEC],
  ['hevc', HEVC_TARGET_VIDEO_CODEC],
  ['vp8', 'vp8'],
  ['vp9', WEBM_TARGET_VIDEO_CODEC],
  ['av1', AV1_TARGET_VIDEO_CODEC],
]);

/** Which level family a codec string of the table above stands for; a codec the request spelled out is not here. */
const LEVEL_FAMILY_BY_DEFAULT_CODEC: ReadonlyMap<string, LevelFamily> = new Map([
  [MP4_TARGET_VIDEO_CODEC, 'h264'],
  [HEVC_TARGET_VIDEO_CODEC, 'hevc'],
  [WEBM_TARGET_VIDEO_CODEC, 'vp9'],
]);

/** Codec string prefixes each video container carries. */
const MP4_VIDEO_CODEC_PREFIXES: readonly string[] = ['avc1.', 'hvc1.', 'hev1.', 'vp09.', 'av01.'];
const WEBM_VIDEO_CODEC_PREFIXES: readonly string[] = ['vp8', 'vp09.', 'av01.'];
const MP4_VIDEO_TARGETS: ReadonlySet<string> = new Set(['mp4', 'm4v', 'av1']);

function assertContainerCarries(target: string, codec: string): void {
  let prefixes: readonly string[] | undefined;
  if (MP4_VIDEO_TARGETS.has(target)) prefixes = MP4_VIDEO_CODEC_PREFIXES;
  else if (target === 'webm') prefixes = WEBM_VIDEO_CODEC_PREFIXES;
  if (prefixes && !prefixes.some((prefix) => codec.startsWith(prefix))) {
    throw new EdgeUnsupportedError(`The ${target} container does not carry ${codec}; the server engine converts it.`);
  }
}

/**
 * Resolves standard codec strings for WebCodecs VideoEncoder/AudioEncoder.
 */
export function resolveWebCodecsConfig(targetFormat: string, userCodec?: string): {
  codec: string;
  mimeType: string;
  isVideo: boolean;
  /** Set when the codec was named by family or by target, not spelled out: its level is then derived from the video. */
  deriveLevel?: LevelFamily;
} {
  const tgt = targetFormat.toLowerCase();
  if (userCodec) {
    const requested = userCodec.toLowerCase();
    const isAudioCodec = ['mp4a', 'aac', 'opus', 'vorbis', 'pcm'].some((c) => requested.includes(c));
    const alias = isAudioCodec ? undefined : VIDEO_CODEC_BY_OPTION.get(requested);
    const codec = isAudioCodec ? userCodec : (alias ?? userCodec);
    if (!isAudioCodec) assertContainerCarries(tgt, codec);
    let mimeType = 'video/mp4';
    if (tgt === 'webm') {
      mimeType = isAudioCodec ? 'audio/webm' : 'video/webm';
    } else if (tgt === 'ogg' || tgt === 'opus') {
      mimeType = 'audio/ogg; codecs=opus';
    } else if (isAudioCodec) {
      mimeType = 'audio/mp4';
    }
    const family = alias === undefined ? undefined : LEVEL_FAMILY_BY_DEFAULT_CODEC.get(alias);
    return { codec, mimeType, isVideo: !isAudioCodec, ...(family ? { deriveLevel: family } : {}) };
  }

  switch (tgt) {
    case 'mp4':
    case 'm4v':
      return { codec: MP4_TARGET_VIDEO_CODEC, mimeType: 'video/mp4', isVideo: true, deriveLevel: 'h264' };
    case 'webm':
      return { codec: WEBM_TARGET_VIDEO_CODEC, mimeType: 'video/webm', isVideo: true, deriveLevel: 'vp9' };
    case 'av1':
      return { codec: AV1_TARGET_VIDEO_CODEC, mimeType: 'video/mp4', isVideo: true };
    case 'm4a':
      return { codec: 'mp4a.40.2', mimeType: 'audio/mp4', isVideo: false };
    case 'aac':
      // An ADTS stream, not an MP4 file
      return { codec: 'mp4a.40.2', mimeType: 'audio/aac', isVideo: false };
    case 'opus':
      return { codec: 'opus', mimeType: 'audio/ogg; codecs=opus', isVideo: false };
    case 'ogg':
      throw new EdgeUnsupportedError(
        'Ogg Vorbis encoding is not supported by WebCodecs hardware encoder. Native FFmpeg engine is required for authentic lossy Vorbis compression (Fail-Closed).'
      );
    default:
      throw new EdgeUnsupportedError(
        `The edge WebCodecs worker has no muxer for the "${targetFormat}" target; the server engine converts it.`
      );
  }
}

export { demuxMp4 } from '../media/iso-bmff-demux';
export { demuxWav } from '../media/wav-demux';

/** Containers read as ISO base media files: MP4 and its QuickTime, iTunes video and audio relatives. */
const ISO_BMFF_FORMATS: ReadonlySet<string> = new Set(['mp4', 'm4v', 'mov', 'm4a']);

/**
 * Container demuxer for the formats the edge worker reads. Any other container (AVI, MKV, WebM, ...) is
 * unsupported here and is converted by the server tier; no container is guessed from its bytes.
 */
export function demuxMedia(buffer: ArrayBuffer, format: string): DemuxedTrackInfo {
  const fmt = format.toLowerCase();
  if (ISO_BMFF_FORMATS.has(fmt)) return demuxMp4(buffer);
  if (fmt === 'wav') return demuxWav(buffer);
  throw new EdgeUnsupportedError(`The edge WebCodecs worker has no demuxer for ${fmt || 'unknown'} input.`);
}

export { muxAdtsStream, muxMp4, muxOggOpus, muxWebm };
export { createOggPageTyped } from '../media/ogg-opus-mux';

/** Codec strings the demuxer hands to VideoDecoder: an RFC 6381 string, never a bare sample entry name. */
const WEBCODECS_VIDEO_CODEC_PATTERN = /^(avc1|avc3|hvc1|hev1|vp09|av01)\.[0-9a-zA-Z.]+$/;

/** Decoded frames or audio blocks that may wait for the encoder at once; each pins GPU or heap memory. */
const MAX_PENDING_DECODED_ITEMS = 8;
/** Encoded chunks queued inside a decoder before the demuxer pauses. */
const MAX_DECODE_QUEUE_SIZE = 32;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Resolves on the next `dequeue` event of a codec, or on the next task where the platform has no events. */
function nextDequeue(codec: any): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof codec.addEventListener === 'function') {
      codec.addEventListener('dequeue', () => resolve(), { once: true });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function waitForDecodeQueue(decoder: any): Promise<void> {
  while (decoder.decodeQueueSize >= MAX_DECODE_QUEUE_SIZE) {
    await nextDequeue(decoder);
  }
}

/** A codec that has already failed is closed by the platform; closing it again must not hide the failure. */
function closeQuietly(codec: any): void {
  try {
    codec.close();
  } catch {
    // InvalidStateError: the codec was closed after an error, and that error is what gets reported
  }
}

/** Throws EdgeUnsupportedError unless `isConfigSupported` of the platform class accepts `config`. */
async function assertConfigSupported(platformClass: any, config: object, label: string, codec: string): Promise<void> {
  if (typeof platformClass.isConfigSupported !== 'function') {
    throw new EdgeUnsupportedError(`${label} cannot report whether it supports ${codec} in this browser environment`);
  }
  let supported: boolean;
  try {
    supported = Boolean((await platformClass.isConfigSupported(config))?.supported);
  } catch (err) {
    throw new EdgeUnsupportedError(`${label} rejected the ${codec} configuration: ${toError(err).message}`);
  }
  if (!supported) {
    throw new EdgeUnsupportedError(`${label} does not support ${codec} in this browser environment`);
  }
}

/** The decoder configuration an encoder reports with its first output chunk, copied out of the metadata. */
function captureDecoderConfig(metadata: any): EncoderOutputConfig | undefined {
  const config = metadata?.decoderConfig;
  if (!config || typeof config.codec !== 'string') return undefined;
  let description: Uint8Array | undefined;
  if (config.description) {
    const source = config.description;
    description = ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
      : new Uint8Array(source).slice();
  }
  return {
    codec: config.codec,
    description,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
    sampleRate: config.sampleRate,
    numberOfChannels: config.numberOfChannels,
  };
}

/** A resize redraws the picture through a canvas, which hands the encoder BT.709 pictures whatever the source was. */
function assertCanvasKeepsColour(track: DemuxedTrackInfo): void {
  if (track.colour && !survivesCanvasRedraw(track.colour)) {
    throw new EdgeUnsupportedError(
      "Resizing video redraws it through a canvas, which cannot keep the video's colour description; the server engine converts it."
    );
  }
}

function videoEncoderConfig(codec: string, width: number, height: number, bitrate: number, framerate: number): object {
  const config: Record<string, unknown> = { codec, width, height, bitrate, framerate };
  // Length-prefixed NAL units with the decoder configuration kept out of band: the layout MP4 stores
  if (codec.startsWith('avc1') || codec.startsWith('avc3')) config.avc = { format: 'avc' };
  if (codec.startsWith('hvc1') || codec.startsWith('hev1')) config.hevc = { format: 'hevc' };
  return config;
}

interface VideoEncodeResult {
  /** The codec string the platform accepted for the encoder; the muxers fall back to it for VP8 and VP9. */
  codec: string;
  chunks: EncodedMediaChunk[];
  /** What the encoder said about its own output; absent when it reported nothing. */
  decoderConfig?: EncoderOutputConfig;
}

/**
 * The first of `codecs` (lowest level first) whose encoder configuration the platform supports. A single
 * candidate keeps the platform's own refusal message; several that all fail say how many were tried.
 */
async function selectVideoEncoderConfig(
  VideoEncoderClass: any,
  codecs: readonly string[],
  family: LevelFamily | undefined,
  size: { width: number; height: number; framerate: number },
  bitrate: number
): Promise<{ codec: string; config: object }> {
  let lastRefusal: EdgeUnsupportedError | undefined;
  for (const codec of codecs) {
    const config = videoEncoderConfig(codec, size.width, size.height, bitrate, size.framerate);
    try {
      await assertConfigSupported(VideoEncoderClass, config, 'VideoEncoder', codec);
      return { codec, config };
    } catch (error) {
      if (!(error instanceof EdgeUnsupportedError)) throw error;
      lastRefusal = error;
    }
  }
  if (codecs.length === 1 && lastRefusal) throw lastRefusal;
  const label = family ? levelFamilyLabel(family) : 'codec';
  throw new EdgeUnsupportedError(
    `VideoEncoder supports none of the ${codecs.length} ${label} levels that admit ${size.width}x${size.height} at ${size.framerate} frames per second (${codecs[0]} to ${codecs[codecs.length - 1]}) in this browser environment`
  );
}

/** Codec strings to request, lowest level first: the one spelled out, or those derived from the video. */
function requestedVideoCodecs(
  config: { codec: string; deriveLevel?: LevelFamily },
  size: { width: number; height: number; framerate: number },
  track: DemuxedTrackInfo
): string[] {
  if (!config.deriveLevel) return [config.codec];
  return levelCodecStrings(config.deriveLevel, size, { bitDepth: track.bitDepth, chroma: track.chroma, colour: track.colour });
}

/**
 * Decodes the demuxed video samples and re-encodes them with the WebCodecs hardware pipeline.
 * Every frame comes from the input. Frames reach the encoder one at a time in the order the decoder emits them
 * (presentation order), VideoFrame.close() runs in a finally on every frame, and a missing or unsupporting
 * decoder or encoder throws EdgeUnsupportedError instead of producing substitute frames.
 */
async function encodeVideoTrack(
  codecs: readonly string[],
  family: LevelFamily | undefined,
  width: number,
  height: number,
  framerate: number,
  videoBitrate: number,
  flowController: WatermarkFlowController,
  demuxedTrack: DemuxedTrackInfo,
  onFraction?: (fraction: number) => void
): Promise<VideoEncodeResult> {
  const g = globalThis as any;
  const VideoFrameClass = g.VideoFrame;
  const VideoDecoderClass = g.VideoDecoder;
  const VideoEncoderClass = g.VideoEncoder;
  const EncodedChunkClass = g.EncodedVideoChunk;
  if (typeof VideoDecoderClass === 'undefined' || typeof EncodedChunkClass === 'undefined') {
    throw new EdgeUnsupportedError('WebCodecs VideoDecoder or EncodedVideoChunk is not supported in this browser environment');
  }
  if (typeof VideoEncoderClass === 'undefined' || typeof VideoFrameClass === 'undefined') {
    throw new EdgeUnsupportedError('WebCodecs VideoEncoder or VideoFrame is not supported in this browser environment');
  }
  if (demuxedTrack.type !== 'video' || demuxedTrack.samples.length === 0) {
    throw new EdgeUnsupportedError('The input has no video track the edge worker can decode.');
  }
  if (!WEBCODECS_VIDEO_CODEC_PATTERN.test(demuxedTrack.codec)) {
    throw new EdgeUnsupportedError(`The edge worker cannot decode the "${demuxedTrack.codec}" video track.`);
  }

  const decoderConfig: Record<string, unknown> = { codec: demuxedTrack.codec, description: demuxedTrack.description };
  if (demuxedTrack.colour) decoderConfig.colorSpace = toWebCodecsColorSpace(demuxedTrack.colour);
  if (width !== demuxedTrack.width || height !== demuxedTrack.height) assertCanvasKeepsColour(demuxedTrack);
  await assertConfigSupported(VideoDecoderClass, decoderConfig, 'VideoDecoder', demuxedTrack.codec);
  const { codec, config: encoderConfig } = await selectVideoEncoderConfig(
    VideoEncoderClass, codecs, family, { width, height, framerate }, videoBitrate
  );

  const chunks: EncodedMediaChunk[] = [];
  let outputConfig: EncoderOutputConfig | undefined;
  const queue = new OrderedWorkQueue();
  const frameDurationMicros = Math.round(MICROS_PER_SECOND / framerate);
  const totalSamples = demuxedTrack.samples.length;

  const encoder = new VideoEncoderClass({
    output: (chunk: any, metadata: any) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        data,
        timestampMicros: chunk.timestamp,
        durationMicros: chunk.duration ?? undefined,
        isKeyFrame: chunk.type === 'key',
      });
      outputConfig ??= captureDecoderConfig(metadata);
      flowController.onDequeue(encoder.encodeQueueSize);
    },
    error: (err: unknown) => {
      queue.fail(toError(err));
      flowController.reset();
    },
  });
  encoder.ondequeue = () => {
    flowController.onDequeue(encoder.encodeQueueSize);
  };

  try {
    encoder.configure(encoderConfig);

    let frameIdx = 0;
    const processFrame = async (decodedFrame: any): Promise<void> => {
      let canvasFrame: any = null;
      try {
        await flowController.checkBackpressure(encoder.encodeQueueSize);
        let frameToEncode = decodedFrame;

        // OffscreenCanvas step for resizing
        if (decodedFrame.displayWidth !== width || decodedFrame.displayHeight !== height) {
          assertCanvasKeepsColour(demuxedTrack);
          if (typeof OffscreenCanvas === 'undefined') {
            throw new EdgeUnsupportedError('Resizing video needs OffscreenCanvas, which this browser lacks.');
          }
          const canvas = new OffscreenCanvas(width, height);
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            throw new EdgeUnsupportedError('The browser refused a 2D canvas context for resizing the video.');
          }
          ctx.drawImage(decodedFrame, 0, 0, width, height);
          canvasFrame = new VideoFrameClass(canvas, {
            timestamp: decodedFrame.timestamp,
            duration: decodedFrame.duration ?? frameDurationMicros,
          });
          frameToEncode = canvasFrame;
        }

        encoder.encode(frameToEncode, { keyFrame: frameIdx % OUTPUT_KEYFRAME_INTERVAL_FRAMES === 0 });
        frameIdx++;
        onFraction?.(frameIdx / totalSamples);
      } finally {
        canvasFrame?.close();
        decodedFrame.close(); // Deterministic VRAM cleanup
      }
    };

    const decoder = new VideoDecoderClass({
      output: (frame: any) =>
        queue.push(
          () => processFrame(frame),
          () => frame.close()
        ),
      error: (err: unknown) => {
        queue.fail(toError(err));
        flowController.reset();
      },
    });

    try {
      decoder.configure(decoderConfig);
      for (const sample of demuxedTrack.samples) {
        await queue.waitBelow(MAX_PENDING_DECODED_ITEMS);
        await waitForDecodeQueue(decoder);
        decoder.decode(
          new EncodedChunkClass({
            type: sample.isKeyFrame ? 'key' : 'delta',
            timestamp: sample.timestampMicros,
            duration: sample.durationMicros,
            data: sample.data,
          })
        );
      }
      await decoder.flush();
      await queue.drain();
    } finally {
      closeQuietly(decoder);
    }

    await encoder.flush();
    queue.throwIfFailed();
  } catch (error) {
    // Stop work still queued behind the failure and release anything waiting on the encoder
    queue.fail(error);
    flowController.reset();
    throw error;
  } finally {
    closeQuietly(encoder);
    // Every decoded frame still queued is closed before the failure reaches the caller
    await queue.settle();
  }

  return { codec, chunks, decoderConfig: outputConfig };
}

/** Demuxer codec labels of PCM audio start with this; every other label names a compressed codec. */
const PCM_CODEC_PREFIX = 'pcm-';

interface AudioEncodeResult {
  chunks: EncodedMediaChunk[];
  decoderConfig?: EncoderOutputConfig;
  /** Rate and channel count of the audio that was encoded, as the decoder produced it. */
  sampleRate: number;
  channels: number;
}

/**
 * Encodes the demuxed audio with WebCodecs. PCM becomes `AudioData` directly; compressed audio goes through an
 * `AudioDecoder` first, and its output (not the container's claim about it) decides the encoder configuration,
 * after the encoder delay before time zero is removed. The encoder does not resample or mix, so a requested
 * rate or channel count that differs from the decoded audio throws EdgeUnsupportedError, as does any missing
 * or unsupporting decoder or encoder.
 */
async function encodeAudioTrack(
  codec: string,
  audioBitrate: number,
  requested: { sampleRate?: number; channels?: number },
  flowController: WatermarkFlowController,
  demuxedTrack: DemuxedTrackInfo,
  onFraction?: (fraction: number) => void
): Promise<AudioEncodeResult> {
  const g = globalThis as any;
  const AudioEncoderClass = g.AudioEncoder;
  const AudioDataClass = g.AudioData;
  if (typeof AudioEncoderClass === 'undefined' || typeof AudioDataClass === 'undefined') {
    throw new EdgeUnsupportedError('WebCodecs AudioEncoder or AudioData is not supported in this browser environment');
  }
  if (demuxedTrack.type !== 'audio' || demuxedTrack.samples.length === 0) {
    throw new EdgeUnsupportedError('The input has no audio track the edge worker can encode.');
  }
  const isPcm = demuxedTrack.codec.startsWith(PCM_CODEC_PREFIX);
  const AudioDecoderClass = g.AudioDecoder;
  const EncodedAudioChunkClass = g.EncodedAudioChunk;
  let decoderConfig: object | undefined;
  if (!isPcm) {
    if (typeof AudioDecoderClass === 'undefined' || typeof EncodedAudioChunkClass === 'undefined') {
      throw new EdgeUnsupportedError('WebCodecs AudioDecoder or EncodedAudioChunk is not supported in this browser environment');
    }
    decoderConfig = {
      codec: demuxedTrack.codec,
      sampleRate: demuxedTrack.sampleRate,
      numberOfChannels: demuxedTrack.channels,
      description: demuxedTrack.description,
    };
    await assertConfigSupported(AudioDecoderClass, decoderConfig, 'AudioDecoder', demuxedTrack.codec);
  }

  const chunks: EncodedMediaChunk[] = [];
  let outputConfig: EncoderOutputConfig | undefined;
  const queue = new OrderedWorkQueue();
  let encoder: any;
  let encodedRate = 0;
  let encodedChannels = 0;

  const openEncoder = async (sampleRate: number, channels: number): Promise<void> => {
    if (requested.sampleRate !== undefined && requested.sampleRate !== sampleRate) {
      throw new EdgeUnsupportedError(`Resampling ${sampleRate} Hz audio to ${requested.sampleRate} Hz is not available at the edge.`);
    }
    if (requested.channels !== undefined && requested.channels !== channels) {
      throw new EdgeUnsupportedError(`Changing ${channels} audio channels to ${requested.channels} is not available at the edge.`);
    }
    const config: Record<string, unknown> = { codec, sampleRate, numberOfChannels: channels, bitrate: audioBitrate };
    // Raw AAC frames with an AudioSpecificConfig, which MP4 stores; ADTS headers are added where a target wants them
    if (codec.startsWith('mp4a')) config.aac = { format: 'aac' };
    await assertConfigSupported(AudioEncoderClass, config, 'AudioEncoder', `${codec} at ${sampleRate} Hz, ${channels} channels`);
    encoder = new AudioEncoderClass({
      output: (chunk: any, metadata: any) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({
          data,
          timestampMicros: chunk.timestamp,
          durationMicros: chunk.duration ?? undefined,
          isKeyFrame: true,
        });
        outputConfig ??= captureDecoderConfig(metadata);
        flowController.onDequeue(encoder.encodeQueueSize);
      },
      error: (err: unknown) => {
        queue.fail(toError(err));
        flowController.reset();
      },
    });
    encoder.ondequeue = () => {
      flowController.onDequeue(encoder.encodeQueueSize);
    };
    encoder.configure(config);
    encodedRate = sampleRate;
    encodedChannels = channels;
  };

  const feed = async (data: any): Promise<void> => {
    if (!encoder) {
      await openEncoder(data.sampleRate, data.numberOfChannels);
    } else if (data.sampleRate !== encodedRate || data.numberOfChannels !== encodedChannels) {
      throw new EdgeUnsupportedError('The audio changes its sample rate or channel count mid-stream; the server engine converts it.');
    }
    await flowController.checkBackpressure(encoder.encodeQueueSize);
    encoder.encode(data);
  };

  const totalSamples = demuxedTrack.samples.length;
  try {
    if (isPcm) {
      for (let i = 0; i < totalSamples; i++) {
        queue.throwIfFailed();
        const sample = demuxedTrack.samples[i];
        const pcm = pcmBlockToAudioData(demuxedTrack.codec, sample.data, demuxedTrack.channels as number);
        const audioData = new AudioDataClass({
          format: pcm.format,
          sampleRate: demuxedTrack.sampleRate,
          numberOfFrames: pcm.frames,
          numberOfChannels: demuxedTrack.channels,
          timestamp: sample.timestampMicros,
          data: pcm.data,
        });
        try {
          await feed(audioData);
        } finally {
          audioData.close();
        }
        onFraction?.((i + 1) / totalSamples);
      }
    } else {
      let decodedCount = 0;
      const processDecoded = async (data: any): Promise<void> => {
        const kept = trimAudioDataStart(data, AudioDataClass);
        if (kept === null) return;
        try {
          await feed(kept);
        } finally {
          kept.close();
        }
        decodedCount++;
        onFraction?.(Math.min(1, decodedCount / totalSamples));
      };
      const decoder = new AudioDecoderClass({
        output: (data: any) =>
          queue.push(
            () => processDecoded(data),
            () => data.close()
          ),
        error: (err: unknown) => {
          queue.fail(toError(err));
          flowController.reset();
        },
      });
      try {
        decoder.configure(decoderConfig);
        for (const sample of demuxedTrack.samples) {
          await queue.waitBelow(MAX_PENDING_DECODED_ITEMS);
          await waitForDecodeQueue(decoder);
          decoder.decode(
            new EncodedAudioChunkClass({
              type: 'key',
              timestamp: sample.timestampMicros,
              duration: sample.durationMicros,
              data: sample.data,
            })
          );
        }
        await decoder.flush();
        await queue.drain();
      } finally {
        closeQuietly(decoder);
      }
    }

    if (!encoder) {
      throw new EdgeUnsupportedError('The audio track decoded to no audio the edge worker can encode.');
    }
    await encoder.flush();
    queue.throwIfFailed();
  } catch (error) {
    queue.fail(error);
    flowController.reset();
    throw error;
  } finally {
    if (encoder) closeQuietly(encoder);
    // Every decoded block still queued is closed before the failure reaches the caller
    await queue.settle();
  }

  if (chunks.length === 0) {
    throw new EdgeUnsupportedError('The AudioEncoder produced no output for the audio track.');
  }
  return { chunks, decoderConfig: outputConfig, sampleRate: encodedRate, channels: encodedChannels };
}

interface MuxStreams {
  video?: { encoded: VideoEncodeResult; codec: string; width: number; height: number; colour?: VideoColour };
  audio?: { encoded: AudioEncodeResult; codec: string };
}

/**
 * The decoder configuration of an encoder's output. It is what the encoder reported; only for VP8 and VP9,
 * whose codec string is the whole configuration, may the requested codec stand in when it reported none.
 */
function reportedConfig(reported: EncoderOutputConfig | undefined, requestedCodec: string): EncoderOutputConfig {
  if (reported) return reported;
  if (requestedCodec === 'vp8' || requestedCodec.startsWith('vp09.')) return { codec: requestedCodec };
  throw new EdgeUnsupportedError(`The encoder reported no decoder configuration for ${requestedCodec}, which the container needs.`);
}

/**
 * Muxes the encoders' chunks into the target container, writing each stream's own decoder configuration.
 * A codec the container cannot carry, or an encoder that did not report what the container needs, throws.
 */
function muxFinalMedia(targetFormat: string, streams: MuxStreams): Uint8Array {
  const video = streams.video
    ? {
        chunks: streams.video.encoded.chunks,
        config: reportedConfig(streams.video.encoded.decoderConfig, streams.video.codec),
        width: streams.video.width,
        height: streams.video.height,
        colour: streams.video.colour,
      }
    : undefined;
  const audio = streams.audio
    ? {
        chunks: streams.audio.encoded.chunks,
        config: reportedConfig(streams.audio.encoded.decoderConfig, streams.audio.codec),
        sampleRate: streams.audio.encoded.sampleRate,
        channels: streams.audio.encoded.channels,
      }
    : undefined;

  switch (targetFormat) {
    case 'webm':
      return muxWebm({ video, audio });
    case 'mp4':
    case 'm4v':
    case 'av1':
      return muxMp4({ video, audio, majorBrand: 'isom' });
    case 'm4a':
      return muxMp4({ audio, majorBrand: 'M4A ' });
    case 'aac':
      if (!audio) throw new EdgeUnsupportedError('There is no audio to write as AAC.');
      return muxAdtsStream(audio.chunks, audio.config, audio.sampleRate, audio.channels);
    case 'opus':
    case 'ogg':
      if (!audio) throw new EdgeUnsupportedError('There is no audio to write as Ogg Opus.');
      return muxOggOpus(audio.chunks, audio.config.description);
    default:
      throw new EdgeUnsupportedError(`The edge WebCodecs worker has no muxer for the "${targetFormat}" target.`);
  }
}

/** Encoder and decoder classes a video conversion needs; each missing one makes the edge tier step aside. */
function assertVideoPlatformSupport(): void {
  const g = globalThis as any;
  if (typeof g.VideoEncoder === 'undefined' || typeof g.VideoFrame === 'undefined') {
    throw new EdgeUnsupportedError('WebCodecs VideoEncoder or VideoFrame is not supported in this browser environment');
  }
  if (typeof g.VideoDecoder === 'undefined' || typeof g.EncodedVideoChunk === 'undefined') {
    throw new EdgeUnsupportedError('WebCodecs VideoDecoder or EncodedVideoChunk is not supported in this browser environment');
  }
}

function assertAudioPlatformSupport(): void {
  const g = globalThis as any;
  if (typeof g.AudioEncoder === 'undefined' || typeof g.AudioData === 'undefined') {
    throw new EdgeUnsupportedError('WebCodecs AudioEncoder or AudioData is not supported in this browser environment');
  }
}

/**
 * Average frame rate of the demuxed video samples, from their presentation span. A track whose timing cannot
 * give one (a single sample without a duration, or all samples at one instant) has none and throws.
 */
export function deriveFrameRate(samples: ReadonlyArray<DemuxedMediaSample>): number {
  if (samples.length >= 2) {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const sample of samples) {
      first = Math.min(first, sample.timestampMicros);
      last = Math.max(last, sample.timestampMicros);
    }
    if (last > first) {
      return ((samples.length - 1) * MICROS_PER_SECOND) / (last - first);
    }
  } else if (samples.length === 1 && (samples[0].durationMicros ?? 0) > 0) {
    return MICROS_PER_SECOND / (samples[0].durationMicros as number);
  }
  throw new EdgeUnsupportedError('The video track carries no timing the edge worker can derive a frame rate from.');
}

/** Maps an encoder's 0..1 fraction onto the percent range `from`..`to` of the whole conversion. */
function scaledProgress(
  onProgress: ((progress: number) => void) | undefined,
  from: number,
  to: number
): (fraction: number) => void {
  return (fraction) => onProgress?.(from + Math.round(fraction * (to - from)));
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function convertVideoTrack(
  request: WebCodecsConversionRequest,
  config: ReturnType<typeof resolveWebCodecsConfig>,
  demuxedTrack: DemuxedTrackInfo,
  flowController: WatermarkFlowController,
  onProgress?: (progress: number) => void
): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  const { targetFormat, options = {} } = request;
  if (demuxedTrack.type !== 'video') {
    throw new EdgeUnsupportedError('The input has no video track to convert to a video container.');
  }
  if (Boolean(options.width) !== Boolean(options.height)) {
    throw new EdgeUnsupportedError(
      'Resizing to one given dimension needs aspect-ratio handling the edge worker lacks; the server engine converts it.'
    );
  }
  const width = options.width || demuxedTrack.width;
  const height = options.height || demuxedTrack.height;
  if (!width || !height) {
    throw new EdgeUnsupportedError('The video track does not state its frame size.');
  }
  const framerate = options.framerate || deriveFrameRate(demuxedTrack.samples);

  const audioTrack = demuxedTrack.audioTrack;
  const hasAudio = Boolean(audioTrack && audioTrack.samples.length > 0);
  const videoEnd = hasAudio ? PROGRESS_VIDEO_ENCODED_WITH_AUDIO : PROGRESS_ENCODED;
  // Chosen before anything is decoded: a video no level admits, or a source the VP9 profile cannot be read from, throws now
  const codecs = requestedVideoCodecs(config, { width, height, framerate }, demuxedTrack);
  const video = await encodeVideoTrack(
    codecs,
    config.deriveLevel,
    width,
    height,
    framerate,
    options.videoBitrate || DEFAULT_VIDEO_BITRATE_BPS,
    flowController,
    demuxedTrack,
    scaledProgress(onProgress, PROGRESS_INPUT_READ, videoEnd)
  );

  // Audio track preservation during video transcoding
  let audio: AudioEncodeResult | undefined;
  const audioCodec = targetFormat === 'webm' ? 'opus' : 'mp4a.40.2';
  if (audioTrack && hasAudio) {
    audio = await encodeAudioTrack(
      audioCodec,
      options.audioBitrate || DEFAULT_AUDIO_BITRATE_BPS,
      { sampleRate: options.audioSampleRate, channels: options.audioChannels },
      flowController,
      audioTrack,
      scaledProgress(onProgress, PROGRESS_VIDEO_ENCODED_WITH_AUDIO, PROGRESS_ENCODED)
    );
  }

  onProgress?.(PROGRESS_MUXING);

  const finalBytes = muxFinalMedia(targetFormat, {
    video: { encoded: video, codec: video.codec, width, height, colour: demuxedTrack.colour },
    audio: audio ? { encoded: audio, codec: audioCodec } : undefined,
  });

  onProgress?.(PROGRESS_DONE);
  return { buffer: copyToArrayBuffer(finalBytes), mimeType: config.mimeType };
}

async function convertAudioTrack(
  request: WebCodecsConversionRequest,
  config: ReturnType<typeof resolveWebCodecsConfig>,
  demuxedTrack: DemuxedTrackInfo,
  flowController: WatermarkFlowController,
  onProgress?: (progress: number) => void
): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  const { targetFormat, options = {} } = request;
  // The audio of a video file converts to an audio target as well.
  const audioTrack = demuxedTrack.type === 'audio' ? demuxedTrack : demuxedTrack.audioTrack;
  if (!audioTrack || audioTrack.samples.length === 0) {
    throw new EdgeUnsupportedError('The input has no audio track to convert to an audio container.');
  }

  const audio = await encodeAudioTrack(
    config.codec,
    options.audioBitrate || DEFAULT_AUDIO_BITRATE_BPS,
    { sampleRate: options.audioSampleRate, channels: options.audioChannels },
    flowController,
    audioTrack,
    scaledProgress(onProgress, PROGRESS_INPUT_READ, PROGRESS_ENCODED)
  );

  onProgress?.(PROGRESS_MUXING);

  const finalBytes = muxFinalMedia(targetFormat, { audio: { encoded: audio, codec: config.codec } });

  onProgress?.(PROGRESS_DONE);
  return { buffer: copyToArrayBuffer(finalBytes), mimeType: config.mimeType };
}

/**
 * Core Media Processing Engine for WebCodecs Pipeline.
 * Demuxer -> Decoder -> Canvas (optional) -> Encoder -> Muxer.
 * Guarantees deterministic resource release in all conditions.
 * Strict Fail-Closed: every missing demuxer, decoder or encoder throws EdgeUnsupportedError, which the tier
 * router answers by running the server tier. No frame, sample or metadata is ever invented.
 */
export async function processWebCodecsConversion(
  request: WebCodecsConversionRequest,
  onProgress?: (progress: number) => void
): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  const { sourceFormat, targetFormat, fileBuffer, options = {} } = request;
  const config = resolveWebCodecsConfig(targetFormat, options.codec);
  const flowController = new WatermarkFlowController(6, 2);

  // Audio processing never invokes VideoEncoder with an audio codec.
  if (config.isVideo) {
    assertVideoPlatformSupport();
  } else {
    assertAudioPlatformSupport();
  }

  onProgress?.(10);

  // 1. Demux input container
  const demuxedTrack = demuxMedia(fileBuffer, sourceFormat);

  onProgress?.(PROGRESS_INPUT_READ);

  if (config.isVideo) {
    return convertVideoTrack(request, config, demuxedTrack, flowController, onProgress);
  }
  return convertAudioTrack(request, config, demuxedTrack, flowController, onProgress);
}

// Attach worker listener if running inside dedicated Worker environment
if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = async (e: MessageEvent) => {
    const { type, jobId, fileBuffer, sourceFormat, targetFormat, options } = e.data || {};

    if (type === 'START_CONVERSION') {
      try {
        const result = await processWebCodecsConversion(
          { jobId, fileBuffer, sourceFormat, targetFormat, options },
          (progress) => {
            (self as any).postMessage({ type: 'PROGRESS', jobId, progress });
          }
        );

        (self as any).postMessage(
          {
            type: 'COMPLETED',
            jobId,
            buffer: result.buffer,
            mimeType: result.mimeType,
          },
          [result.buffer]
        );
      } catch (err: unknown) {
        const error = serializeWorkerError(err);
        (self as any).postMessage({
          type: 'ERROR',
          jobId,
          message: error.message,
          error,
        });
      }
    }
  };
}
