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

import { demuxMp4 } from '../media/iso-bmff-demux';
import type { DemuxedMediaSample, DemuxedTrackInfo } from '../media/media-types';
import { pcmBlockToAudioData } from '../media/pcm-audio';
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
 * Resolves standard codec strings for WebCodecs VideoEncoder/AudioEncoder.
 */
export function resolveWebCodecsConfig(targetFormat: string, userCodec?: string): {
  codec: string;
  mimeType: string;
  isVideo: boolean;
} {
  const tgt = targetFormat.toLowerCase();
  if (userCodec) {
    const isAudioCodec = ['mp4a', 'aac', 'opus', 'vorbis', 'pcm'].some((c) => userCodec.toLowerCase().includes(c));
    let mimeType = 'video/mp4';
    if (tgt === 'webm') {
      mimeType = isAudioCodec ? 'audio/webm' : 'video/webm';
    } else if (tgt === 'ogg' || tgt === 'opus') {
      mimeType = 'audio/ogg; codecs=opus';
    } else if (isAudioCodec) {
      mimeType = 'audio/mp4';
    }
    return {
      codec: userCodec,
      mimeType,
      isVideo: !isAudioCodec,
    };
  }

  switch (tgt) {
    case 'mp4':
    case 'm4v':
      return { codec: 'avc1.4d002a', mimeType: 'video/mp4', isVideo: true };
    case 'webm':
      return { codec: 'vp09.00.10.08', mimeType: 'video/webm', isVideo: true };
    case 'av1':
      return { codec: 'av01.0.04M.08', mimeType: 'video/mp4', isVideo: true };
    case 'm4a':
    case 'aac':
      return { codec: 'mp4a.40.2', mimeType: 'audio/mp4', isVideo: false };
    case 'opus':
      return { codec: 'opus', mimeType: 'audio/ogg; codecs=opus', isVideo: false };
    case 'ogg':
      if (userCodec === 'opus') {
        return { codec: 'opus', mimeType: 'audio/ogg; codecs=opus', isVideo: false };
      }
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

/**
 * Wraps raw AAC frames with ADTS (Audio Data Transport Stream) headers.
 */
export function wrapAacWithAdts(rawFrame: Uint8Array, sampleRate: number = 44100, channels: number = 2): Uint8Array {
  const sampleRateFrequencies: Record<number, number> = {
    96000: 0x0, 88200: 0x1, 64000: 0x2, 48000: 0x3,
    44100: 0x4, 32000: 0x5, 24000: 0x6, 22050: 0x7,
    16000: 0x8, 12000: 0x9, 11025: 0xa, 8000: 0xb, 7350: 0xc
  };
  const freqIdx = sampleRateFrequencies[sampleRate] ?? 0x4;
  const channelCfg = channels === 1 ? 1 : 2;
  const frameLength = rawFrame.byteLength + 7;

  const adts = new Uint8Array(frameLength);
  adts[0] = 0xff;
  adts[1] = 0xf1;
  adts[2] = ((1) << 6) | ((freqIdx & 0x0f) << 2) | ((channelCfg >> 2) & 0x01);
  adts[3] = ((channelCfg & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  adts[4] = (frameLength >> 3) & 0xff;
  adts[5] = ((frameLength & 0x07) << 5) | 0x1f;
  adts[6] = 0xfc;

  adts.set(rawFrame, 7);
  return adts;
}

/**
 * Builds a fast-path WebM (EBML) video container from encoded chunks.
 */
export function muxWebmVideo(
  chunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  width: number,
  height: number,
  audioChunks?: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  sampleRate: number = 44100,
  channels: number = 2
): Uint8Array {
  const parts: Uint8Array[] = [];

  const ebmlHeader = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3,
    0x9f, 0x42, 0x86, 0x81, 0x01,
    0x42, 0xf7, 0x81, 0x01,
    0x42, 0xf2, 0x81, 0x04,
    0x42, 0xf3, 0x81, 0x08,
    0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
    0x42, 0x87, 0x81, 0x04,
    0x42, 0x85, 0x81, 0x02,
  ]);
  parts.push(ebmlHeader);

  const segmentHeader = new Uint8Array([
    0x18, 0x53, 0x80, 0x67,
    0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  parts.push(segmentHeader);

  const hasAudio = audioChunks && audioChunks.length > 0;

  // Track 1: Video
  const videoTrackEntry: number[] = [
    0xae, // TrackEntry
    0x86, 0x81, 0x01, // TrackNumber = 1
    0x73, 0xc5, 0x81, 0x01, // TrackUID = 1
    0x83, 0x81, 0x01, // TrackType = 1 (video)
    0x86, 0x85, 0x56, 0x5f, 0x56, 0x50, 0x39, // CodecID: 'V_VP9'
    0xe0, // VideoSettings
    0xb0, 0x82, (width >> 8) & 0xff, width & 0xff, // PixelWidth
    0xba, 0x82, (height >> 8) & 0xff, height & 0xff, // PixelHeight
  ];

  const tracksPayload: number[] = [...videoTrackEntry];

  if (hasAudio) {
    // Track 2: Audio (Opus)
    const audioTrackEntry: number[] = [
      0xae, // TrackEntry
      0x86, 0x81, 0x02, // TrackNumber = 2
      0x73, 0xc5, 0x81, 0x02, // TrackUID = 2
      0x83, 0x81, 0x02, // TrackType = 2 (audio)
      0x86, 0x86, 0x41, 0x5f, 0x4f, 0x50, 0x55, 0x53, // CodecID: 'A_OPUS'
      0xe1, // AudioSettings
      0x9f, 0x81, channels & 0xff, // Channels
      0xb5, 0x84, ...new Uint8Array(new Float32Array([sampleRate]).buffer).reverse(), // SamplingFrequency
    ];
    tracksPayload.push(...audioTrackEntry);
  }

  let trackLenBytes: number[];
  if (tracksPayload.length < 0x80) {
    trackLenBytes = [0x80 | tracksPayload.length];
  } else {
    trackLenBytes = [0x40 | (tracksPayload.length >> 8), tracksPayload.length & 0xff];
  }

  const tracksHeader = new Uint8Array([
    0x16, 0x54, 0xae, 0x6b,
    ...trackLenBytes,
    ...tracksPayload,
  ]);
  parts.push(tracksHeader);

  const clusterTimecode = new Uint8Array([
    0x1f, 0x43, 0xb6, 0x75,
    0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xe7, 0x81, 0x00,
  ]);
  parts.push(clusterTimecode);

  type WebmBlock = {
    data: Uint8Array;
    timestampMicros: number;
    isKeyFrame: boolean;
    trackByte: number;
  };

  const allBlocks: WebmBlock[] = chunks.map((c) => ({
    ...c,
    trackByte: 0x81,
  }));

  if (hasAudio) {
    for (const a of audioChunks) {
      allBlocks.push({
        data: a.data,
        timestampMicros: a.timestampMicros,
        isKeyFrame: true,
        trackByte: 0x82,
      });
    }
  }

  allBlocks.sort((a, b) => a.timestampMicros - b.timestampMicros);

  for (const chunk of allBlocks) {
    const timeOffsetMs = Math.max(0, Math.min(32767, Math.round(chunk.timestampMicros / 1000)));
    const flags = chunk.isKeyFrame ? 0x80 : 0x00;
    const headerLen = 4;
    const blockSize = headerLen + chunk.data.byteLength;

    let sizeBytes: number[];
    if (blockSize < 0x80) {
      sizeBytes = [0x80 | blockSize];
    } else if (blockSize < 0x4000) {
      sizeBytes = [0x40 | (blockSize >> 8), blockSize & 0xff];
    } else {
      sizeBytes = [0x20 | (blockSize >> 16), (blockSize >> 8) & 0xff, blockSize & 0xff];
    }

    const blockHeader = new Uint8Array([
      0xa3,
      ...sizeBytes,
      chunk.trackByte,
      (timeOffsetMs >> 8) & 0xff,
      timeOffsetMs & 0xff,
      flags,
    ]);
    parts.push(blockHeader, chunk.data);
  }

  const totalLength = parts.reduce((acc, p) => acc + p.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function buildIsoBmffBox(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.byteLength;
  const box = new Uint8Array(size);
  const view = new DataView(box.buffer, box.byteOffset, size);
  view.setUint32(0, size, false);
  for (let i = 0; i < 4; i++) {
    box[4 + i] = type.charCodeAt(i);
  }
  box.set(payload, 8);
  return box;
}

function concatUint8Arrays(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.byteLength;
  }
  return out;
}

/**
 * Builds valid ISO BMFF 'moov' box containing mvhd, trak, mdia, minf, and stbl boxes
 * for WebCodecs encoded H.264 video chunks.
 */
export function buildMp4MoovBox(
  chunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  width: number = 1280,
  height: number = 720,
  mdatDataOffset: number = 40,
  timescale: number = 1000,
  audioChunks?: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  sampleRate: number = 44100,
  channels: number = 2
): Uint8Array {
  const totalFrames = Math.max(1, chunks.length);
  const defaultDurationMs = Math.round(1000 / 30);
  let videoDurationMs = 0;

  if (chunks.length > 1) {
    const firstTs = chunks[0].timestampMicros;
    const lastTs = chunks[chunks.length - 1].timestampMicros;
    videoDurationMs = Math.max(
      defaultDurationMs * totalFrames,
      Math.round((lastTs - firstTs) / 1000) + defaultDurationMs
    );
  } else {
    videoDurationMs = defaultDurationMs * totalFrames;
  }

  let audioDurationMs = 0;
  const hasAudio = audioChunks && audioChunks.length > 0;
  if (hasAudio) {
    const firstAudioTs = audioChunks[0].timestampMicros;
    const lastAudioTs = audioChunks[audioChunks.length - 1].timestampMicros;
    const frameDur = Math.round((1024 * 1000) / sampleRate);
    audioDurationMs = Math.max(
      frameDur * audioChunks.length,
      Math.round((lastAudioTs - firstAudioTs) / 1000) + frameDur
    );
  }

  const totalDurationMs = Math.max(videoDurationMs, audioDurationMs);

  // 1. mvhd (Movie Header Box) - 100 bytes payload
  const mvhdPayload = new Uint8Array(100);
  const mvhdView = new DataView(mvhdPayload.buffer, mvhdPayload.byteOffset, 100);
  mvhdView.setUint32(0, 0, false); // version + flags
  mvhdView.setUint32(12, timescale, false); // timescale: 1000
  mvhdView.setUint32(16, totalDurationMs, false); // duration
  mvhdView.setUint32(20, 0x00010000, false); // rate 1.0
  mvhdView.setUint16(24, 0x0100, false); // volume 1.0
  // Identity matrix
  mvhdView.setUint32(36, 0x00010000, false);
  mvhdView.setUint32(52, 0x00010000, false);
  mvhdView.setUint32(68, 0x40000000, false);
  mvhdView.setUint32(96, hasAudio ? 3 : 2, false); // next_track_ID
  const mvhdBox = buildIsoBmffBox('mvhd', mvhdPayload);

  // 2. tkhd (Track Header Box) for Video - 84 bytes payload
  const tkhdPayload = new Uint8Array(84);
  const tkhdView = new DataView(tkhdPayload.buffer, tkhdPayload.byteOffset, 84);
  tkhdView.setUint32(0, 0x00000007, false); // version + flags (enabled | in_movie | in_preview)
  tkhdView.setUint32(12, 1, false); // track_ID = 1
  tkhdView.setUint32(20, videoDurationMs, false); // duration
  // Identity matrix
  tkhdView.setUint32(36, 0x00010000, false);
  tkhdView.setUint32(52, 0x00010000, false);
  tkhdView.setUint32(68, 0x40000000, false);
  tkhdView.setUint32(76, Math.round(width * 65536) >>> 0, false); // width (16.16 fixed point)
  tkhdView.setUint32(80, Math.round(height * 65536) >>> 0, false); // height (16.16 fixed point)
  const tkhdBox = buildIsoBmffBox('tkhd', tkhdPayload);

  // 3. mdhd (Media Header Box) for Video - 24 bytes payload
  const mdhdPayload = new Uint8Array(24);
  const mdhdView = new DataView(mdhdPayload.buffer, mdhdPayload.byteOffset, 24);
  mdhdView.setUint32(0, 0, false); // version + flags
  mdhdView.setUint32(12, timescale, false); // timescale: 1000
  mdhdView.setUint32(16, videoDurationMs, false); // duration
  mdhdView.setUint16(20, 0x55c4, false); // language: 'und'
  const mdhdBox = buildIsoBmffBox('mdhd', mdhdPayload);

  // 4. hdlr (Handler Box) for Video - 33 bytes payload
  const hdlrPayload = new Uint8Array(33);
  const hdlrView = new DataView(hdlrPayload.buffer, hdlrPayload.byteOffset, 33);
  hdlrView.setUint32(0, 0, false);
  hdlrView.setUint32(8, 0x76696465, false); // 'vide'
  const handlerName = 'VideoHandler';
  for (let i = 0; i < handlerName.length; i++) {
    hdlrPayload[20 + i] = handlerName.charCodeAt(i);
  }
  const hdlrBox = buildIsoBmffBox('hdlr', hdlrPayload);

  // 5. vmhd (Video Media Header) - 12 bytes payload
  const vmhdPayload = new Uint8Array(12);
  const vmhdView = new DataView(vmhdPayload.buffer, vmhdPayload.byteOffset, 12);
  vmhdView.setUint32(0, 0x00000001, false); // version + flags
  const vmhdBox = buildIsoBmffBox('vmhd', vmhdPayload);

  // 6. dinf -> dref
  const drefPayload = new Uint8Array(20);
  const drefView = new DataView(drefPayload.buffer, drefPayload.byteOffset, 20);
  drefView.setUint32(0, 0, false); // version + flags
  drefView.setUint32(4, 1, false); // entry count = 1
  drefView.setUint32(8, 12, false); // url box size
  drefView.setUint32(12, 0x75726c20, false); // 'url '
  drefView.setUint32(16, 0x00000001, false); // self-contained flag
  const dinfBox = buildIsoBmffBox('dinf', buildIsoBmffBox('dref', drefPayload));

  // 7. stbl components for Video:
  // 7a. avcC & avc1 in stsd
  const defaultSps = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0xe9, 0x02, 0x80, 0xf6, 0x01, 0x6e, 0x80]);
  const defaultPps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);

  const avcCSize = 11 + defaultSps.length + defaultPps.length;
  const avcCPayload = new Uint8Array(avcCSize);
  let off = 0;
  avcCPayload[off++] = 1; // configurationVersion
  avcCPayload[off++] = defaultSps[1]; // profile
  avcCPayload[off++] = defaultSps[2]; // profile_compat
  avcCPayload[off++] = defaultSps[3]; // level
  avcCPayload[off++] = 0xff; // lengthSizeMinusOne = 3 (4-byte NALU length)
  avcCPayload[off++] = 0xe1; // numOfSequenceParameterSets = 1
  avcCPayload[off++] = (defaultSps.length >> 8) & 0xff;
  avcCPayload[off++] = defaultSps.length & 0xff;
  avcCPayload.set(defaultSps, off);
  off += defaultSps.length;
  avcCPayload[off++] = 1; // numOfPictureParameterSets = 1
  avcCPayload[off++] = (defaultPps.length >> 8) & 0xff;
  avcCPayload[off++] = defaultPps.length & 0xff;
  avcCPayload.set(defaultPps, off);
  const avcCBox = buildIsoBmffBox('avcC', avcCPayload);

  // avc1 (VisualSampleEntry) - 78 bytes header + avcCBox
  const avc1Header = new Uint8Array(78);
  const avc1View = new DataView(avc1Header.buffer, avc1Header.byteOffset, 78);
  avc1View.setUint16(6, 1, false); // data_reference_index
  avc1View.setUint16(24, width, false);
  avc1View.setUint16(26, height, false);
  avc1View.setUint32(28, 0x00480000, false); // 72 dpi horiz
  avc1View.setUint32(32, 0x00480000, false); // 72 dpi vert
  avc1View.setUint16(40, 1, false); // frame_count = 1
  const compName = 'EasyConvert H.264';
  avc1Header[42] = compName.length;
  for (let i = 0; i < compName.length; i++) {
    avc1Header[43 + i] = compName.charCodeAt(i);
  }
  avc1View.setUint16(74, 0x0018, false); // depth 24-bit
  avc1View.setInt16(76, -1, false);
  const avc1Box = buildIsoBmffBox('avc1', concatUint8Arrays(avc1Header, avcCBox));

  // stsd for Video
  const stsdHeader = new Uint8Array(8);
  const stsdView = new DataView(stsdHeader.buffer, stsdHeader.byteOffset, 8);
  stsdView.setUint32(0, 0, false);
  stsdView.setUint32(4, 1, false); // entry_count = 1
  const stsdBox = buildIsoBmffBox('stsd', concatUint8Arrays(stsdHeader, avc1Box));

  // 7b. stts (Time-to-Sample Box)
  const sttsPayload = new Uint8Array(16);
  const sttsView = new DataView(sttsPayload.buffer, sttsPayload.byteOffset, 16);
  sttsView.setUint32(0, 0, false);
  sttsView.setUint32(4, 1, false); // 1 entry
  sttsView.setUint32(8, totalFrames, false); // sample_count
  sttsView.setUint32(12, Math.max(1, Math.round(videoDurationMs / totalFrames)), false); // sample_delta
  const sttsBox = buildIsoBmffBox('stts', sttsPayload);

  // 7c. stss (Sync Sample Box) - keyframes
  const keyframeIndices: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].isKeyFrame || i === 0) {
      keyframeIndices.push(i + 1); // 1-based index
    }
  }
  const stssPayload = new Uint8Array(8 + keyframeIndices.length * 4);
  const stssView = new DataView(stssPayload.buffer, stssPayload.byteOffset, stssPayload.length);
  stssView.setUint32(0, 0, false);
  stssView.setUint32(4, keyframeIndices.length, false);
  for (let i = 0; i < keyframeIndices.length; i++) {
    stssView.setUint32(8 + i * 4, keyframeIndices[i], false);
  }
  const stssBox = buildIsoBmffBox('stss', stssPayload);

  // 7d. stsc (Sample-to-Chunk Box)
  const stscPayload = new Uint8Array(20);
  const stscView = new DataView(stscPayload.buffer, stscPayload.byteOffset, 20);
  stscView.setUint32(0, 0, false);
  stscView.setUint32(4, 1, false); // 1 entry
  stscView.setUint32(8, 1, false); // first_chunk = 1
  stscView.setUint32(12, 1, false); // samples_per_chunk = 1
  stscView.setUint32(16, 1, false); // sample_description_index = 1
  const stscBox = buildIsoBmffBox('stsc', stscPayload);

  // 7e. stsz (Sample Size Box)
  const stszPayload = new Uint8Array(12 + totalFrames * 4);
  const stszView = new DataView(stszPayload.buffer, stszPayload.byteOffset, stszPayload.length);
  stszView.setUint32(0, 0, false);
  stszView.setUint32(4, 0, false); // variable size
  stszView.setUint32(8, totalFrames, false);
  for (let i = 0; i < chunks.length; i++) {
    stszView.setUint32(12 + i * 4, chunks[i].data.byteLength, false);
  }
  if (chunks.length === 0) {
    stszView.setUint32(12, 0, false);
  }
  const stszBox = buildIsoBmffBox('stsz', stszPayload);

  // 7f. stco (Chunk Offset Box) for Video
  const stcoPayload = new Uint8Array(8 + totalFrames * 4);
  const stcoView = new DataView(stcoPayload.buffer, stcoPayload.byteOffset, stcoPayload.length);
  stcoView.setUint32(0, 0, false);
  stcoView.setUint32(4, totalFrames, false);
  let currentFileOffset = mdatDataOffset;
  for (let i = 0; i < chunks.length; i++) {
    stcoView.setUint32(8 + i * 4, currentFileOffset, false);
    currentFileOffset += chunks[i].data.byteLength;
  }
  if (chunks.length === 0) {
    stcoView.setUint32(8, mdatDataOffset, false);
  }
  const stcoBox = buildIsoBmffBox('stco', stcoPayload);

  // Combine video track
  const stblBox = buildIsoBmffBox('stbl', concatUint8Arrays(stsdBox, sttsBox, stssBox, stscBox, stszBox, stcoBox));
  const minfBox = buildIsoBmffBox('minf', concatUint8Arrays(vmhdBox, dinfBox, stblBox));
  const mdiaBox = buildIsoBmffBox('mdia', concatUint8Arrays(mdhdBox, hdlrBox, minfBox));
  const trakBox = buildIsoBmffBox('trak', concatUint8Arrays(tkhdBox, mdiaBox));

  // Build audio track if audioChunks are provided
  let audioTrakBox: Uint8Array | null = null;
  if (hasAudio) {
    const audioCount = audioChunks.length;
    // Audio tkhd
    const aTkhdPayload = new Uint8Array(84);
    const aTkhdView = new DataView(aTkhdPayload.buffer, aTkhdPayload.byteOffset, 84);
    aTkhdView.setUint32(0, 0x00000007, false); // enabled | in_movie | in_preview
    aTkhdView.setUint32(12, 2, false); // track_ID = 2
    aTkhdView.setUint32(20, audioDurationMs, false);
    aTkhdView.setUint16(24, 0x0100, false); // volume 1.0
    aTkhdView.setUint32(36, 0x00010000, false);
    aTkhdView.setUint32(52, 0x00010000, false);
    aTkhdView.setUint32(68, 0x40000000, false);
    const aTkhdBox = buildIsoBmffBox('tkhd', aTkhdPayload);

    // Audio mdhd
    const aMdhdPayload = new Uint8Array(24);
    const aMdhdView = new DataView(aMdhdPayload.buffer, aMdhdPayload.byteOffset, 24);
    aMdhdView.setUint32(0, 0, false);
    aMdhdView.setUint32(12, timescale, false);
    aMdhdView.setUint32(16, audioDurationMs, false);
    aMdhdView.setUint16(20, 0x55c4, false); // 'und'
    const aMdhdBox = buildIsoBmffBox('mdhd', aMdhdPayload);

    // Audio hdlr
    const aHdlrPayload = new Uint8Array(33);
    const aHdlrView = new DataView(aHdlrPayload.buffer, aHdlrPayload.byteOffset, 33);
    aHdlrView.setUint32(0, 0, false);
    aHdlrView.setUint32(8, 0x736f756e, false); // 'soun'
    const aHandlerName = 'SoundHandler';
    for (let i = 0; i < aHandlerName.length; i++) {
      aHdlrPayload[20 + i] = aHandlerName.charCodeAt(i);
    }
    const aHdlrBox = buildIsoBmffBox('hdlr', aHdlrPayload);

    // Audio smhd (Sound Media Header)
    const smhdPayload = new Uint8Array(8);
    const aSmhdBox = buildIsoBmffBox('smhd', smhdPayload);

    // Audio dinf -> dref
    const aDinfBox = buildIsoBmffBox('dinf', buildIsoBmffBox('dref', drefPayload));

    // Audio stsd with mp4a and esds
    const mp4aHeader = new Uint8Array(28);
    const mp4aView = new DataView(mp4aHeader.buffer, mp4aHeader.byteOffset, 28);
    mp4aView.setUint16(6, 1, false); // data_reference_index
    mp4aView.setUint16(16, channels, false); // channelcount
    mp4aView.setUint16(18, 16, false); // samplesize 16-bit
    mp4aView.setUint32(24, (sampleRate << 16) >>> 0, false); // sample_rate 16.16

    const freqMap: Record<number, number> = {
      96000: 0x0, 88200: 0x1, 64000: 0x2, 48000: 0x3,
      44100: 0x4, 32000: 0x5, 24000: 0x6, 22050: 0x7,
      16000: 0x8, 12000: 0x9, 11025: 0xa, 8000: 0xb, 7350: 0xc,
    };
    const freqIdx = freqMap[sampleRate] ?? 4;
    const esdsPayload = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, // version + flags
      0x03, 0x19, // ES_Descriptor
      0x00, 0x02, // ES_ID
      0x00,
      0x04, 0x11, // DecoderConfigDescriptor
      0x40, // objectTypeIndication: MPEG-4 Audio
      0x15, // streamType = 5
      0x00, 0x03, 0x00,
      0x00, 0x02, 0x00, 0x00,
      0x00, 0x02, 0x00, 0x00,
      0x05, 0x02, // DecoderSpecificInfo
      ((2 << 3) | (freqIdx >> 1)) & 0xff,
      (((freqIdx & 0x01) << 7) | (channels << 3)) & 0xff,
      0x06, 0x01, 0x02, // SLConfigDescriptor
    ]);
    const esdsBox = buildIsoBmffBox('esds', esdsPayload);
    const mp4aBox = buildIsoBmffBox('mp4a', concatUint8Arrays(mp4aHeader, esdsBox));

    const aStsdHeader = new Uint8Array(8);
    const aStsdView = new DataView(aStsdHeader.buffer, aStsdHeader.byteOffset, 8);
    aStsdView.setUint32(0, 0, false);
    aStsdView.setUint32(4, 1, false);
    const aStsdBox = buildIsoBmffBox('stsd', concatUint8Arrays(aStsdHeader, mp4aBox));

    // Audio stts
    const aSttsPayload = new Uint8Array(16);
    const aSttsView = new DataView(aSttsPayload.buffer, aSttsPayload.byteOffset, 16);
    aSttsView.setUint32(0, 0, false);
    aSttsView.setUint32(4, 1, false);
    aSttsView.setUint32(8, audioCount, false);
    aSttsView.setUint32(12, Math.max(1, Math.round(audioDurationMs / audioCount)), false);
    const aSttsBox = buildIsoBmffBox('stts', aSttsPayload);

    // Audio stsc
    const aStscPayload = new Uint8Array(20);
    const aStscView = new DataView(aStscPayload.buffer, aStscPayload.byteOffset, 20);
    aStscView.setUint32(0, 0, false);
    aStscView.setUint32(4, 1, false);
    aStscView.setUint32(8, 1, false);
    aStscView.setUint32(12, 1, false);
    aStscView.setUint32(16, 1, false);
    const aStscBox = buildIsoBmffBox('stsc', aStscPayload);

    // Audio stsz
    const aStszPayload = new Uint8Array(12 + audioCount * 4);
    const aStszView = new DataView(aStszPayload.buffer, aStszPayload.byteOffset, aStszPayload.length);
    aStszView.setUint32(0, 0, false);
    aStszView.setUint32(4, 0, false);
    aStszView.setUint32(8, audioCount, false);
    for (let i = 0; i < audioCount; i++) {
      aStszView.setUint32(12 + i * 4, audioChunks[i].data.byteLength, false);
    }
    const aStszBox = buildIsoBmffBox('stsz', aStszPayload);

    // Audio stco: offset starts after all video chunks in mdat
    const totalVideoBytes = chunks.reduce((acc, c) => acc + c.data.byteLength, 0);
    let aOffset = mdatDataOffset + totalVideoBytes;
    const aStcoPayload = new Uint8Array(8 + audioCount * 4);
    const aStcoView = new DataView(aStcoPayload.buffer, aStcoPayload.byteOffset, aStcoPayload.length);
    aStcoView.setUint32(0, 0, false);
    aStcoView.setUint32(4, audioCount, false);
    for (let i = 0; i < audioCount; i++) {
      aStcoView.setUint32(8 + i * 4, aOffset, false);
      aOffset += audioChunks[i].data.byteLength;
    }
    const aStcoBox = buildIsoBmffBox('stco', aStcoPayload);

    const aStblBox = buildIsoBmffBox('stbl', concatUint8Arrays(aStsdBox, aSttsBox, aStscBox, aStszBox, aStcoBox));
    const aMinfBox = buildIsoBmffBox('minf', concatUint8Arrays(aSmhdBox, aDinfBox, aStblBox));
    const aMdiaBox = buildIsoBmffBox('mdia', concatUint8Arrays(aMdhdBox, aHdlrBox, aMinfBox));
    audioTrakBox = buildIsoBmffBox('trak', concatUint8Arrays(aTkhdBox, aMdiaBox));
  }

  if (audioTrakBox) {
    return buildIsoBmffBox('moov', concatUint8Arrays(mvhdBox, trakBox, audioTrakBox));
  }
  return buildIsoBmffBox('moov', concatUint8Arrays(mvhdBox, trakBox));
}

/**
 * Builds standard MP4 container box for encoded H.264 chunks.
 * When includeMoov is true, attaches complete ISO BMFF 'moov' atom with valid stbl metadata.
 */
export function muxMp4Media(
  chunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  width: number = 1280,
  height: number = 720,
  options: {
    includeMoov?: boolean;
    fastStart?: boolean;
    audioChunks?: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>;
    sampleRate?: number;
    channels?: number;
  } = {}
): Uint8Array {
  const audioChunks = options.audioChunks || [];
  const totalVideoBytes = chunks.reduce((acc, c) => acc + c.data.byteLength, 0);
  const totalAudioBytes = audioChunks.reduce((acc, c) => acc + c.data.byteLength, 0);
  const totalMediaBytes = totalVideoBytes + totalAudioBytes;

  const ftyp = new Uint8Array([
    0x00, 0x00, 0x00, 0x20,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x69, 0x73, 0x6f, 0x32,
    0x61, 0x76, 0x63, 0x31,
    0x6d, 0x70, 0x34, 0x31,
  ]);

  const mdatSize = 8 + totalMediaBytes;
  const mdatHeader = new Uint8Array([
    (mdatSize >> 24) & 0xff,
    (mdatSize >> 16) & 0xff,
    (mdatSize >> 8) & 0xff,
    mdatSize & 0xff,
    0x6d, 0x64, 0x61, 0x74,
  ]);

  if (options.includeMoov) {
    if (options.fastStart) {
      // Fast-Start layout: [ftyp][moov][mdat]
      const testMoov = buildMp4MoovBox(
        chunks,
        width,
        height,
        0,
        1000,
        audioChunks,
        options.sampleRate,
        options.channels
      );
      const moovByteLength = testMoov.byteLength;
      const mdatDataOffset = ftyp.byteLength + moovByteLength + mdatHeader.byteLength;
      const moovBox = buildMp4MoovBox(
        chunks,
        width,
        height,
        mdatDataOffset,
        1000,
        audioChunks,
        options.sampleRate,
        options.channels
      );

      const mdatPayload = new Uint8Array(mdatHeader.byteLength + totalMediaBytes);
      mdatPayload.set(mdatHeader, 0);
      let mdatOff = mdatHeader.byteLength;
      for (const chunk of chunks) {
        mdatPayload.set(chunk.data, mdatOff);
        mdatOff += chunk.data.byteLength;
      }
      for (const aChunk of audioChunks) {
        mdatPayload.set(aChunk.data, mdatOff);
        mdatOff += aChunk.data.byteLength;
      }
      return concatUint8Arrays(ftyp, moovBox, mdatPayload);
    }

    const mdatDataOffset = ftyp.byteLength + mdatHeader.byteLength;
    const baseOutput = new Uint8Array(mdatDataOffset + totalMediaBytes);
    let offset = 0;
    baseOutput.set(ftyp, offset);
    offset += ftyp.byteLength;
    baseOutput.set(mdatHeader, offset);
    offset += mdatHeader.byteLength;

    for (const chunk of chunks) {
      baseOutput.set(chunk.data, offset);
      offset += chunk.data.byteLength;
    }
    for (const aChunk of audioChunks) {
      baseOutput.set(aChunk.data, offset);
      offset += aChunk.data.byteLength;
    }

    const moovBox = buildMp4MoovBox(
      chunks,
      width,
      height,
      mdatDataOffset,
      1000,
      audioChunks,
      options.sampleRate,
      options.channels
    );
    return concatUint8Arrays(baseOutput, moovBox);
  }

  const mdatDataOffset = ftyp.byteLength + mdatHeader.byteLength;
  const baseOutput = new Uint8Array(mdatDataOffset + totalMediaBytes);
  let offset = 0;
  baseOutput.set(ftyp, offset);
  offset += ftyp.byteLength;
  baseOutput.set(mdatHeader, offset);
  offset += mdatHeader.byteLength;

  for (const chunk of chunks) {
    baseOutput.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  for (const aChunk of audioChunks) {
    baseOutput.set(aChunk.data, offset);
    offset += aChunk.data.byteLength;
  }

  return baseOutput;
}

/**
 * Convenience helper to produce a complete ISO BMFF MP4 with moov box.
 */
export function muxIsoBmffMp4(
  chunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  width: number = 1280,
  height: number = 720,
  options: { fastStart?: boolean } = {}
): Uint8Array {
  return muxMp4Media(chunks, width, height, { includeMoov: true, fastStart: options.fastStart });
}

/**
 * Generates an fMP4 / CMAF initialization segment containing ftyp and moov (with mvex/trex).
 */
export function buildFmp4InitSegment(
  width: number = 1280,
  height: number = 720,
  codec: string = 'avc1.4d002a',
  timescale: number = 90000
): Uint8Array {
  // 1. ftyp box
  const ftypPayload = new Uint8Array(24);
  const ftypView = new DataView(ftypPayload.buffer);
  ftypPayload.set([0x69, 0x73, 0x6f, 0x36], 0); // 'iso6'
  ftypView.setUint32(4, 1); // minor_version
  ftypPayload.set([0x69, 0x73, 0x6f, 0x6d], 8); // 'isom'
  ftypPayload.set([0x69, 0x73, 0x6f, 0x36], 12); // 'iso6'
  ftypPayload.set([0x63, 0x6d, 0x66, 0x63], 16); // 'cmfc'
  ftypPayload.set([0x6d, 0x70, 0x34, 0x31], 20); // 'mp41'
  const ftypBox = buildIsoBmffBox('ftyp', ftypPayload);

  // 2. mvhd box
  const mvhdPayload = new Uint8Array(100);
  const mvhdView = new DataView(mvhdPayload.buffer);
  mvhdView.setUint32(12, timescale); // timescale
  mvhdView.setUint32(16, 0); // duration = 0 for streaming
  mvhdView.setUint32(20, 0x00010000); // rate 1.0
  mvhdView.setUint16(24, 0x0100); // volume 1.0
  mvhdView.setUint32(36, 0x00010000);
  mvhdView.setUint32(52, 0x00010000);
  mvhdView.setUint32(68, 0x40000000);
  mvhdView.setUint32(96, 2); // next_track_ID = 2
  const mvhdBox = buildIsoBmffBox('mvhd', mvhdPayload);

  // 3. mvex -> trex
  const trexPayload = new Uint8Array(28);
  const trexView = new DataView(trexPayload.buffer);
  trexView.setUint32(4, 1); // track_ID = 1
  trexView.setUint32(8, 1); // default_sample_description_index = 1
  trexView.setUint32(12, Math.round(timescale / 30)); // default_sample_duration
  trexView.setUint32(16, 0); // default_sample_size
  trexView.setUint32(20, 0x01010000); // default_sample_flags (non-sync by default)
  const trexBox = buildIsoBmffBox('trex', trexPayload);
  const mvexBox = buildIsoBmffBox('mvex', trexBox);

  // 4. trak -> tkhd, mdia
  const tkhdPayload = new Uint8Array(84);
  const tkhdView = new DataView(tkhdPayload.buffer);
  tkhdView.setUint32(0, 0x00000007); // flags: enabled | in_movie | in_preview
  tkhdView.setUint32(12, 1); // track_ID = 1
  tkhdView.setUint32(20, 0); // duration = 0
  tkhdView.setUint32(36, 0x00010000);
  tkhdView.setUint32(52, 0x00010000);
  tkhdView.setUint32(68, 0x40000000);
  tkhdView.setUint32(76, width << 16);
  tkhdView.setUint32(80, height << 16);
  const tkhdBox = buildIsoBmffBox('tkhd', tkhdPayload);

  // mdhd
  const mdhdPayload = new Uint8Array(24);
  const mdhdView = new DataView(mdhdPayload.buffer);
  mdhdView.setUint32(12, timescale);
  mdhdView.setUint32(16, 0);
  mdhdView.setUint16(20, 0x55c4); // language 'und'
  const mdhdBox = buildIsoBmffBox('mdhd', mdhdPayload);

  // hdlr
  const hdlrPayload = new Uint8Array(25);
  hdlrPayload.set([0x76, 0x69, 0x64, 0x65], 8); // 'vide'
  const hdlrBox = buildIsoBmffBox('hdlr', hdlrPayload);

  // vmhd
  const vmhdPayload = new Uint8Array(12);
  const vmhdView = new DataView(vmhdPayload.buffer);
  vmhdView.setUint32(0, 0x00000001);
  const vmhdBox = buildIsoBmffBox('vmhd', vmhdPayload);

  // dinf -> dref
  const drefPayload = new Uint8Array(20);
  const drefView = new DataView(drefPayload.buffer);
  drefView.setUint32(4, 1);
  drefView.setUint32(8, 12);
  drefPayload.set([0x75, 0x72, 0x6c, 0x20], 12); // 'url '
  drefView.setUint32(16, 0x00000001);
  const dinfBox = buildIsoBmffBox('dinf', buildIsoBmffBox('dref', drefPayload));

  // stbl with empty sample tables for fMP4
  const avc1Payload = new Uint8Array(78);
  const avc1View = new DataView(avc1Payload.buffer);
  avc1View.setUint16(6, 1); // data_reference_index
  avc1View.setUint16(24, width);
  avc1View.setUint16(26, height);
  avc1View.setUint32(28, 0x00480000);
  avc1View.setUint32(32, 0x00480000);
  avc1View.setUint16(40, 1);
  avc1View.setUint16(74, 0x0018);
  avc1View.setInt16(76, -1);
  const avc1Box = buildIsoBmffBox('avc1', avc1Payload);

  const stsdPayload = new Uint8Array(8);
  const stsdView = new DataView(stsdPayload.buffer);
  stsdView.setUint32(4, 1); // 1 entry
  const stsdBox = buildIsoBmffBox('stsd', concatUint8Arrays(stsdPayload, avc1Box));

  // Empty stts, stsc, stsz, stco for fMP4
  const emptyBoxPayload = new Uint8Array(8);
  const sttsBox = buildIsoBmffBox('stts', emptyBoxPayload);
  const stscBox = buildIsoBmffBox('stsc', emptyBoxPayload);
  const stszBox = buildIsoBmffBox('stsz', new Uint8Array(12));
  const stcoBox = buildIsoBmffBox('stco', emptyBoxPayload);

  const stblBox = buildIsoBmffBox('stbl', concatUint8Arrays(stsdBox, sttsBox, stscBox, stszBox, stcoBox));
  const minfBox = buildIsoBmffBox('minf', concatUint8Arrays(vmhdBox, dinfBox, stblBox));
  const mdiaBox = buildIsoBmffBox('mdia', concatUint8Arrays(mdhdBox, hdlrBox, minfBox));
  const trakBox = buildIsoBmffBox('trak', concatUint8Arrays(tkhdBox, mdiaBox));

  const moovBox = buildIsoBmffBox('moov', concatUint8Arrays(mvhdBox, mvexBox, trakBox));
  return concatUint8Arrays(ftypBox, moovBox);
}

/**
 * Builds an fMP4 / CMAF media segment (moof + mdat) for a sequence of encoded chunks.
 */
export function buildFmp4MediaSegment(
  sequenceNumber: number,
  chunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  baseDecodeTimeMicros: number = 0,
  timescale: number = 90000
): Uint8Array {
  const sampleCount = chunks.length;
  const defaultDuration = Math.round(timescale / 30);

  // 1. mfhd box
  const mfhdPayload = new Uint8Array(8);
  const mfhdView = new DataView(mfhdPayload.buffer);
  mfhdView.setUint32(4, sequenceNumber);
  const mfhdBox = buildIsoBmffBox('mfhd', mfhdPayload);

  // 2. tfhd box (default-base-is-moof = 0x020000)
  const tfhdPayload = new Uint8Array(8);
  const tfhdView = new DataView(tfhdPayload.buffer);
  tfhdView.setUint32(0, 0x020000); // flags
  tfhdView.setUint32(4, 1); // track_ID = 1
  const tfhdBox = buildIsoBmffBox('tfhd', tfhdPayload);

  // 3. tfdt box (version 1 with 64-bit baseMediaDecodeTime)
  const tfdtPayload = new Uint8Array(12);
  const tfdtView = new DataView(tfdtPayload.buffer);
  tfdtView.setUint8(0, 1); // version 1
  const baseTimeUnits = Math.round((baseDecodeTimeMicros * timescale) / 1_000_000);
  tfdtView.setBigUint64(4, BigInt(baseTimeUnits));
  const tfdtBox = buildIsoBmffBox('tfdt', tfdtPayload);

  // 4. Compute total media payload size
  let totalMediaBytes = 0;
  for (const c of chunks) {
    totalMediaBytes += c.data.byteLength;
  }

  // 5. trun box
  const trunFlags = 0x000701;
  const trunHeaderSize = 12; // version+flags(4) + sample_count(4) + data_offset(4)
  const trunEntrySize = 12; // duration(4) + size(4) + flags(4)
  const trunPayload = new Uint8Array(trunHeaderSize + sampleCount * trunEntrySize);
  const trunView = new DataView(trunPayload.buffer);
  trunView.setUint32(0, trunFlags);
  trunView.setUint32(4, sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const chunk = chunks[i];
    const off = trunHeaderSize + i * trunEntrySize;
    let dur = defaultDuration;
    if (i + 1 < sampleCount) {
      const deltaMicros = chunks[i + 1].timestampMicros - chunk.timestampMicros;
      if (deltaMicros > 0) dur = Math.round((deltaMicros * timescale) / 1_000_000);
    }
    trunView.setUint32(off, dur);
    trunView.setUint32(off + 4, chunk.data.byteLength);
    trunView.setUint32(off + 8, chunk.isKeyFrame ? 0x02000000 : 0x01010000);
  }

  // Calculate size of traf and moof to find exact mdat data offset
  const trunBoxWithoutOffset = buildIsoBmffBox('trun', trunPayload);
  const trafBoxTest = buildIsoBmffBox('traf', concatUint8Arrays(tfhdBox, tfdtBox, trunBoxWithoutOffset));
  const moofBoxTest = buildIsoBmffBox('moof', concatUint8Arrays(mfhdBox, trafBoxTest));

  const dataOffset = moofBoxTest.byteLength + 8; // moof length + 8 bytes of mdat box header
  trunView.setInt32(8, dataOffset); // write exact data_offset

  const trunBox = buildIsoBmffBox('trun', trunPayload);
  const trafBox = buildIsoBmffBox('traf', concatUint8Arrays(tfhdBox, tfdtBox, trunBox));
  const moofBox = buildIsoBmffBox('moof', concatUint8Arrays(mfhdBox, trafBox));

  // 6. mdat box
  const mdatBoxHeader = new Uint8Array(8);
  const mdatView = new DataView(mdatBoxHeader.buffer);
  mdatView.setUint32(0, 8 + totalMediaBytes);
  mdatBoxHeader.set([0x6d, 0x64, 0x61, 0x74], 4);

  const mdatPayload = new Uint8Array(totalMediaBytes);
  let pOff = 0;
  for (const c of chunks) {
    mdatPayload.set(c.data, pOff);
    pOff += c.data.byteLength;
  }

  return concatUint8Arrays(moofBox, mdatBoxHeader, mdatPayload);
}

/**
 * Streams media frames as fragmented MP4 (CMAF / fMP4) sequentially.
 * If onSegment callback is provided, emits segments progressively to avoid memory accumulation.
 */
export function muxFmp4Stream(
  chunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  width: number = 1280,
  height: number = 720,
  options: {
    timescale?: number;
    fragmentChunkCount?: number;
    onSegment?: (segment: Uint8Array) => void;
  } = {}
): Uint8Array {
  const timescale = options.timescale || 90000;
  const fragmentSize = options.fragmentChunkCount || 15;
  const initSegment = buildFmp4InitSegment(width, height, 'avc1.4d002a', timescale);

  if (options.onSegment) {
    options.onSegment(initSegment);
  }

  const segments: Uint8Array[] = [initSegment];
  let seq = 1;

  for (let i = 0; i < chunks.length; i += fragmentSize) {
    const slice = chunks.slice(i, i + fragmentSize);
    const baseTime = slice[0]?.timestampMicros || 0;
    const mediaSeg = buildFmp4MediaSegment(seq++, slice, baseTime, timescale);

    if (options.onSegment) {
      options.onSegment(mediaSeg);
    }
    segments.push(mediaSeg);
  }

  return concatUint8Arrays(...segments);
}

/** Codec strings the demuxer hands to VideoDecoder: an RFC 6381 string, never a bare sample entry name. */
const WEBCODECS_VIDEO_CODEC_PATTERN = /^(avc1|avc3|hvc1|hev1|vp09|av01)\.[0-9a-zA-Z.]+$/;

/**
 * Decodes the demuxed video samples and re-encodes them with the WebCodecs hardware pipeline.
 * Guarantees VideoFrame.close() in try ... finally on every frame. Every frame comes from the input; a
 * missing decoder or an undecodable track throws EdgeUnsupportedError instead of producing substitute frames.
 */
async function encodeFramesHardware(
  codec: string,
  width: number,
  height: number,
  framerate: number,
  videoBitrate: number,
  flowController: WatermarkFlowController,
  encodedChunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  demuxedTrack: DemuxedTrackInfo,
  onFraction?: (fraction: number) => void
): Promise<void> {
  const VideoFrameClass = (globalThis as any).VideoFrame;
  const VideoDecoderClass = (globalThis as any).VideoDecoder;
  const EncodedChunkClass = (globalThis as any).EncodedVideoChunk;
  if (typeof VideoDecoderClass === 'undefined' || typeof EncodedChunkClass === 'undefined') {
    throw new EdgeUnsupportedError('WebCodecs VideoDecoder or EncodedVideoChunk is not supported in this browser environment');
  }
  if (demuxedTrack.type !== 'video' || demuxedTrack.samples.length === 0) {
    throw new EdgeUnsupportedError('The input has no video track the edge worker can decode.');
  }
  if (!WEBCODECS_VIDEO_CODEC_PATTERN.test(demuxedTrack.codec)) {
    throw new EdgeUnsupportedError(`The edge worker cannot decode the "${demuxedTrack.codec}" video track.`);
  }

  let encoderError: Error | null = null;
  const frameDurationMicros = Math.round(MICROS_PER_SECOND / framerate);

  const encoder = new (globalThis as any).VideoEncoder({
    output: (chunk: any) => {
      const chunkData = new Uint8Array(chunk.byteLength);
      chunk.copyTo(chunkData);
      encodedChunks.push({
        data: chunkData,
        timestampMicros: chunk.timestamp,
        isKeyFrame: chunk.type === 'key',
      });
      flowController.onDequeue(encoder.encodeQueueSize);
    },
    error: (err: any) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });

  (encoder as any).ondequeue = () => {
    flowController.onDequeue(encoder.encodeQueueSize);
  };

  try {
    encoder.configure({
      codec,
      width,
      height,
      bitrate: videoBitrate,
      framerate,
    });

    let decoderError: Error | null = null;
    let frameIdx = 0;
    const totalSamples = demuxedTrack.samples.length;

    const decoder = new VideoDecoderClass({
      output: async (decodedFrame: any) => {
        let canvasFrame: any = null;
        try {
          await flowController.checkBackpressure(encoder.encodeQueueSize);
          let frameToEncode = decodedFrame;

          // OffscreenCanvas step for resizing
          if (decodedFrame.displayWidth !== width || decodedFrame.displayHeight !== height) {
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
        } catch (err: any) {
          decoderError = err;
        } finally {
          if (canvasFrame) {
            canvasFrame.close();
          }
          decodedFrame.close(); // Deterministic VRAM cleanup
        }
      },
      error: (err: any) => {
        decoderError = err instanceof Error ? err : new Error(String(err));
      },
    });

    try {
      decoder.configure({
        codec: demuxedTrack.codec,
        description: demuxedTrack.description,
      });

      for (const sample of demuxedTrack.samples) {
        if (decoderError) throw decoderError;
        if (encoderError) throw encoderError;
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
      if (decoderError) throw decoderError;
    } finally {
      decoder.close();
    }

    await encoder.flush();
    if (encoderError) throw encoderError;
  } finally {
    encoder.close();
  }
}

/**
 * RFC 3533 Ogg CRC-32 Lookup Table (polynomial 0x04C11DB7)
 */
const OGG_CRC32_TABLE = new Uint32Array(256);
(() => {
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      if (r & 0x80000000) {
        r = ((r << 1) ^ 0x04c11db7) >>> 0;
      } else {
        r = (r << 1) >>> 0;
      }
    }
    OGG_CRC32_TABLE[i] = r;
  }
})();

function computeOggCrcUint8(buffer: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < buffer.length; i++) {
    const idx = ((crc >>> 24) ^ buffer[i]) & 0xff;
    crc = ((crc << 8) ^ OGG_CRC32_TABLE[idx]) >>> 0;
  }
  return crc >>> 0;
}

export function createOggPageTyped(
  payload: Uint8Array,
  headerType: number,
  granulePos: bigint,
  sequenceNum: number,
  serial: number
): Uint8Array {
  const segTable: number[] = [];
  let rem = payload.length;
  while (rem >= 255) {
    segTable.push(255);
    rem -= 255;
  }
  segTable.push(rem);

  const headerSize = 27 + segTable.length;
  const page = new Uint8Array(headerSize + payload.length);
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);

  page[0] = 0x4f; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53; // 'OggS'
  page[4] = 0; // version 0
  page[5] = headerType; // flags (0x02 = BOS, 0x04 = EOS)
  view.setBigInt64(6, granulePos, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequenceNum, true);
  view.setUint32(22, 0, true);
  page[26] = segTable.length;
  for (let i = 0; i < segTable.length; i++) {
    page[27 + i] = segTable[i];
  }
  page.set(payload, headerSize);

  const crc = computeOggCrcUint8(page);
  view.setUint32(22, crc, true);

  return page;
}

/**
 * Muxes discrete authentic Opus packets from WebCodecs AudioEncoder into an RFC 7845 Ogg Opus container.
 */
export function muxOggOpus(
  encodedChunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  sampleRate: number = 48000,
  channels: number = 2
): Uint8Array {
  const pages: Uint8Array[] = [];
  const serial = 0x4f505553; // 'OPUS'

  // Page 1: RFC 7845 Section 5.1 OpusHead (BOS)
  const opusHead = new Uint8Array(19);
  const headView = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength);
  const headMagic = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // 'OpusHead'
  opusHead.set(headMagic, 0);
  opusHead[8] = 1; // version 1
  opusHead[9] = channels;
  headView.setUint16(10, 384, true); // pre-skip 384
  headView.setUint32(12, sampleRate || 48000, true);
  headView.setInt16(16, 0, true);
  opusHead[18] = 0; // mapping family 0 (mono or stereo)

  pages.push(createOggPageTyped(opusHead, 0x02, 0n, 1, serial));

  // Page 2: RFC 7845 Section 5.2 OpusTags
  const vendorStr = 'EasyConvert WebCodecs Engine';
  const vendorBytes = new TextEncoder().encode(vendorStr);
  const tagList = [new TextEncoder().encode('ENCODER=EasyConvert WebCodecs Native Opus')];

  let tagsLen = 8 + 4 + vendorBytes.length + 4;
  for (const t of tagList) {
    tagsLen += 4 + t.length;
  }
  const opusTags = new Uint8Array(tagsLen);
  const tagsView = new DataView(opusTags.buffer, opusTags.byteOffset, opusTags.byteLength);
  const tagsMagic = [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]; // 'OpusTags'
  opusTags.set(tagsMagic, 0);
  let pos = 8;
  tagsView.setUint32(pos, vendorBytes.length, true);
  pos += 4;
  opusTags.set(vendorBytes, pos);
  pos += vendorBytes.length;
  tagsView.setUint32(pos, tagList.length, true);
  pos += 4;
  for (const t of tagList) {
    tagsView.setUint32(pos, t.length, true);
    pos += 4;
    opusTags.set(t, pos);
    pos += t.length;
  }

  pages.push(createOggPageTyped(opusTags, 0x00, 0n, 2, serial));

  // Page 3+: Audio Pages with authentic Opus packet payloads
  let seq = 3;
  let cumulativeGranule = 0n;

  if (encodedChunks.length === 0) {
    const emptyPayload = new Uint8Array([0xc0 | (channels === 2 ? 0x04 : 0x00), 0]);
    pages.push(createOggPageTyped(emptyPayload, 0x04, 0n, seq, serial));
  } else {
    for (let i = 0; i < encodedChunks.length; i++) {
      const chunk = encodedChunks[i];
      const isLast = i === encodedChunks.length - 1;
      const flag = isLast ? 0x04 : 0x00;

      cumulativeGranule += 960n; // 20ms frame at 48kHz = 960 samples

      pages.push(createOggPageTyped(chunk.data, flag, cumulativeGranule, seq++, serial));
    }
  }

  const totalLength = pages.reduce((sum, p) => sum + p.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of pages) {
    result.set(p, offset);
    offset += p.byteLength;
  }
  return result;
}

/** Demuxer codec labels of PCM audio start with this; every other label names a compressed codec. */
const PCM_CODEC_PREFIX = 'pcm-';

/**
 * Encodes the demuxed audio samples with WebCodecs AudioEncoder.
 * Guarantees AudioData.close() in try ... finally on every frame. Only samples that already are PCM become
 * `AudioData`; compressed audio throws EdgeUnsupportedError rather than being reinterpreted as PCM.
 */
async function encodeAudioHardware(
  codec: string,
  sampleRate: number,
  channels: number,
  audioBitrate: number,
  flowController: WatermarkFlowController,
  encodedChunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  demuxedTrack: DemuxedTrackInfo,
  onFraction?: (fraction: number) => void
): Promise<void> {
  let encoderError: Error | null = null;

  const AudioEncoderClass = (globalThis as any).AudioEncoder;
  const AudioDataClass = (globalThis as any).AudioData;

  if (typeof AudioEncoderClass === 'undefined' || typeof AudioDataClass === 'undefined') {
    throw new EdgeUnsupportedError('WebCodecs AudioEncoder or AudioData is not supported in this browser environment');
  }
  if (demuxedTrack.type !== 'audio' || demuxedTrack.samples.length === 0) {
    throw new EdgeUnsupportedError('The input has no audio track the edge worker can encode.');
  }
  if (!demuxedTrack.codec.startsWith(PCM_CODEC_PREFIX)) {
    throw new EdgeUnsupportedError(
      `The edge worker cannot decode "${demuxedTrack.codec}" audio, so the server engine converts it.`
    );
  }

  const audioEncoder = new AudioEncoderClass({
    output: (chunk: any) => {
      const chunkData = new Uint8Array(chunk.byteLength);
      chunk.copyTo(chunkData);
      encodedChunks.push({
        data: chunkData,
        timestampMicros: chunk.timestamp,
        isKeyFrame: true,
      });
      flowController.onDequeue(audioEncoder.encodeQueueSize);
    },
    error: (err: any) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });

  (audioEncoder as any).ondequeue = () => {
    flowController.onDequeue(audioEncoder.encodeQueueSize);
  };

  try {
    audioEncoder.configure({
      codec,
      sampleRate,
      numberOfChannels: channels,
      bitrate: audioBitrate,
    });

    const totalSamples = demuxedTrack.samples.length;
    for (let i = 0; i < totalSamples; i++) {
      if (encoderError) throw encoderError;
      await flowController.checkBackpressure(audioEncoder.encodeQueueSize);

      const sample = demuxedTrack.samples[i];
      const pcm = pcmBlockToAudioData(demuxedTrack.codec, sample.data, channels);

      let audioData: any = null;
      try {
        audioData = new AudioDataClass({
          format: pcm.format,
          sampleRate,
          numberOfFrames: pcm.frames,
          numberOfChannels: channels,
          timestamp: sample.timestampMicros,
          data: pcm.data,
        });
        audioEncoder.encode(audioData);
      } finally {
        if (audioData) {
          audioData.close();
        }
      }

      onFraction?.((i + 1) / totalSamples);
    }

    await audioEncoder.flush();
    if (encoderError) throw encoderError;
  } finally {
    audioEncoder.close();
  }
}

/**
 * Muxes encoded chunks into target container with audio and video support.
 */
function muxFinalMedia(
  targetFormat: string,
  encodedChunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }>,
  width: number,
  height: number,
  sampleRate: number | undefined,
  channels: number | undefined,
  audioChunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }> = [],
  userCodec?: string
): Uint8Array {
  if (targetFormat === 'webm') {
    return muxWebmVideo(encodedChunks, width, height, audioChunks, sampleRate, channels);
  }
  if (targetFormat === 'aac' || targetFormat === 'm4a') {
    if (sampleRate === undefined || channels === undefined) {
      throw new EdgeUnsupportedError('AAC output needs the sample rate and channel count of the source audio.');
    }
    const parts = encodedChunks.map((c) => wrapAacWithAdts(c.data, sampleRate, channels));
    const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
    const finalBytes = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      finalBytes.set(p, off);
      off += p.byteLength;
    }
    return finalBytes;
  }
  if (targetFormat === 'opus' || (targetFormat === 'ogg' && userCodec === 'opus')) {
    if (sampleRate === undefined || channels === undefined) {
      throw new EdgeUnsupportedError('Opus output needs the sample rate and channel count of the source audio.');
    }
    return muxOggOpus(encodedChunks, sampleRate, channels);
  }
  return muxMp4Media(encodedChunks, width, height, {
    includeMoov: true,
    audioChunks,
    sampleRate,
    channels,
  });
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

interface ResolvedAudioParams {
  sampleRate: number;
  channels: number;
}

/**
 * Sample rate and channel count come from the demuxed audio. The edge encoders neither resample nor mix
 * channels, so a request for different values is left to the server engine.
 */
function resolveAudioParams(track: DemuxedTrackInfo, options: WebCodecsConversionRequest['options'] = {}): ResolvedAudioParams {
  const { sampleRate, channels } = track;
  if (!sampleRate || !channels) {
    throw new EdgeUnsupportedError('The audio track does not state its sample rate and channel count.');
  }
  if (options.audioSampleRate !== undefined && options.audioSampleRate !== sampleRate) {
    throw new EdgeUnsupportedError(
      `Resampling ${sampleRate} Hz audio to ${options.audioSampleRate} Hz is not available at the edge.`
    );
  }
  if (options.audioChannels !== undefined && options.audioChannels !== channels) {
    throw new EdgeUnsupportedError(
      `Changing ${channels} audio channels to ${options.audioChannels} is not available at the edge.`
    );
  }
  return { sampleRate, channels };
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
  const width = options.width || demuxedTrack.width;
  const height = options.height || demuxedTrack.height;
  if (!width || !height) {
    throw new EdgeUnsupportedError('The video track does not state its frame size.');
  }
  const framerate = options.framerate || deriveFrameRate(demuxedTrack.samples);

  const audioTrack = demuxedTrack.audioTrack;
  const hasAudio = Boolean(audioTrack && audioTrack.samples.length > 0);
  const videoEnd = hasAudio ? PROGRESS_VIDEO_ENCODED_WITH_AUDIO : PROGRESS_ENCODED;
  const encodedChunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }> = [];
  await encodeFramesHardware(
    config.codec,
    width,
    height,
    framerate,
    options.videoBitrate || DEFAULT_VIDEO_BITRATE_BPS,
    flowController,
    encodedChunks,
    demuxedTrack,
    scaledProgress(onProgress, PROGRESS_INPUT_READ, videoEnd)
  );

  // Audio track preservation during video transcoding
  const encodedAudioChunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }> = [];
  let audioParams: ResolvedAudioParams | undefined;

  if (audioTrack && hasAudio) {
    assertAudioPlatformSupport();
    audioParams = resolveAudioParams(audioTrack, options);
    const audioCodec = targetFormat === 'webm' ? 'opus' : 'mp4a.40.2';
    await encodeAudioHardware(
      audioCodec,
      audioParams.sampleRate,
      audioParams.channels,
      options.audioBitrate || DEFAULT_AUDIO_BITRATE_BPS,
      flowController,
      encodedAudioChunks,
      audioTrack,
      scaledProgress(onProgress, PROGRESS_VIDEO_ENCODED_WITH_AUDIO, PROGRESS_ENCODED)
    );
  }

  onProgress?.(PROGRESS_MUXING);

  const finalBytes = muxFinalMedia(
    targetFormat,
    encodedChunks,
    width,
    height,
    audioParams?.sampleRate,
    audioParams?.channels,
    encodedAudioChunks,
    options.codec
  );

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
  const { sampleRate, channels } = resolveAudioParams(audioTrack, options);

  const encodedChunks: Array<{ data: Uint8Array; timestampMicros: number; isKeyFrame: boolean }> = [];
  await encodeAudioHardware(
    config.codec,
    sampleRate,
    channels,
    options.audioBitrate || DEFAULT_AUDIO_BITRATE_BPS,
    flowController,
    encodedChunks,
    audioTrack,
    scaledProgress(onProgress, PROGRESS_INPUT_READ, PROGRESS_ENCODED)
  );

  onProgress?.(PROGRESS_MUXING);

  // Audio-only targets carry no picture, so the frame size is not used.
  const finalBytes = muxFinalMedia(targetFormat, encodedChunks, 0, 0, sampleRate, channels, [], options.codec);

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
