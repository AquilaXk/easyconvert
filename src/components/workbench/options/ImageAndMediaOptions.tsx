'use client';

import React from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { AudioCodec, ConversionOptions } from '@/lib/types';
import {
  INPUT_CLASS,
  SELECT_CLASS,
  RANGE_CLASS,
  rangeFill,
  LABEL_CLASS,
  parseOptionalPositiveInt,
  SECTION_HEADING_CLASS,
  type SectionProps,
} from './section-primitives';
import {
  resolveAudioCapabilities,
  resolveSelectableVideoCodecs,
  sanitizeVideoOptionsForTarget,
  type SelectableVideoCodec,
} from './options-capabilities';

const DEFAULT_IMAGE_QUALITY: Readonly<Record<string, number>> = {
  avif: 60,
  webp: 80,
};

/** Each choice's label is `options.<group>.<key>` in the messages. */
const FIT_OPTIONS: ReadonlyArray<{ value: NonNullable<ConversionOptions['fit']>; key: 'contain' | 'cover' | 'fill' | 'inside' }> = [
  { value: 'contain', key: 'contain' },
  { value: 'cover', key: 'cover' },
  { value: 'fill', key: 'fill' },
  { value: 'inside', key: 'inside' },
];

type VideoCodecChoice = { value: SelectableVideoCodec; key: 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores' };

const VIDEO_CODEC_OPTIONS: ReadonlyArray<VideoCodecChoice> = [
  { value: 'h264', key: 'h264' },
  { value: 'hevc', key: 'hevc' },
  { value: 'vp9', key: 'vp9' },
  { value: 'av1', key: 'av1' },
  { value: 'prores', key: 'prores' },
];
const VIDEO_FPS_VALUES: ReadonlyArray<NonNullable<ConversionOptions['videoFps']>> = [24, 30, 60];

const AUDIO_CODEC_OPTIONS: ReadonlyArray<{ value: AudioCodec; key: 'aac' | 'mp3' | 'opus' | 'flac' | 'vorbis' | 'pcm' }> = [
  { value: 'aac', key: 'aac' },
  { value: 'mp3', key: 'mp3' },
  { value: 'opus', key: 'opus' },
  { value: 'flac', key: 'flac' },
  { value: 'vorbis', key: 'vorbis' },
  { value: 'pcm_s16le', key: 'pcm' },
];

const AUDIO_BITRATE_VALUES: ReadonlyArray<NonNullable<ConversionOptions['audioBitrate']>> = [
  '64k',
  '96k',
  '128k',
  '192k',
  '256k',
  '320k',
];
const AUDIO_CHANNEL_OPTIONS: ReadonlyArray<{ value: NonNullable<ConversionOptions['audioChannels']>; key: 'mono' | 'stereo' | 'surround51' | 'surround71' }> = [
  { value: 'mono', key: 'mono' },
  { value: 'stereo', key: 'stereo' },
  { value: '5.1', key: 'surround51' },
  { value: '7.1', key: 'surround71' },
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
  const t = useTranslations('options.trim');
  const startId = `${prefix}-trim-start`;
  const endId = `${prefix}-trim-end`;
  const updateTrim = (field: 'start' | 'end', raw: string) => {
    const nextTrim = { ...options.trim, [field]: raw.trim() ? raw : undefined };
    onChange({ ...options, trim: nextTrim.start || nextTrim.end ? nextTrim : undefined });
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label htmlFor={startId} className={LABEL_CLASS}>{t('start')}</label>
        <input id={startId} type="text" value={options.trim?.start || ''} onChange={(e) => updateTrim('start', e.target.value)} placeholder="00:00:00" className={INPUT_CLASS} />
      </div>
      <div>
        <label htmlFor={endId} className={LABEL_CLASS}>{t('end')}</label>
        <input id={endId} type="text" value={options.trim?.end || ''} onChange={(e) => updateTrim('end', e.target.value)} placeholder="00:01:30" className={INPUT_CLASS} />
      </div>
    </div>
  );
}

export interface ImageOptionsSectionProps extends SectionProps {
  targetFormat: string;
}

export function ImageOptionsSection({ options, onChange, targetFormat }: Readonly<ImageOptionsSectionProps>) {
  const t = useTranslations('options.image');
  const defaultQuality = DEFAULT_IMAGE_QUALITY[targetFormat.toLowerCase()] ?? 85;
  const effectiveQuality = options.quality ?? defaultQuality;
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>{t('heading')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="opt-image-width" className={LABEL_CLASS}>{t('width')}</label>
          <input id="opt-image-width" type="number" min={1} value={options.width ?? ''} onChange={(e) => onChange({ ...options, width: parseOptionalPositiveInt(e.target.value) })} placeholder={t('original')} className={INPUT_CLASS} />
        </div>
        <div>
          <label htmlFor="opt-image-height" className={LABEL_CLASS}>{t('height')}</label>
          <input id="opt-image-height" type="number" min={1} value={options.height ?? ''} onChange={(e) => onChange({ ...options, height: parseOptionalPositiveInt(e.target.value) })} placeholder={t('original')} className={INPUT_CLASS} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="opt-image-fit" className={LABEL_CLASS}>{t('fit')}</label>
          <select
            id="opt-image-fit"
            value={options.fit ?? ''}
            onChange={(e) =>
              onChange({
                ...options,
                fit: e.target.value ? (e.target.value as ConversionOptions['fit']) : undefined,
              })
            }
            className={SELECT_CLASS}
          >
            <option value="">{t('fitAuto')}</option>
            {FIT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(`fitChoices.${o.key}`)}</option>)}
          </select>
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="opt-image-quality" className="text-xs font-semibold text-ink">{t('quality')}</label>
          <span className="text-xs font-mono text-accent-ink">{effectiveQuality}%</span>
        </div>
        <input id="opt-image-quality" type="range" min={1} max={100} value={effectiveQuality} onChange={(e) => onChange({ ...options, quality: Number(e.target.value) })} className={RANGE_CLASS} style={rangeFill(effectiveQuality, 1, 100)} />
      </div>
      <div className="flex items-center gap-3 min-h-[44px]">
        <input id="opt-strip-metadata" type="checkbox" checked={Boolean(options.stripMetadata)} onChange={(e) => onChange({ ...options, stripMetadata: e.target.checked ? true : undefined })} className="size-4 cursor-pointer" />
        <label htmlFor="opt-strip-metadata" className="text-sm text-ink cursor-pointer select-none">{t('stripMetadata')}</label>
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
  codecChoices: ReadonlyArray<VideoCodecChoice>
): string {
  const active = options.video?.codec || options.videoCodec;
  return active && codecChoices.some((c) => c.value === active) ? active : '';
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
  codecChoices: ReadonlyArray<VideoCodecChoice>,
  raw: string
): ConversionOptions {
  const chosen = raw ? codecChoices.find((c) => c.value === raw)?.value : undefined;
  const strippedVideo = stripCodecBoundVideoFields(options.video);
  const nextSlice =
    chosen === 'prores'
      ? {
          videoCodec: undefined,
          videoFps: options.videoFps,
          video: { ...strippedVideo, codec: 'prores' as const },
        }
      : {
          videoCodec: chosen,
          videoFps: options.videoFps,
          video: strippedVideo,
        };
  const sanitized = sanitizeVideoOptionsForTarget(nextSlice, targetFormat);
  return {
    ...options,
    videoCodec: sanitized.videoCodec,
    videoFps: sanitized.videoFps,
    video: sanitized.video,
  };
}

export function VideoOptionsSection({ options, onChange, showCodec, targetFormat }: Readonly<VideoOptionsSectionProps>) {
  const t = useTranslations('options.video');
  const allowedCodecs = resolveSelectableVideoCodecs(targetFormat);
  const codecChoices = VIDEO_CODEC_OPTIONS.filter((o) => allowedCodecs.includes(o.value));
  const selectedCodec = resolveSelectedVideoCodec(options, codecChoices);
  const parseFps = (raw: string): ConversionOptions['videoFps'] =>
    raw ? VIDEO_FPS_VALUES.find((fps) => fps === Number(raw)) : undefined;
  const updateVideoScale = (axis: 'width' | 'height', raw: string) => {
    onChange(applyVideoScaleAxis(options, axis, raw));
  };

  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>{t('heading')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {showCodec && codecChoices.length > 0 && (
          <div>
            <label htmlFor="opt-video-codec" className={LABEL_CLASS}>{t('codec')}</label>
            <select
              id="opt-video-codec"
              value={selectedCodec}
              onChange={(e) => onChange(applyVideoCodecChange(options, targetFormat, codecChoices, e.target.value))}
              className={SELECT_CLASS}
            >
              <option value="">{t('codecAuto')}</option>
              {codecChoices.map((o) => <option key={o.value} value={o.value}>{t(`codecs.${o.key}`)}</option>)}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="opt-video-fps" className={LABEL_CLASS}>{t('fps')}</label>
          <select id="opt-video-fps" value={options.videoFps ?? ''} onChange={(e) => onChange({ ...options, videoFps: parseFps(e.target.value) })} className={SELECT_CLASS}>
            <option value="">{t('fpsKeep')}</option>
            {VIDEO_FPS_VALUES.map((fps) => <option key={fps} value={String(fps)}>{t('fpsValue', { fps })}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="opt-video-width" className={LABEL_CLASS}>{t('maxWidth')}</label>
          <input id="opt-video-width" type="number" min={16} value={options.video?.scale?.width ?? ''} onChange={(e) => updateVideoScale('width', e.target.value)} placeholder={t('original')} className={INPUT_CLASS} />
        </div>
        <div>
          <label htmlFor="opt-video-height" className={LABEL_CLASS}>{t('maxHeight')}</label>
          <input id="opt-video-height" type="number" min={16} value={options.video?.scale?.height ?? ''} onChange={(e) => updateVideoScale('height', e.target.value)} placeholder={t('original')} className={INPUT_CLASS} />
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
  const t = useTranslations('options.audio');
  const format = useFormatter();
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
      <h3 className={SECTION_HEADING_CLASS}>{t('heading')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {allowedCodecChoices.length > 0 && (
          <div>
            <label htmlFor="opt-audio-codec" className={LABEL_CLASS}>{t('codec')}</label>
            <select id="opt-audio-codec" value={options.audio?.codec || ''} onChange={(e) => updateAudioCodec(e.target.value)} className={SELECT_CLASS}>
              <option value="">{t('codecAuto')}</option>
              {allowedCodecChoices.map((o) => <option key={o.value} value={o.value}>{t(`codecs.${o.key}`)}</option>)}
            </select>
          </div>
        )}
        {audioCaps.canConfigureBitrate && (
          <div>
            <label htmlFor="opt-audio-bitrate" className={LABEL_CLASS}>{t('bitrate')}</label>
            <select
              id="opt-audio-bitrate"
              value={options.audioBitrate ?? ''}
              onChange={(e) =>
                onChange({
                  ...options,
                  audioBitrate: e.target.value ? AUDIO_BITRATE_VALUES.find((br) => br === e.target.value) : undefined,
                })
              }
              className={SELECT_CLASS}
            >
              <option value="">{t('bitrateAuto')}</option>
              {AUDIO_BITRATE_VALUES.map((br) => <option key={br} value={br}>{t('kbps', { value: Number.parseInt(br, 10) })}</option>)}
            </select>
          </div>
        )}
        {audioCaps.allowedSampleRates.length > 0 && (
          <div>
            <label htmlFor="opt-audio-sample-rate" className={LABEL_CLASS}>{t('sampleRate')}</label>
            <select id="opt-audio-sample-rate" value={options.audioSampleRate ?? ''} onChange={(e) => onChange({ ...options, audioSampleRate: parseSampleRate(e.target.value) })} className={SELECT_CLASS}>
              <option value="">{t('sampleRateKeep')}</option>
              {audioCaps.allowedSampleRates.map((sr) => <option key={sr} value={String(sr)}>{t('hertz', { value: format.number(sr) })}</option>)}
            </select>
          </div>
        )}
        {audioCaps.allowedChannels.length > 0 && (
          <div>
            <label htmlFor="opt-audio-channels" className={LABEL_CLASS}>{t('channels')}</label>
            <select
              id="opt-audio-channels"
              value={options.audioChannels || ''}
              onChange={(e) =>
                onChange({
                  ...options,
                  audioChannels: e.target.value ? audioCaps.allowedChannels.find((ch) => ch === e.target.value) : undefined,
                })
              }
              className={SELECT_CLASS}
            >
              <option value="">{t('channelsKeep')}</option>
              {allowedChannelChoices.map((o) => <option key={o.value} value={o.value}>{t(`channelChoices.${o.key}`)}</option>)}
            </select>
          </div>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="opt-audio-volume" className="text-xs font-semibold text-ink">{t('gain')}</label>
          <span className="text-xs font-mono text-accent-ink">{volumeValue}%</span>
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
          className={RANGE_CLASS}
          style={rangeFill(volumeValue, 0, 200)}
        />
      </div>
      {includeTrim && <TrimRangeFields options={options} onChange={onChange} prefix="opt-audio" />}
    </section>
  );
}
