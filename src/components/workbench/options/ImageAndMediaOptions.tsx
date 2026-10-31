'use client';

import React from 'react';
import { AudioCodec, ConversionOptions } from '@/lib/types';
import {
  INPUT_CLASS,
  LABEL_CLASS,
  parseOptionalPositiveInt,
  pickFromList,
  SECTION_HEADING_CLASS,
  SectionProps,
} from '../OptionsSections';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { isLosslessAudioTarget } from './options-capabilities';

const AUDIO_CODECS_BY_TARGET: Readonly<Record<string, ReadonlyArray<AudioCodec>>> = {
  webm: ['opus', 'vorbis'],
  weba: ['opus', 'vorbis'],
  ogg: ['vorbis', 'opus', 'flac'],
  oga: ['vorbis', 'opus', 'flac'],
  mp4: ['aac', 'mp3', 'opus', 'flac', 'pcm_s16le'],
  mov: ['aac', 'mp3', 'opus', 'flac', 'pcm_s16le'],
};

function resolveAllowedAudioCodecs(targetFormat: string): ReadonlyArray<{ value: AudioCodec; label: string }> {
  const tgt = targetFormat.toLowerCase();
  const mapped = AUDIO_CODECS_BY_TARGET[tgt];
  if (mapped) return AUDIO_CODEC_OPTIONS.filter((o) => mapped.includes(o.value));
  return FORMAT_REGISTRY[tgt]?.category === 'video' ? AUDIO_CODEC_OPTIONS : [];
}

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
const AUDIO_CODEC_VALUES = AUDIO_CODEC_OPTIONS.map((o) => o.value);

const AUDIO_BITRATE_VALUES: ReadonlyArray<NonNullable<ConversionOptions['audioBitrate']>> = [
  '64k', '96k', '128k', '192k', '256k', '320k',
];
const AUDIO_SAMPLE_RATE_VALUES: ReadonlyArray<NonNullable<ConversionOptions['audioSampleRate']>> = [
  16000, 22050, 32000, 44100, 48000,
];
const AUDIO_CHANNEL_OPTIONS: ReadonlyArray<{ value: NonNullable<ConversionOptions['audioChannels']>; label: string }> = [
  { value: 'mono', label: 'Mono (1.0)' },
  { value: 'stereo', label: 'Stereo (2.0)' },
  { value: '5.1', label: 'Surround (5.1)' },
  { value: '7.1', label: 'Surround (7.1)' },
];
const AUDIO_CHANNEL_VALUES = AUDIO_CHANNEL_OPTIONS.map((o) => o.value);

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
        <input id="opt-strip-metadata" type="checkbox" checked={Boolean(options.stripMetadata)} onChange={(e) => onChange({ ...options, stripMetadata: e.target.checked })} className="w-4 h-4 rounded accent-[#5C6BC0] cursor-pointer" />
        <label htmlFor="opt-strip-metadata" className="text-sm text-brand-950 dark:text-neutral-200 cursor-pointer select-none">Strip EXIF, GPS, and camera metadata</label>
      </div>
    </section>
  );
}

export interface VideoOptionsSectionProps extends SectionProps {
  showCodec: boolean;
  targetFormat: string;
}

export function VideoOptionsSection({ options, onChange, showCodec, targetFormat }: Readonly<VideoOptionsSectionProps>) {
  const codecChoices =
    targetFormat.toLowerCase() === 'webm'
      ? VIDEO_CODEC_OPTIONS.filter((o) => o.value === 'vp9' || o.value === 'av1')
      : VIDEO_CODEC_OPTIONS;
  const parseFps = (raw: string): ConversionOptions['videoFps'] =>
    raw ? VIDEO_FPS_VALUES.find((fps) => fps === Number(raw)) : undefined;

  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Video Stream Parameters</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {showCodec && (
          <div>
            <label htmlFor="opt-video-codec" className={LABEL_CLASS}>Video Codec</label>
            <select
              id="opt-video-codec"
              value={options.videoCodec ?? ''}
              onChange={(e) =>
                onChange({
                  ...options,
                  videoCodec: e.target.value ? (e.target.value as ConversionOptions['videoCodec']) : undefined,
                })
              }
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
          <input id="opt-video-width" type="number" min={16} value={options.width ?? ''} onChange={(e) => onChange({ ...options, width: parseOptionalPositiveInt(e.target.value) })} placeholder="Original" className={INPUT_CLASS} />
        </div>
        <div>
          <label htmlFor="opt-video-height" className={LABEL_CLASS}>Max Height (px)</label>
          <input id="opt-video-height" type="number" min={16} value={options.height ?? ''} onChange={(e) => onChange({ ...options, height: parseOptionalPositiveInt(e.target.value) })} placeholder="Original" className={INPUT_CLASS} />
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
  const losslessTarget = isLosslessAudioTarget(targetFormat);
  const allowedAudioCodecs = resolveAllowedAudioCodecs(targetFormat);
  const parseSampleRate = (raw: string): ConversionOptions['audioSampleRate'] =>
    raw ? AUDIO_SAMPLE_RATE_VALUES.find((sr) => sr === Number(raw)) : undefined;

  const updateAudioCodec = (raw: string) => {
    if (!raw) {
      const nextAudio = { ...options.audio };
      delete nextAudio.codec;
      onChange({ ...options, audio: Object.keys(nextAudio).length > 0 ? nextAudio : undefined });
      return;
    }
    onChange({ ...options, audio: { ...options.audio, codec: pickFromList(AUDIO_CODEC_VALUES, raw, 'aac') } });
  };

  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Audio Stream Parameters</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {allowedAudioCodecs.length > 0 && (
          <div>
            <label htmlFor="opt-audio-codec" className={LABEL_CLASS}>Audio Codec</label>
            <select id="opt-audio-codec" value={options.audio?.codec || ''} onChange={(e) => updateAudioCodec(e.target.value)} className={INPUT_CLASS}>
              <option value="">Automatic for Format</option>
              {allowedAudioCodecs.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
        {!losslessTarget && (
          <div>
            <label htmlFor="opt-audio-bitrate" className={LABEL_CLASS}>Audio Bitrate</label>
            <select
              id="opt-audio-bitrate"
              value={options.audioBitrate ?? ''}
              onChange={(e) =>
                onChange({
                  ...options,
                  audioBitrate: e.target.value ? (e.target.value as ConversionOptions['audioBitrate']) : undefined,
                })
              }
              className={INPUT_CLASS}
            >
              <option value="">Automatic (format default)</option>
              {AUDIO_BITRATE_VALUES.map((br) => <option key={br} value={br}>{br.replace('k', ' kbps')}</option>)}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="opt-audio-sample-rate" className={LABEL_CLASS}>Sample Rate</label>
          <select id="opt-audio-sample-rate" value={options.audioSampleRate ?? ''} onChange={(e) => onChange({ ...options, audioSampleRate: parseSampleRate(e.target.value) })} className={INPUT_CLASS}>
            <option value="">Keep Source Rate</option>
            {AUDIO_SAMPLE_RATE_VALUES.map((sr) => <option key={sr} value={String(sr)}>{sr.toLocaleString('en-US')} Hz</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="opt-audio-channels" className={LABEL_CLASS}>Channels</label>
          <select id="opt-audio-channels" value={options.audioChannels || ''} onChange={(e) => onChange({ ...options, audioChannels: e.target.value ? pickFromList(AUDIO_CHANNEL_VALUES, e.target.value, 'stereo') : undefined })} className={INPUT_CLASS}>
            <option value="">Keep Source Channels</option>
            {AUDIO_CHANNEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="opt-audio-volume" className="text-xs font-semibold text-brand-950 dark:text-neutral-200">Output Gain</label>
          <span className="text-xs font-mono text-brand-700 dark:text-brand-300">{volumeValue}%</span>
        </div>
        <input id="opt-audio-volume" type="range" min={0} max={200} step={5} value={volumeValue} onChange={(e) => onChange({ ...options, audioVolume: Number(e.target.value) })} className="w-full min-h-[44px] accent-[#5C6BC0] cursor-pointer" />
      </div>
      {includeTrim && <TrimRangeFields options={options} onChange={onChange} prefix="opt-audio" />}
    </section>
  );
}
