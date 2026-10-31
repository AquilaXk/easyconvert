'use client';

import React from 'react';
import { AudioCodec, ConversionOptions } from '@/lib/types';
import {
  INPUT_CLASS,
  LABEL_CLASS,
  parseOptionalPositiveInt,
  SECTION_HEADING_CLASS,
  type SectionProps,
} from './section-primitives';
import {
  resolveAllowedVideoCodecs,
  resolveAudioCapabilities,
  sanitizeVideoOptionsForTarget,
} from './options-capabilities';

const DEFAULT_IMAGE_QUALITY: Readonly<Record<string, number>> = {
  avif: 60,
  webp: 80,
};

const FIT_OPTIONS: ReadonlyArray<{ value: NonNullable<ConversionOptions['fit']>; label: string }> = [
  { value: 'contain', label: 'Contain' },
  { value: 'cover', label: 'Cover' },
  { value: 'fill', label: 'Stretch to Fill' },
  { value: 'inside', label: 'Fit Inside' },
];

const VIDEO_CODEC_OPTIONS: ReadonlyArray<{ value: NonNullable<ConversionOptions['videoCodec']>; label: string }> = [
  { value: 'h264', label: 'H.264 (AVC)' },
  { value: 'hevc', label: 'H.265 (HEVC)' },
  { value: 'vp9', label: 'VP9' },
  { value: 'av1', label: 'AV1' },
];
const VIDEO_FPS_VALUES: ReadonlyArray<NonNullable<ConversionOptions['videoFps']>> = [24, 30, 60];

const AUDIO_CODEC_OPTIONS: ReadonlyArray<{ value: AudioCodec; label: string }> = [
  { value: 'aac', label: 'AAC' },
  { value: 'mp3', label: 'MP3' },
  { value: 'opus', label: 'Opus' },
  { value: 'flac', label: 'FLAC (Lossless)' },
  { value: 'vorbis', label: 'Vorbis' },
  { value: 'pcm_s16le', label: 'PCM 16-bit' },
];

const AUDIO_BITRATE_VALUES: ReadonlyArray<NonNullable<ConversionOptions['audioBitrate']>> = [
  '64k',
  '96k',
  '128k',
  '192k',
  '256k',
  '320k',
];
const AUDIO_CHANNEL_OPTIONS: ReadonlyArray<{ value: NonNullable<ConversionOptions['audioChannels']>; label: string }> = [
  { value: 'mono', label: 'Mono (1.0)' },
  { value: 'stereo', label: 'Stereo (2.0)' },
  { value: '5.1', label: 'Surround (5.1)' },
  { value: '7.1', label: 'Surround (7.1)' },
];

function applyVideoScaleAxis(
  options: ConversionOptions,
  axis: 'width' | 'height',
  raw: string
): ConversionOptions {
  const parsed = parseOptionalPositiveInt(raw);
  const nextW = axis === 'width' ? parsed : options.video?.scale?.width;
  const nextH = axis === 'height' ? parsed : options.video?.scale?.height;
  const nextVideo: NonNullable<ConversionOptions['video']> = { ...options.video };
  if (nextW || nextH) {
    nextVideo.scale = {
      ...(nextW ? { width: nextW } : {}),
      ...(nextH ? { height: nextH } : {}),
      fit: options.video?.scale?.fit ?? 'contain',
    };
  } else {
    delete nextVideo.scale;
  }
  return {
    ...options,
    video: Object.keys(nextVideo).length > 0 ? nextVideo : undefined,
  };
}

function buildNextAudioField(
  current: ConversionOptions['audio'],
  allowedCodecs: ReadonlyArray<AudioCodec>,
  raw: string
): ConversionOptions['audio'] {
  const nextAudio: NonNullable<ConversionOptions['audio']> = { ...current };
  const chosen = raw ? allowedCodecs.find((c) => c === raw) : undefined;
  if (chosen) {
    nextAudio.codec = chosen;
  } else {
    delete nextAudio.codec;
  }
  return Object.keys(nextAudio).length > 0 ? nextAudio : undefined;
}

function applyAudioCodecChange(
  options: ConversionOptions,
  targetFormat: string,
  raw: string
): ConversionOptions {
  const baseCaps = resolveAudioCapabilities(targetFormat);
  const nextAudio = buildNextAudioField(options.audio, baseCaps.allowedCodecs, raw);
  const nextCaps = resolveAudioCapabilities(targetFormat, nextAudio?.codec);
  const keepSampleRate =
    options.audioSampleRate !== undefined &&
    nextCaps.allowedSampleRates.includes(options.audioSampleRate);
  const keepChannels =
    options.audioChannels !== undefined &&
    nextCaps.allowedChannels.includes(options.audioChannels);
  return {
    ...options,
    audio: nextAudio,
    audioBitrate: nextCaps.canConfigureBitrate ? options.audioBitrate : undefined,
    audioSampleRate: keepSampleRate ? options.audioSampleRate : undefined,
    audioChannels: keepChannels ? options.audioChannels : undefined,
  };
}

function TrimRangeFields({ options, onChange, prefix }: Readonly<SectionProps & { prefix: string }>) {
  const startId = `${prefix}-trim-start`;
  const endId = `${prefix}-trim-end`;
  const updateTrim = (field: 'start' | 'end', raw: string) => {
    const nextTrim = { ...options.trim, [field]: raw.trim() ? raw : undefined };
    onChange({ ...options, trim: nextTrim.start || nextTrim.end ? nextTrim : undefined });
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label htmlFor={startId} className={LABEL_CLASS}>Trim Start (HH:MM:SS)</label>
        <input id={startId} type="text" value={options.trim?.start || ''} onChange={(e) => updateTrim('start', e.target.value)} placeholder="00:00:00" className={INPUT_CLASS} />
      </div>
      <div>
        <label htmlFor={endId} className={LABEL_CLASS}>Trim End (HH:MM:SS)</label>
        <input id={endId} type="text" value={options.trim?.end || ''} onChange={(e) => updateTrim('end', e.target.value)} placeholder="00:01:30" className={INPUT_CLASS} />
      </div>
    </div>
  );
}

export interface ImageOptionsSectionProps extends SectionProps {
  targetFormat: string;
}

export function ImageOptionsSection({ options, onChange, targetFormat }: Readonly<ImageOptionsSectionProps>) {
  const defaultQuality = DEFAULT_IMAGE_QUALITY[targetFormat.toLowerCase()] ?? 85;
  const effectiveQuality = options.quality ?? defaultQuality;
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Image &amp; Raster Parameters</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label htmlFor="opt-image-width" className={LABEL_CLASS}>Width (px)</label>
          <input id="opt-image-width" type="number" min={1} value={options.width ?? ''} onChange={(e) => onChange({ ...options, width: parseOptionalPositiveInt(e.target.value) })} placeholder="Original" className={INPUT_CLASS} />
        </div>
        <div>
          <label htmlFor="opt-image-height" className={LABEL_CLASS}>Height (px)</label>
          <input id="opt-image-height" type="number" min={1} value={options.height ?? ''} onChange={(e) => onChange({ ...options, height: parseOptionalPositiveInt(e.target.value) })} placeholder="Original" className={INPUT_CLASS} />
        </div>
        <div>
          <label htmlFor="opt-image-fit" className={LABEL_CLASS}>Resize Fit</label>
          <select
            id="opt-image-fit"
            value={options.fit ?? ''}
            onChange={(e) =>
              onChange({
                ...options,
                fit: e.target.value ? (e.target.value as ConversionOptions['fit']) : undefined,
              })
            }
            className={INPUT_CLASS}
          >
            <option value="">Automatic (contain when resized)</option>
            {FIT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="opt-image-quality" className="text-xs font-semibold text-brand-950 dark:text-neutral-200">Compression Quality</label>
          <span className="text-xs font-mono text-brand-700 dark:text-brand-300">{effectiveQuality}%</span>
        </div>
        <input id="opt-image-quality" type="range" min={1} max={100} value={effectiveQuality} onChange={(e) => onChange({ ...options, quality: Number(e.target.value) })} className="w-full min-h-[44px] accent-[#5C6BC0] cursor-pointer" />
      </div>
      <div className="flex items-center gap-3 min-h-[44px]">
        <input id="opt-strip-metadata" type="checkbox" checked={Boolean(options.stripMetadata)} onChange={(e) => onChange({ ...options, stripMetadata: e.target.checked ? true : undefined })} className="w-4 h-4 rounded accent-[#5C6BC0] cursor-pointer" />
        <label htmlFor="opt-strip-metadata" className="text-sm text-brand-950 dark:text-neutral-200 cursor-pointer select-none">Strip EXIF, GPS, and camera metadata</label>
      </div>
    </section>
  );
}

export interface VideoOptionsSectionProps extends SectionProps {
  showCodec: boolean;
  targetFormat: string;
}

function resolveSelectedVideoCodec(
  options: ConversionOptions,
  codecChoices: ReadonlyArray<{ value: NonNullable<ConversionOptions['videoCodec']>; label: string }>
): string {
  if (options.videoCodec) return options.videoCodec;
  const nested = options.video?.codec;
  return nested && codecChoices.some((c) => c.value === nested) ? nested : '';
}

function stripCodecBoundVideoFields(
  video: ConversionOptions['video']
): ConversionOptions['video'] {
  if (!video) return undefined;
  const next = { ...video };
  delete next.codec;
  delete next.profile;
  delete next.level;
  delete next.preset;
  return Object.keys(next).length > 0 ? next : undefined;
}

function applyVideoCodecChange(
  options: ConversionOptions,
  targetFormat: string,
  codecChoices: ReadonlyArray<{ value: NonNullable<ConversionOptions['videoCodec']>; label: string }>,
  raw: string
): ConversionOptions {
  const chosen = raw ? codecChoices.find((c) => c.value === raw)?.value : undefined;
  const sanitized = sanitizeVideoOptionsForTarget(
    {
      videoCodec: chosen,
      videoFps: options.videoFps,
      video: stripCodecBoundVideoFields(options.video),
    },
    targetFormat
  );
  return {
    ...options,
    videoCodec: sanitized.videoCodec,
    videoFps: sanitized.videoFps,
    video: sanitized.video,
  };
}

export function VideoOptionsSection({ options, onChange, showCodec, targetFormat }: Readonly<VideoOptionsSectionProps>) {
  const allowedCodecs = resolveAllowedVideoCodecs(targetFormat);
  const codecChoices = VIDEO_CODEC_OPTIONS.filter((o) => allowedCodecs.includes(o.value));
  const selectedCodec = resolveSelectedVideoCodec(options, codecChoices);
  const parseFps = (raw: string): ConversionOptions['videoFps'] =>
    raw ? VIDEO_FPS_VALUES.find((fps) => fps === Number(raw)) : undefined;
  const updateVideoScale = (axis: 'width' | 'height', raw: string) => {
    onChange(applyVideoScaleAxis(options, axis, raw));
  };

  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Video Stream Parameters</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {showCodec && codecChoices.length > 0 && (
          <div>
            <label htmlFor="opt-video-codec" className={LABEL_CLASS}>Video Codec</label>
            <select
              id="opt-video-codec"
              value={selectedCodec}
              onChange={(e) => onChange(applyVideoCodecChange(options, targetFormat, codecChoices, e.target.value))}
              className={INPUT_CLASS}
            >
              <option value="">Automatic (format default)</option>
              {codecChoices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="opt-video-fps" className={LABEL_CLASS}>Frame Rate (FPS)</label>
          <select id="opt-video-fps" value={options.videoFps ?? ''} onChange={(e) => onChange({ ...options, videoFps: parseFps(e.target.value) })} className={INPUT_CLASS}>
            <option value="">Keep Source FPS</option>
            {VIDEO_FPS_VALUES.map((fps) => <option key={fps} value={String(fps)}>{fps} fps</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="opt-video-width" className={LABEL_CLASS}>Max Width (px)</label>
          <input id="opt-video-width" type="number" min={16} value={options.video?.scale?.width ?? ''} onChange={(e) => updateVideoScale('width', e.target.value)} placeholder="Original" className={INPUT_CLASS} />
        </div>
        <div>
          <label htmlFor="opt-video-height" className={LABEL_CLASS}>Max Height (px)</label>
          <input id="opt-video-height" type="number" min={16} value={options.video?.scale?.height ?? ''} onChange={(e) => updateVideoScale('height', e.target.value)} placeholder="Original" className={INPUT_CLASS} />
        </div>
      </div>
      <TrimRangeFields options={options} onChange={onChange} prefix="opt-video" />
    </section>
  );
}

export interface AudioOptionsSectionProps extends SectionProps {
  includeTrim: boolean;
  targetFormat: string;
}

export function AudioOptionsSection({ options, onChange, includeTrim, targetFormat }: Readonly<AudioOptionsSectionProps>) {
  const volumeValue = options.audioVolume ?? 100;
  const audioCaps = resolveAudioCapabilities(targetFormat, options.audio?.codec);
  const allowedCodecChoices = AUDIO_CODEC_OPTIONS.filter((o) => audioCaps.allowedCodecs.includes(o.value));
  const allowedChannelChoices = AUDIO_CHANNEL_OPTIONS.filter((o) => audioCaps.allowedChannels.includes(o.value));
  const parseSampleRate = (raw: string): ConversionOptions['audioSampleRate'] =>
    raw ? audioCaps.allowedSampleRates.find((sr) => sr === Number(raw)) : undefined;
  const updateAudioCodec = (raw: string) => {
    onChange(applyAudioCodecChange(options, targetFormat, raw));
  };

  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Audio Stream Parameters</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {allowedCodecChoices.length > 0 && (
          <div>
            <label htmlFor="opt-audio-codec" className={LABEL_CLASS}>Audio Codec</label>
            <select id="opt-audio-codec" value={options.audio?.codec || ''} onChange={(e) => updateAudioCodec(e.target.value)} className={INPUT_CLASS}>
              <option value="">Automatic for Format</option>
              {allowedCodecChoices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
        {audioCaps.canConfigureBitrate && (
          <div>
            <label htmlFor="opt-audio-bitrate" className={LABEL_CLASS}>Audio Bitrate</label>
            <select
              id="opt-audio-bitrate"
              value={options.audioBitrate ?? ''}
              onChange={(e) =>
                onChange({
                  ...options,
                  audioBitrate: e.target.value ? AUDIO_BITRATE_VALUES.find((br) => br === e.target.value) : undefined,
                })
              }
              className={INPUT_CLASS}
            >
              <option value="">Automatic (format default)</option>
              {AUDIO_BITRATE_VALUES.map((br) => <option key={br} value={br}>{br.replace('k', ' kbps')}</option>)}
            </select>
          </div>
        )}
        {audioCaps.allowedSampleRates.length > 0 && (
          <div>
            <label htmlFor="opt-audio-sample-rate" className={LABEL_CLASS}>Sample Rate</label>
            <select id="opt-audio-sample-rate" value={options.audioSampleRate ?? ''} onChange={(e) => onChange({ ...options, audioSampleRate: parseSampleRate(e.target.value) })} className={INPUT_CLASS}>
              <option value="">Keep Source Rate</option>
              {audioCaps.allowedSampleRates.map((sr) => <option key={sr} value={String(sr)}>{sr.toLocaleString('en-US')} Hz</option>)}
            </select>
          </div>
        )}
        {audioCaps.allowedChannels.length > 0 && (
          <div>
            <label htmlFor="opt-audio-channels" className={LABEL_CLASS}>Channels</label>
            <select
              id="opt-audio-channels"
              value={options.audioChannels || ''}
              onChange={(e) =>
                onChange({
                  ...options,
                  audioChannels: e.target.value ? audioCaps.allowedChannels.find((ch) => ch === e.target.value) : undefined,
                })
              }
              className={INPUT_CLASS}
            >
              <option value="">Keep Source Channels</option>
              {allowedChannelChoices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="opt-audio-volume" className="text-xs font-semibold text-brand-950 dark:text-neutral-200">Output Gain</label>
          <span className="text-xs font-mono text-brand-700 dark:text-brand-300">{volumeValue}%</span>
        </div>
        <input
          id="opt-audio-volume"
          type="range"
          min={0}
          max={200}
          step={5}
          value={volumeValue}
          onChange={(e) => {
            const nextVol = Number(e.target.value);
            onChange({ ...options, audioVolume: nextVol === 100 ? undefined : nextVol });
          }}
          className="w-full min-h-[44px] accent-[#5C6BC0] cursor-pointer"
        />
      </div>
      {includeTrim && <TrimRangeFields options={options} onChange={onChange} prefix="opt-audio" />}
    </section>
  );
}
