'use client';

import React from 'react';
import { AudioCodec, ConversionOptions } from '@/lib/types';

export interface SectionProps {
  options: ConversionOptions;
  onChange: (next: ConversionOptions) => void;
}

const INPUT_CLASS =
  'w-full min-h-[44px] px-3.5 rounded-md text-base bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border text-brand-950 dark:text-white focus:outline-none focus:border-brand-700';

const LABEL_CLASS = 'block text-xs font-semibold text-brand-950 dark:text-neutral-200 mb-1.5';

const SECTION_HEADING_CLASS =
  'text-sm font-bold text-brand-950 dark:text-white mb-4';

const FIT_VALUES: ReadonlyArray<NonNullable<ConversionOptions['fit']>> = [
  'contain',
  'cover',
  'fill',
  'inside',
  'outside',
];

const ORIENTATION_VALUES: ReadonlyArray<NonNullable<ConversionOptions['orientation']>> = [
  'portrait',
  'landscape',
];

const MARGIN_VALUES: ReadonlyArray<NonNullable<ConversionOptions['margin']>> = [
  'normal',
  'narrow',
  'wide',
];

const VIDEO_CODEC_VALUES: ReadonlyArray<NonNullable<ConversionOptions['videoCodec']>> = [
  'h264',
  'hevc',
  'vp9',
  'av1',
];

const VIDEO_FPS_VALUES: ReadonlyArray<NonNullable<ConversionOptions['videoFps']>> = [24, 30, 60];

const AUDIO_CODEC_VALUES: ReadonlyArray<AudioCodec> = [
  'aac',
  'mp3',
  'opus',
  'flac',
  'vorbis',
  'pcm_s16le',
];

const AUDIO_BITRATE_VALUES: ReadonlyArray<NonNullable<ConversionOptions['audioBitrate']>> = [
  '64k',
  '96k',
  '128k',
  '192k',
  '256k',
  '320k',
];

const AUDIO_SAMPLE_RATE_VALUES: ReadonlyArray<NonNullable<ConversionOptions['audioSampleRate']>> = [
  16000,
  22050,
  32000,
  44100,
  48000,
];

const AUDIO_CHANNEL_VALUES: ReadonlyArray<NonNullable<ConversionOptions['audioChannels']>> = [
  'mono',
  'stereo',
  '5.1',
  '7.1',
];

function parseOptionalPositiveInt(raw: string): number | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parseOptionalNonNegativeInt(raw: string): number | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function pickFromList<T extends string>(list: ReadonlyArray<T>, raw: string, fallback: T): T {
  const match = list.find((item) => item === raw);
  return match ?? fallback;
}

function TrimRangeFields({ options, onChange, prefix }: SectionProps & { prefix: string }) {
  const startId = `${prefix}-trim-start`;
  const endId = `${prefix}-trim-end`;

  const updateTrim = (field: 'start' | 'end', raw: string) => {
    const nextTrim = {
      ...(options.trim || {}),
      [field]: raw.trim() ? raw : undefined,
    };
    const hasAny = Boolean(nextTrim.start || nextTrim.end);
    onChange({
      ...options,
      trim: hasAny ? nextTrim : undefined,
    });
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label htmlFor={startId} className={LABEL_CLASS}>
          Trim Start (HH:MM:SS)
        </label>
        <input
          id={startId}
          type="text"
          value={options.trim?.start || ''}
          onChange={(e) => updateTrim('start', e.target.value)}
          placeholder="00:00:00"
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <label htmlFor={endId} className={LABEL_CLASS}>
          Trim End (HH:MM:SS)
        </label>
        <input
          id={endId}
          type="text"
          value={options.trim?.end || ''}
          onChange={(e) => updateTrim('end', e.target.value)}
          placeholder="00:01:30"
          className={INPUT_CLASS}
        />
      </div>
    </div>
  );
}

export function ImageOptionsSection({ options, onChange }: SectionProps) {
  const qualityValue = options.quality ?? 85;

  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Image &amp; Raster Parameters</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label htmlFor="opt-image-width" className={LABEL_CLASS}>
            Width (px)
          </label>
          <input
            id="opt-image-width"
            type="number"
            min={1}
            value={options.width ?? ''}
            onChange={(e) => onChange({ ...options, width: parseOptionalPositiveInt(e.target.value) })}
            placeholder="Original"
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="opt-image-height" className={LABEL_CLASS}>
            Height (px)
          </label>
          <input
            id="opt-image-height"
            type="number"
            min={1}
            value={options.height ?? ''}
            onChange={(e) => onChange({ ...options, height: parseOptionalPositiveInt(e.target.value) })}
            placeholder="Original"
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="opt-image-fit" className={LABEL_CLASS}>
            Resize Fit
          </label>
          <select
            id="opt-image-fit"
            value={options.fit || 'contain'}
            onChange={(e) =>
              onChange({ ...options, fit: pickFromList(FIT_VALUES, e.target.value, 'contain') })
            }
            className={INPUT_CLASS}
          >
            <option value="contain">Contain</option>
            <option value="cover">Cover</option>
            <option value="fill">Stretch to Fill</option>
            <option value="inside">Fit Inside</option>
            <option value="outside">Fit Outside</option>
          </select>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="opt-image-quality" className="text-xs font-semibold text-brand-950 dark:text-neutral-200">
            Compression Quality
          </label>
          <span className="text-xs font-mono text-brand-700 dark:text-brand-300">{qualityValue}%</span>
        </div>
        <input
          id="opt-image-quality"
          type="range"
          min={1}
          max={100}
          value={qualityValue}
          onChange={(e) => onChange({ ...options, quality: Number(e.target.value) })}
          className="w-full min-h-[44px] accent-[#5C6BC0] cursor-pointer"
        />
      </div>

      <div className="flex items-center gap-3 min-h-[44px]">
        <input
          id="opt-strip-metadata"
          type="checkbox"
          checked={Boolean(options.stripMetadata)}
          onChange={(e) => onChange({ ...options, stripMetadata: e.target.checked })}
          className="w-4 h-4 rounded accent-[#5C6BC0] cursor-pointer"
        />
        <label
          htmlFor="opt-strip-metadata"
          className="text-sm text-brand-950 dark:text-neutral-200 cursor-pointer select-none"
        >
          Strip EXIF, GPS, and camera metadata
        </label>
      </div>
    </section>
  );
}

export function DocumentOptionsSection({ options, onChange }: SectionProps) {
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Document &amp; Page Layout</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label htmlFor="opt-doc-pages" className={LABEL_CLASS}>
            Page Range
          </label>
          <input
            id="opt-doc-pages"
            type="text"
            value={options.pages || ''}
            onChange={(e) => onChange({ ...options, pages: e.target.value || undefined })}
            placeholder="All pages (e.g. 1-5)"
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="opt-doc-orientation" className={LABEL_CLASS}>
            Orientation
          </label>
          <select
            id="opt-doc-orientation"
            value={options.orientation || 'portrait'}
            onChange={(e) =>
              onChange({
                ...options,
                orientation: pickFromList(ORIENTATION_VALUES, e.target.value, 'portrait'),
              })
            }
            className={INPUT_CLASS}
          >
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </div>
        <div>
          <label htmlFor="opt-doc-margin" className={LABEL_CLASS}>
            Page Margins
          </label>
          <select
            id="opt-doc-margin"
            value={options.margin || 'normal'}
            onChange={(e) =>
              onChange({
                ...options,
                margin: pickFromList(MARGIN_VALUES, e.target.value, 'normal'),
              })
            }
            className={INPUT_CLASS}
          >
            <option value="normal">Normal</option>
            <option value="narrow">Narrow</option>
            <option value="wide">Wide</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3 min-h-[44px]">
        <input
          id="opt-doc-ocr"
          type="checkbox"
          checked={options.ocrEnabled !== false}
          onChange={(e) => onChange({ ...options, ocrEnabled: e.target.checked })}
          className="w-4 h-4 rounded accent-[#5C6BC0] cursor-pointer"
        />
        <label
          htmlFor="opt-doc-ocr"
          className="text-sm text-brand-950 dark:text-neutral-200 cursor-pointer select-none"
        >
          Recognize scanned text with OCR when needed
        </label>
      </div>
    </section>
  );
}

export function PasswordOptionsSection({
  options,
  onChange,
  sourceFormat,
}: SectionProps & { sourceFormat: string }) {
  return (
    <section className="space-y-2">
      <h3 className={SECTION_HEADING_CLASS}>Decryption Password</h3>
      <div>
        <label htmlFor="opt-doc-password" className={LABEL_CLASS}>
          Open Password ({sourceFormat.toUpperCase()})
        </label>
        <input
          id="opt-doc-password"
          type="password"
          autoComplete="off"
          value={options.password || ''}
          onChange={(e) => onChange({ ...options, password: e.target.value || undefined })}
          placeholder="Leave blank if file is not encrypted"
          className={INPUT_CLASS}
        />
      </div>
    </section>
  );
}

export function VideoOptionsSection({
  options,
  onChange,
  showCodec,
}: SectionProps & { showCodec: boolean }) {
  const parseFps = (raw: string): ConversionOptions['videoFps'] => {
    if (!raw) {
      return undefined;
    }
    const num = Number(raw);
    return VIDEO_FPS_VALUES.find((fps) => fps === num);
  };

  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Video Stream Parameters</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {showCodec && (
          <div>
            <label htmlFor="opt-video-codec" className={LABEL_CLASS}>
              Video Codec
            </label>
            <select
              id="opt-video-codec"
              value={options.videoCodec || 'h264'}
              onChange={(e) =>
                onChange({
                  ...options,
                  videoCodec: pickFromList(VIDEO_CODEC_VALUES, e.target.value, 'h264'),
                })
              }
              className={INPUT_CLASS}
            >
              <option value="h264">H.264 (AVC)</option>
              <option value="hevc">H.265 (HEVC)</option>
              <option value="vp9">VP9</option>
              <option value="av1">AV1</option>
            </select>
          </div>
        )}
        <div>
          <label htmlFor="opt-video-fps" className={LABEL_CLASS}>
            Frame Rate (FPS)
          </label>
          <select
            id="opt-video-fps"
            value={options.videoFps ?? ''}
            onChange={(e) => onChange({ ...options, videoFps: parseFps(e.target.value) })}
            className={INPUT_CLASS}
          >
            <option value="">Keep Source FPS</option>
            <option value="24">24 fps</option>
            <option value="30">30 fps</option>
            <option value="60">60 fps</option>
          </select>
        </div>
        <div>
          <label htmlFor="opt-video-width" className={LABEL_CLASS}>
            Max Width (px)
          </label>
          <input
            id="opt-video-width"
            type="number"
            min={16}
            value={options.width ?? ''}
            onChange={(e) => onChange({ ...options, width: parseOptionalPositiveInt(e.target.value) })}
            placeholder="Original"
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="opt-video-height" className={LABEL_CLASS}>
            Max Height (px)
          </label>
          <input
            id="opt-video-height"
            type="number"
            min={16}
            value={options.height ?? ''}
            onChange={(e) => onChange({ ...options, height: parseOptionalPositiveInt(e.target.value) })}
            placeholder="Original"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <TrimRangeFields options={options} onChange={onChange} prefix="opt-video" />
    </section>
  );
}

export function AudioOptionsSection({
  options,
  onChange,
  includeTrim,
}: SectionProps & { includeTrim: boolean }) {
  const volumeValue = options.audioVolume ?? 100;

  const parseSampleRate = (raw: string): ConversionOptions['audioSampleRate'] => {
    if (!raw) {
      return undefined;
    }
    const num = Number(raw);
    return AUDIO_SAMPLE_RATE_VALUES.find((sr) => sr === num);
  };

  const updateAudioCodec = (raw: string) => {
    if (!raw) {
      const nextAudio = { ...(options.audio || {}) };
      delete nextAudio.codec;
      onChange({
        ...options,
        audio: Object.keys(nextAudio).length > 0 ? nextAudio : undefined,
      });
      return;
    }
    const codec = pickFromList(AUDIO_CODEC_VALUES, raw, 'aac');
    onChange({
      ...options,
      audio: { ...(options.audio || {}), codec },
    });
  };

  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Audio Stream Parameters</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="opt-audio-codec" className={LABEL_CLASS}>
            Audio Codec
          </label>
          <select
            id="opt-audio-codec"
            value={options.audio?.codec || ''}
            onChange={(e) => updateAudioCodec(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">Automatic for Format</option>
            <option value="aac">AAC</option>
            <option value="mp3">MP3</option>
            <option value="opus">Opus</option>
            <option value="flac">FLAC (Lossless)</option>
            <option value="vorbis">Vorbis</option>
            <option value="pcm_s16le">PCM 16-bit</option>
          </select>
        </div>
        <div>
          <label htmlFor="opt-audio-bitrate" className={LABEL_CLASS}>
            Audio Bitrate
          </label>
          <select
            id="opt-audio-bitrate"
            value={options.audioBitrate || '192k'}
            onChange={(e) =>
              onChange({
                ...options,
                audioBitrate: pickFromList(AUDIO_BITRATE_VALUES, e.target.value, '192k'),
              })
            }
            className={INPUT_CLASS}
          >
            <option value="64k">64 kbps</option>
            <option value="96k">96 kbps</option>
            <option value="128k">128 kbps</option>
            <option value="192k">192 kbps</option>
            <option value="256k">256 kbps</option>
            <option value="320k">320 kbps</option>
          </select>
        </div>
        <div>
          <label htmlFor="opt-audio-sample-rate" className={LABEL_CLASS}>
            Sample Rate
          </label>
          <select
            id="opt-audio-sample-rate"
            value={options.audioSampleRate ?? ''}
            onChange={(e) => onChange({ ...options, audioSampleRate: parseSampleRate(e.target.value) })}
            className={INPUT_CLASS}
          >
            <option value="">Keep Source Rate</option>
            <option value="16000">16,000 Hz</option>
            <option value="22050">22,050 Hz</option>
            <option value="32000">32,000 Hz</option>
            <option value="44100">44,100 Hz</option>
            <option value="48000">48,000 Hz</option>
          </select>
        </div>
        <div>
          <label htmlFor="opt-audio-channels" className={LABEL_CLASS}>
            Channels
          </label>
          <select
            id="opt-audio-channels"
            value={options.audioChannels || ''}
            onChange={(e) =>
              onChange({
                ...options,
                audioChannels: e.target.value
                  ? pickFromList(AUDIO_CHANNEL_VALUES, e.target.value, 'stereo')
                  : undefined,
              })
            }
            className={INPUT_CLASS}
          >
            <option value="">Keep Source Channels</option>
            <option value="mono">Mono (1.0)</option>
            <option value="stereo">Stereo (2.0)</option>
            <option value="5.1">Surround (5.1)</option>
            <option value="7.1">Surround (7.1)</option>
          </select>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="opt-audio-volume" className="text-xs font-semibold text-brand-950 dark:text-neutral-200">
            Output Gain
          </label>
          <span className="text-xs font-mono text-brand-700 dark:text-brand-300">{volumeValue}%</span>
        </div>
        <input
          id="opt-audio-volume"
          type="range"
          min={0}
          max={200}
          step={5}
          value={volumeValue}
          onChange={(e) => onChange({ ...options, audioVolume: Number(e.target.value) })}
          className="w-full min-h-[44px] accent-[#5C6BC0] cursor-pointer"
        />
      </div>

      {includeTrim && <TrimRangeFields options={options} onChange={onChange} prefix="opt-audio" />}
    </section>
  );
}

export function DataOptionsSection({ options, onChange }: SectionProps) {
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Tabular &amp; Structured Data</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="opt-data-delimiter" className={LABEL_CLASS}>
            Field Delimiter
          </label>
          <select
            id="opt-data-delimiter"
            value={options.delimiter || ','}
            onChange={(e) => onChange({ ...options, delimiter: e.target.value })}
            className={INPUT_CLASS}
          >
            <option value=",">Comma (,)</option>
            <option value=";">Semicolon (;)</option>
            <option value={'\t'}>Tab (\t)</option>
            <option value="|">Pipe (|)</option>
          </select>
        </div>
        <div>
          <label htmlFor="opt-data-sheet-index" className={LABEL_CLASS}>
            Worksheet Index (0-based)
          </label>
          <input
            id="opt-data-sheet-index"
            type="number"
            min={0}
            value={options.sheetIndex ?? ''}
            onChange={(e) =>
              onChange({ ...options, sheetIndex: parseOptionalNonNegativeInt(e.target.value) })
            }
            placeholder="0 (first sheet)"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <div className="flex items-center gap-3 min-h-[44px]">
        <input
          id="opt-data-headers"
          type="checkbox"
          checked={options.hasHeaders !== false}
          onChange={(e) => onChange({ ...options, hasHeaders: e.target.checked })}
          className="w-4 h-4 rounded accent-[#5C6BC0] cursor-pointer"
        />
        <label
          htmlFor="opt-data-headers"
          className="text-sm text-brand-950 dark:text-neutral-200 cursor-pointer select-none"
        >
          First row contains column headers
        </label>
      </div>
    </section>
  );
}

export function ArchiveOptionsSection({ options, onChange }: SectionProps) {
  const level = options.compressionLevel ?? 6;

  return (
    <section className="space-y-3">
      <h3 className={SECTION_HEADING_CLASS}>Archive Compression</h3>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label
            htmlFor="opt-archive-compression"
            className="text-xs font-semibold text-brand-950 dark:text-neutral-200"
          >
            Compression Level
          </label>
          <span className="text-xs font-mono text-brand-700 dark:text-brand-300">Level {level}</span>
        </div>
        <input
          id="opt-archive-compression"
          type="range"
          min={0}
          max={9}
          step={1}
          value={level}
          onChange={(e) => onChange({ ...options, compressionLevel: Number(e.target.value) })}
          className="w-full min-h-[44px] accent-[#5C6BC0] cursor-pointer"
        />
      </div>
    </section>
  );
}
