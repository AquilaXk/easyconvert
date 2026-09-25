'use client';

import React, { useState } from 'react';
import { Settings2, X, RotateCcw, Check } from 'lucide-react';
import { ConversionOptions } from '@/lib/types';
import { FORMAT_REGISTRY } from '@/lib/registry';

interface OptionsModalProps {
  filename: string;
  sourceFormat: string;
  targetFormat: string;
  initialOptions: ConversionOptions;
  onSave: (options: ConversionOptions) => void;
  onClose: () => void;
}

export default function OptionsModal({
  filename,
  sourceFormat,
  targetFormat,
  initialOptions,
  onSave,
  onClose,
}: OptionsModalProps) {
  const [options, setOptions] = useState<ConversionOptions>({ ...initialOptions });

  const srcDef = FORMAT_REGISTRY[sourceFormat.toLowerCase()];
  const tgtDef = FORMAT_REGISTRY[targetFormat.toLowerCase()];

  const isAudio = tgtDef?.category === 'audio' || ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma', 'opus'].includes(targetFormat.toLowerCase());
  const isVideo = tgtDef?.category === 'video' || ['mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv'].includes(targetFormat.toLowerCase());
  const isImage = tgtDef?.category === 'image';
  const isDocument = tgtDef?.category === 'document' || tgtDef?.category === 'ebook' || tgtDef?.category === 'presentation' || ['pdf', 'docx', 'doc', 'epub', 'txt', 'html', 'md'].includes(targetFormat.toLowerCase());
  const isSpreadsheet = tgtDef?.category === 'spreadsheet' || tgtDef?.category === 'data' || ['csv', 'tsv', 'xlsx', 'xls', 'json'].includes(targetFormat.toLowerCase());
  const isArchive = tgtDef?.category === 'archive' || ['zip', 'tar', 'gz', '7z'].includes(targetFormat.toLowerCase());

  const handleReset = () => {
    setOptions({
      quality: 85,
      width: undefined,
      height: undefined,
      fit: 'contain',
      stripMetadata: false,
      orientation: 'portrait',
      preserveLayout: true,
      preserveFonts: true,
      preserveTables: true,
      ocrEnabled: false,
      ocrLanguage: 'auto',
      margin: 'normal',
      delimiter: ',',
      hasHeaders: true,
      compressionLevel: 6,
      audioBitrate: '192k',
      audioChannels: 'stereo',
      audioSampleRate: 44100,
      audioVolume: 100,
      videoResolution: 'original',
      videoFps: 30,
      videoCodec: 'h264',
      aspectRatio: 'original',
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-950/50 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-white dark:bg-dark-surface rounded-2xl shadow-2xl border border-neutral-border dark:border-dark-border overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-neutral-border dark:border-dark-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-300">
              <Settings2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-brand-950 dark:text-dark-text">Conversion Parameters</h3>
              <p className="text-xs text-ink-muted truncate max-w-xs">{filename}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-ink-muted hover:text-brand-950 dark:hover:text-dark-text hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 overflow-y-auto">
          {/* Format Info Pill */}
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border">
            <span className="text-xs text-ink-secondary dark:text-dark-muted font-medium">Pipeline:</span>
            <span className="text-xs font-bold text-brand-700 dark:text-brand-400 uppercase">
              {sourceFormat} &rarr; {targetFormat}
            </span>
          </div>

          {/* 1. AUDIO OPTIONS */}
          {isAudio && (
            <div className="space-y-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text">
                Audio Processing
              </h4>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold text-ink-muted block mb-1">Bitrate</label>
                  <select
                    value={options.audioBitrate || '192k'}
                    onChange={(e) => setOptions({ ...options, audioBitrate: e.target.value as any })}
                    className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                  >
                    <option value="320k">320 kbps (High Fidelity)</option>
                    <option value="256k">256 kbps (Studio)</option>
                    <option value="192k">192 kbps (Standard)</option>
                    <option value="128k">128 kbps (Voice/Web)</option>
                    <option value="96k">96 kbps (Compact)</option>
                    <option value="64k">64 kbps (Low)</option>
                  </select>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-ink-muted block mb-1">Channels</label>
                  <select
                    value={options.audioChannels || 'stereo'}
                    onChange={(e) => setOptions({ ...options, audioChannels: e.target.value as any })}
                    className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                  >
                    <option value="stereo">Stereo (2 Channels)</option>
                    <option value="mono">Mono (1 Channel)</option>
                    <option value="5.1">5.1 Surround Sound</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold text-ink-muted block mb-1">Sample Rate</label>
                  <select
                    value={options.audioSampleRate || 44100}
                    onChange={(e) => setOptions({ ...options, audioSampleRate: Number(e.target.value) as any })}
                    className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                  >
                    <option value={48000}>48,000 Hz (Video Broadcast)</option>
                    <option value={44100}>44,100 Hz (Audio CD Standard)</option>
                    <option value={32000}>32,000 Hz</option>
                    <option value={22050}>22,050 Hz</option>
                  </select>
                </div>

                <div>
                  <div className="flex items-center justify-between text-[11px] font-semibold text-ink-muted mb-1">
                    <span>Volume</span>
                    <span className="font-mono text-brand-700 dark:text-brand-400">{options.audioVolume ?? 100}%</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="200"
                    step="5"
                    value={options.audioVolume ?? 100}
                    onChange={(e) => setOptions({ ...options, audioVolume: Number(e.target.value) })}
                    className="w-full accent-brand-700 cursor-pointer h-1.5 bg-neutral-subtle dark:bg-dark-elevated rounded-lg mt-2"
                  />
                </div>
              </div>
            </div>
          )}

          {/* 2. VIDEO OPTIONS */}
          {isVideo && (
            <div className="space-y-4 pt-2 border-t border-neutral-border dark:border-dark-border">
              <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text">
                Video Parameters
              </h4>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold text-ink-muted block mb-1">Resolution</label>
                  <select
                    value={options.videoResolution || 'original'}
                    onChange={(e) => setOptions({ ...options, videoResolution: e.target.value as any })}
                    className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                  >
                    <option value="original">Original Resolution</option>
                    <option value="4k">4K Ultra HD (3840×2160)</option>
                    <option value="1080p">1080p Full HD (1920×1080)</option>
                    <option value="720p">720p HD (1280×720)</option>
                    <option value="480p">480p SD (854×480)</option>
                  </select>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-ink-muted block mb-1">Video Codec</label>
                  <select
                    value={options.videoCodec || 'h264'}
                    onChange={(e) => setOptions({ ...options, videoCodec: e.target.value as any })}
                    className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                  >
                    <option value="h264">H.264 / AVC (Broadest Compatibility)</option>
                    <option value="hevc">H.265 / HEVC (High Efficiency)</option>
                    <option value="vp9">VP9 (Web Streaming)</option>
                    <option value="av1">AV1 (Next-Gen Open Standard)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold text-ink-muted block mb-1">Frame Rate (FPS)</label>
                  <select
                    value={options.videoFps || 30}
                    onChange={(e) => setOptions({ ...options, videoFps: Number(e.target.value) as any })}
                    className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                  >
                    <option value={60}>60 fps (Smooth Motion)</option>
                    <option value={30}>30 fps (Standard)</option>
                    <option value={24}>24 fps (Cinematic Film)</option>
                  </select>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-ink-muted block mb-1">Aspect Ratio</label>
                  <select
                    value={options.aspectRatio || 'original'}
                    onChange={(e) => setOptions({ ...options, aspectRatio: e.target.value as any })}
                    className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                  >
                    <option value="original">Original Aspect Ratio</option>
                    <option value="16:9">16:9 Widescreen</option>
                    <option value="4:3">4:3 Standard</option>
                    <option value="1:1">1:1 Square</option>
                    <option value="9:16">9:16 Vertical Story</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* 3. DOCUMENT, OFFICE & OCR OPTIONS */}
          {isDocument && (
            <div className="space-y-4 pt-2 border-t border-neutral-border dark:border-dark-border">
              <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text">
                Document & Office Formatting
              </h4>

              <div className="space-y-2.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={options.preserveLayout ?? true}
                    onChange={(e) => setOptions({ ...options, preserveLayout: e.target.checked })}
                    className="w-4 h-4 rounded text-brand-700 accent-brand-700"
                  />
                  <div>
                    <span className="text-xs font-semibold text-brand-950 dark:text-dark-text block">
                      Preserve Styles, Fonts & Headings
                    </span>
                    <span className="text-[11px] text-ink-muted">
                      Retains typography hierarchy, bold, italic, and heading structure.
                    </span>
                  </div>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={options.preserveTables ?? true}
                    onChange={(e) => setOptions({ ...options, preserveTables: e.target.checked })}
                    className="w-4 h-4 rounded text-brand-700 accent-brand-700"
                  />
                  <div>
                    <span className="text-xs font-semibold text-brand-950 dark:text-dark-text block">
                      Preserve Tables & Grids
                    </span>
                    <span className="text-[11px] text-ink-muted">
                      Converts structured tabular cells with borders and alignments intact.
                    </span>
                  </div>
                </label>

                {/* Scanned PDF OCR Recognition */}
                <div className="p-3 rounded-xl bg-brand-50/70 dark:bg-brand-950/40 border border-brand-200 dark:border-brand-900 space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={options.ocrEnabled ?? false}
                      onChange={(e) => setOptions({ ...options, ocrEnabled: e.target.checked })}
                      className="w-4 h-4 rounded text-brand-700 accent-brand-700"
                    />
                    <div>
                      <span className="text-xs font-bold text-brand-950 dark:text-dark-text block">
                        Optical Character Recognition (OCR)
                      </span>
                      <span className="text-[11px] text-ink-muted">
                        Recognize text inside scanned documents and raster images.
                      </span>
                    </div>
                  </label>

                  {options.ocrEnabled && (
                    <div className="pt-2">
                      <label className="text-[11px] font-semibold text-ink-muted block mb-1">OCR Language</label>
                      <select
                        value={options.ocrLanguage || 'auto'}
                        onChange={(e) => setOptions({ ...options, ocrLanguage: e.target.value as any })}
                        className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                      >
                        <option value="auto">Automatic Language Detection</option>
                        <option value="en">English</option>
                        <option value="ko">Korean (한국어)</option>
                        <option value="de">German (Deutsch)</option>
                        <option value="fr">French (Français)</option>
                        <option value="es">Spanish (Español)</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>

              {/* Page Orientation */}
              <div>
                <label className="text-[11px] font-semibold text-ink-muted block mb-1">Page Orientation</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setOptions({ ...options, orientation: 'portrait' })}
                    className={`py-2 px-3 rounded-lg text-xs font-semibold border transition-colors ${
                      (options.orientation || 'portrait') === 'portrait'
                        ? 'border-brand-700 bg-brand-50 dark:bg-brand-950 text-brand-700 dark:text-brand-300'
                        : 'border-neutral-border dark:border-dark-border text-ink-secondary'
                    }`}
                  >
                    Portrait (Vertical)
                  </button>
                  <button
                    type="button"
                    onClick={() => setOptions({ ...options, orientation: 'landscape' })}
                    className={`py-2 px-3 rounded-lg text-xs font-semibold border transition-colors ${
                      options.orientation === 'landscape'
                        ? 'border-brand-700 bg-brand-50 dark:bg-brand-950 text-brand-700 dark:text-brand-300'
                        : 'border-neutral-border dark:border-dark-border text-ink-secondary'
                    }`}
                  >
                    Landscape (Horizontal)
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 4. IMAGE OPTIONS */}
          {isImage && (
            <div className="space-y-4 pt-2 border-t border-neutral-border dark:border-dark-border">
              <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text">
                Image Parameters
              </h4>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-brand-950 dark:text-dark-text">Image Quality</span>
                  <span className="font-mono font-bold text-brand-700 dark:text-brand-400">
                    {options.quality ?? 85}%
                  </span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={options.quality ?? 85}
                  onChange={(e) => setOptions({ ...options, quality: Number(e.target.value) })}
                  className="w-full accent-brand-700 cursor-pointer h-1.5 bg-neutral-subtle dark:bg-dark-elevated rounded-lg"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold text-ink-muted block mb-1">Width (px)</label>
                  <input
                    type="number"
                    min="1"
                    placeholder="Auto (preserve)"
                    value={options.width ?? ''}
                    onChange={(e) =>
                      setOptions({ ...options, width: e.target.value ? Number(e.target.value) : undefined })
                    }
                    className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-ink-muted block mb-1">Height (px)</label>
                  <input
                    type="number"
                    min="1"
                    placeholder="Auto (preserve)"
                    value={options.height ?? ''}
                    onChange={(e) =>
                      setOptions({ ...options, height: e.target.value ? Number(e.target.value) : undefined })
                    }
                    className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-ink-muted block mb-1">Fit Mode</label>
                <select
                  value={options.fit || 'contain'}
                  onChange={(e) => setOptions({ ...options, fit: e.target.value as any })}
                  className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                >
                  <option value="contain">Contain (Preserve aspect ratio)</option>
                  <option value="cover">Cover (Crop to fill)</option>
                  <option value="fill">Fill (Stretch exact dimensions)</option>
                  <option value="inside">Inside (Do not exceed)</option>
                </select>
              </div>

              <label className="flex items-center gap-2 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={options.stripMetadata ?? false}
                  onChange={(e) => setOptions({ ...options, stripMetadata: e.target.checked })}
                  className="w-4 h-4 rounded text-brand-700 accent-brand-700"
                />
                <span className="text-xs text-brand-950 dark:text-dark-text">Strip EXIF / Privacy Metadata</span>
              </label>
            </div>
          )}

          {/* 5. SPREADSHEET OPTIONS */}
          {isSpreadsheet && (
            <div className="space-y-3 pt-2 border-t border-neutral-border dark:border-dark-border">
              <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text">
                Spreadsheet & Tables
              </h4>

              <div>
                <label className="text-[11px] font-semibold text-ink-muted block mb-1">Delimiter (CSV/TSV)</label>
                <select
                  value={options.delimiter || ','}
                  onChange={(e) => setOptions({ ...options, delimiter: e.target.value })}
                  className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                >
                  <option value=",">Comma (,)</option>
                  <option value="&#9;">Tab (\t)</option>
                  <option value=";">Semicolon (;)</option>
                  <option value="|">Pipe (|)</option>
                </select>
              </div>
            </div>
          )}

          {/* 6. ARCHIVE OPTIONS */}
          {isArchive && (
            <div className="space-y-3 pt-2 border-t border-neutral-border dark:border-dark-border">
              <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text">
                Archive Compression
              </h4>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-brand-950 dark:text-dark-text">Compression Level</span>
                  <span className="font-mono font-bold text-brand-700 dark:text-brand-400">
                    {options.compressionLevel ?? 6} / 9
                  </span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="9"
                  value={options.compressionLevel ?? 6}
                  onChange={(e) => setOptions({ ...options, compressionLevel: Number(e.target.value) })}
                  className="w-full accent-brand-700 cursor-pointer h-1.5 bg-neutral-subtle dark:bg-dark-elevated rounded-lg"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-neutral-scaffold/70 dark:bg-dark-scaffold/70 border-t border-neutral-border dark:border-dark-border flex items-center justify-between">
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Defaults</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-semibold text-ink-secondary dark:text-dark-muted hover:bg-neutral-subtle dark:hover:bg-dark-elevated rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onSave(options);
                onClose();
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold text-white bg-brand-700 hover:bg-brand-800 rounded-lg shadow-sm transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Apply Options</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
