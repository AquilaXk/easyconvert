'use client';

import React, { useState } from 'react';
import {
  X,
  FileText,
  Lock,
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  Video,
  Music,
  ShieldCheck,
} from 'lucide-react';
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

  // Section open/closed state
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    pages: true,
    security: true,
    domain: true,
    privacy: true,
  });

  const toggleSection = (sec: string) => {
    setOpenSections((prev) => ({ ...prev, [sec]: !prev[sec] }));
  };

  const tgtDef = FORMAT_REGISTRY[targetFormat.toLowerCase()];

  const isAudio = tgtDef?.category === 'audio' || ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'].includes(targetFormat.toLowerCase());
  const isVideo = tgtDef?.category === 'video' || ['mp4', 'webm', 'mkv', 'avi', 'mov'].includes(targetFormat.toLowerCase());
  const isImage = tgtDef?.category === 'image';
  const isDocument = !isAudio && !isVideo && !isImage;

  const isSourcePdf = sourceFormat.toLowerCase() === 'pdf';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-4xl bg-white dark:bg-[#18191d] border border-neutral-border dark:border-neutral-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-brand-950 dark:text-white transition-colors"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-border dark:border-neutral-800 flex items-center justify-between">
          <h3 className="text-base font-bold text-brand-950 dark:text-white tracking-wide">
            Options &bull; {filename}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg border border-neutral-border dark:border-neutral-700 hover:border-brand-400 text-ink-muted hover:text-brand-950 dark:hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="divide-y divide-neutral-border dark:divide-neutral-800 overflow-y-auto">
          {/* 1. Pages Section */}
          <div className="p-6">
            <button
              type="button"
              onClick={() => toggleSection('pages')}
              className="flex items-center justify-between w-full text-left font-bold text-sm text-brand-950 dark:text-neutral-100 hover:text-brand-700 dark:hover:text-white"
            >
              <div className="flex items-center gap-2.5">
                <FileText className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                <span>Pages</span>
              </div>
              {openSections.pages ? <ChevronUp className="w-4 h-4 text-ink-muted" /> : <ChevronDown className="w-4 h-4 text-ink-muted" />}
            </button>

            {openSections.pages && (
              <div className="mt-4 space-y-2">
                <label className="text-xs font-semibold text-brand-950 dark:text-neutral-200 block">Pages</label>
                <input
                  type="text"
                  value={options.pages || ''}
                  onChange={(e) => setOptions({ ...options, pages: e.target.value })}
                  placeholder="e.g. 1-3"
                  className="w-full px-3.5 py-2 text-sm bg-neutral-50 dark:bg-neutral-950 border border-neutral-border dark:border-neutral-800 rounded-xl text-brand-950 dark:text-white focus:outline-none focus:border-brand-700"
                />
                <p className="text-xs text-ink-secondary dark:text-neutral-400">Page range to convert (e.g. 1-3).</p>
              </div>
            )}
          </div>

          {/* 2. Security Section */}
          <div className="p-6">
            <button
              type="button"
              onClick={() => toggleSection('security')}
              className="flex items-center justify-between w-full text-left font-bold text-sm text-brand-950 dark:text-neutral-100 hover:text-brand-700 dark:hover:text-white"
            >
              <div className="flex items-center gap-2.5">
                <Lock className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                <span>Security</span>
              </div>
              {openSections.security ? <ChevronUp className="w-4 h-4 text-ink-muted" /> : <ChevronDown className="w-4 h-4 text-ink-muted" />}
            </button>

            {openSections.security && (
              <div className="mt-4 space-y-2">
                <label className="text-xs font-semibold text-brand-950 dark:text-neutral-200 block">Password</label>
                <input
                  type="password"
                  value={options.password || ''}
                  onChange={(e) => setOptions({ ...options, password: e.target.value })}
                  placeholder="Optional decryption password"
                  className="w-full px-3.5 py-2 text-sm bg-neutral-50 dark:bg-neutral-950 border border-neutral-border dark:border-neutral-800 rounded-xl text-brand-950 dark:text-white focus:outline-none focus:border-brand-700"
                />
                <p className="text-xs text-ink-secondary dark:text-neutral-400">
                  Password to open the {isSourcePdf ? 'PDF' : sourceFormat.toUpperCase()} file.
                </p>
              </div>
            )}
          </div>

          {/* 3. Document Format Specific Settings */}
          {isDocument && (
            <div className="p-6">
              <button
                type="button"
                onClick={() => toggleSection('domain')}
                className="flex items-center justify-between w-full text-left font-bold text-sm text-brand-950 dark:text-neutral-100 hover:text-brand-700 dark:hover:text-white"
              >
                <div className="flex items-center gap-2.5">
                  <FileText className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                  <span>Document Settings</span>
                </div>
                {openSections.domain ? <ChevronUp className="w-4 h-4 text-ink-muted" /> : <ChevronDown className="w-4 h-4 text-ink-muted" />}
              </button>

              {openSections.domain && (
                <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-6">
                  {/* Connect Hyphens */}
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-brand-950 dark:text-neutral-200 block">Connect Hyphens</label>
                    <div className="flex items-center gap-4 text-xs text-ink-secondary dark:text-neutral-300">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="connectHyphens"
                          checked={options.preserveLayout === false}
                          onChange={() => setOptions({ ...options, preserveLayout: false })}
                          className="w-4 h-4 accent-[#5C6BC0]"
                        />
                        <span>Yes</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="connectHyphens"
                          checked={options.preserveLayout !== false}
                          onChange={() => setOptions({ ...options, preserveLayout: true })}
                          className="w-4 h-4 accent-[#5C6BC0]"
                        />
                        <span>No</span>
                      </label>
                    </div>
                    <p className="text-xs text-ink-secondary dark:text-neutral-400">Specifies whether hyphens in the PDF should be connected.</p>
                  </div>

                  {/* Prioritize Visual Appearance */}
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-brand-950 dark:text-neutral-200 block">Prioritize Visual Appearance</label>
                    <div className="flex items-center gap-4 text-xs text-ink-secondary dark:text-neutral-300">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="prioritizeVisual"
                          checked={options.preserveFonts === false}
                          onChange={() => setOptions({ ...options, preserveFonts: false })}
                          className="w-4 h-4 accent-[#5C6BC0]"
                        />
                        <span>Yes</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="prioritizeVisual"
                          checked={options.preserveFonts !== false}
                          onChange={() => setOptions({ ...options, preserveFonts: true })}
                          className="w-4 h-4 accent-[#5C6BC0]"
                        />
                        <span>No</span>
                      </label>
                    </div>
                    <p className="text-xs text-ink-secondary dark:text-neutral-400">
                      Specifies whether to prefer an exact visual replica of the PDF at the expense of preventing reflow of document paragraphs.
                    </p>
                  </div>

                  {/* OCR Images */}
                  <div className="space-y-2 sm:col-span-2">
                    <label className="text-xs font-semibold text-brand-950 dark:text-neutral-200 block">OCR Images</label>
                    <div className="flex items-center gap-4 text-xs text-ink-secondary dark:text-neutral-300">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="ocrImages"
                          checked={options.ocrEnabled !== false}
                          onChange={() => setOptions({ ...options, ocrEnabled: true })}
                          className="w-4 h-4 accent-[#5C6BC0]"
                        />
                        <span>Yes</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="ocrImages"
                          checked={options.ocrEnabled === false}
                          onChange={() => setOptions({ ...options, ocrEnabled: false })}
                          className="w-4 h-4 accent-[#5C6BC0]"
                        />
                        <span>No</span>
                      </label>
                    </div>
                    <p className="text-xs text-ink-secondary dark:text-neutral-400">
                      Specifies whether OCR will be performed on images to extract readable text.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {isImage && (
            <div className="p-6">
              <button
                type="button"
                onClick={() => toggleSection('domain')}
                className="flex items-center justify-between w-full text-left font-bold text-sm text-brand-950 dark:text-neutral-100 hover:text-brand-700 dark:hover:text-white"
              >
                <div className="flex items-center gap-2.5">
                  <ImageIcon className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                  <span>Image Settings</span>
                </div>
                {openSections.domain ? <ChevronUp className="w-4 h-4 text-ink-muted" /> : <ChevronDown className="w-4 h-4 text-ink-muted" />}
              </button>

              {openSections.domain && (
                <div className="mt-5 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-semibold text-brand-950 dark:text-neutral-200 block mb-1">Width (px)</label>
                      <input
                        type="number"
                        value={options.width || ''}
                        onChange={(e) => setOptions({ ...options, width: e.target.value ? Number(e.target.value) : undefined })}
                        placeholder="Auto"
                        className="w-full px-3.5 py-2 text-sm bg-neutral-50 dark:bg-neutral-950 border border-neutral-border dark:border-neutral-800 rounded-xl text-brand-950 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-brand-950 dark:text-neutral-200 block mb-1">Height (px)</label>
                      <input
                        type="number"
                        value={options.height || ''}
                        onChange={(e) => setOptions({ ...options, height: e.target.value ? Number(e.target.value) : undefined })}
                        placeholder="Auto"
                        className="w-full px-3.5 py-2 text-sm bg-neutral-50 dark:bg-neutral-950 border border-neutral-border dark:border-neutral-800 rounded-xl text-brand-950 dark:text-white"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs font-semibold text-brand-950 dark:text-neutral-200 mb-1">
                      <span>Quality</span>
                      <span className="font-mono text-brand-700 dark:text-brand-400">{options.quality || 85}%</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="100"
                      value={options.quality || 85}
                      onChange={(e) => setOptions({ ...options, quality: Number(e.target.value) })}
                      className="w-full accent-[#5C6BC0] cursor-pointer"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {(isAudio || isVideo) && (
            <div className="p-6">
              <button
                type="button"
                onClick={() => toggleSection('domain')}
                className="flex items-center justify-between w-full text-left font-bold text-sm text-brand-950 dark:text-neutral-100 hover:text-brand-700 dark:hover:text-white"
              >
                <div className="flex items-center gap-2.5">
                  {isVideo ? <Video className="w-4 h-4 text-brand-700 dark:text-brand-400" /> : <Music className="w-4 h-4 text-brand-700 dark:text-brand-400" />}
                  <span>{isVideo ? 'Video Settings' : 'Audio Settings'}</span>
                </div>
                {openSections.domain ? <ChevronUp className="w-4 h-4 text-ink-muted" /> : <ChevronDown className="w-4 h-4 text-ink-muted" />}
              </button>

              {openSections.domain && (
                <div className="mt-5 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-semibold text-brand-950 dark:text-neutral-200 block mb-1">Audio Bitrate</label>
                      <select
                        value={options.audioBitrate || '192k'}
                        onChange={(e) => setOptions({ ...options, audioBitrate: e.target.value as any })}
                        className="w-full px-3.5 py-2 text-sm bg-neutral-50 dark:bg-neutral-950 border border-neutral-border dark:border-neutral-800 rounded-xl text-brand-950 dark:text-white"
                      >
                        <option value="320k">320 kbps</option>
                        <option value="256k">256 kbps</option>
                        <option value="192k">192 kbps</option>
                        <option value="128k">128 kbps</option>
                      </select>
                    </div>

                    {isVideo && (
                      <div>
                        <label className="text-xs font-semibold text-brand-950 dark:text-neutral-200 block mb-1">Video Codec</label>
                        <select
                          value={options.videoCodec || 'h264'}
                          onChange={(e) => setOptions({ ...options, videoCodec: e.target.value as any })}
                          className="w-full px-3.5 py-2 text-sm bg-neutral-50 dark:bg-neutral-950 border border-neutral-border dark:border-neutral-800 rounded-xl text-brand-950 dark:text-white"
                        >
                          <option value="h264">H.264 / AVC</option>
                          <option value="hevc">H.265 / HEVC</option>
                          <option value="vp9">VP9</option>
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 4. Universal Execution & Privacy Section */}
          <div className="p-6">
            <button
              type="button"
              onClick={() => toggleSection('privacy')}
              className="flex items-center justify-between w-full text-left font-bold text-sm text-brand-950 dark:text-neutral-100 hover:text-brand-700 dark:hover:text-white"
            >
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>Execution & Privacy</span>
              </div>
              {openSections.privacy ? <ChevronUp className="w-4 h-4 text-ink-muted" /> : <ChevronDown className="w-4 h-4 text-ink-muted" />}
            </button>

            {openSections.privacy && (
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-brand-950 dark:text-neutral-200 block">
                    Client-Side Edge Mode (Zero-Data Retention)
                  </label>
                  <span className="text-[10px] px-2 py-0.5 font-bold uppercase rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                    100% Local RAM
                  </span>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 text-xs text-ink-secondary dark:text-neutral-300">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="clientEdgeMode"
                      checked={options.clientEdgeMode === undefined}
                      onChange={() => {
                        const updated = { ...options };
                        delete updated.clientEdgeMode;
                        setOptions(updated);
                      }}
                      className="w-4 h-4 accent-[#5C6BC0]"
                    />
                    <span>Adaptive Auto</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="clientEdgeMode"
                      checked={options.clientEdgeMode === true}
                      onChange={() => setOptions({ ...options, clientEdgeMode: true })}
                      className="w-4 h-4 accent-[#5C6BC0]"
                    />
                    <span>Client-Only Edge</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="clientEdgeMode"
                      checked={options.clientEdgeMode === false}
                      onChange={() => setOptions({ ...options, clientEdgeMode: false })}
                      className="w-4 h-4 accent-[#5C6BC0]"
                    />
                    <span>Server Only</span>
                  </label>
                </div>
                <p className="text-xs text-ink-secondary dark:text-neutral-400">
                  Adaptive Auto executes conversions directly inside browser memory when supported, and falls back to Zero-Retention Cloud for complex server-required formats.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer with Apply button */}
        <div className="px-6 py-4 bg-neutral-50 dark:bg-[#18191d] border-t border-neutral-border dark:border-neutral-800 flex items-center justify-end">
          <button
            type="button"
            onClick={() => {
              onSave(options);
              onClose();
            }}
            className="bg-brand-700 hover:bg-brand-800 text-white px-6 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-md shadow-brand-700/25 cursor-pointer"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
