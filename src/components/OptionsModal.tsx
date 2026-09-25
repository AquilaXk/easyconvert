'use client';

import React, { useState } from 'react';
import { Settings2, X, Sliders, Check, RotateCcw } from 'lucide-react';
import { ConversionOptions, FormatDefinition } from '@/lib/types';
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

  const isImageTarget = tgtDef?.category === 'image';
  const isPdfTarget = targetFormat.toLowerCase() === 'pdf';
  const isDataTarget = tgtDef?.category === 'data';
  const isArchiveTarget = targetFormat.toLowerCase() === 'zip';

  const handleReset = () => {
    setOptions({
      quality: 85,
      width: undefined,
      height: undefined,
      fit: 'contain',
      stripMetadata: false,
      orientation: 'portrait',
      delimiter: ',',
      compressionLevel: 6,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-950/40 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-white dark:bg-dark-surface rounded-2xl shadow-2xl border border-neutral-border dark:border-dark-border overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-neutral-border dark:border-dark-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-brand-100 dark:bg-brand-900/60 text-brand-700 dark:text-brand-300">
              <Settings2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-brand-950 dark:text-dark-text">Options</h3>
              <p className="text-xs text-ink-muted truncate max-w-xs">{filename}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink-muted hover:text-brand-950 dark:hover:text-dark-text hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Target format info pill */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-brand-50 dark:bg-dark-elevated border border-brand-200 dark:border-brand-900">
            <span className="text-xs font-medium text-ink-secondary dark:text-dark-muted">Converting format</span>
            <span className="text-xs font-bold text-brand-700 dark:text-brand-300 uppercase">
              {sourceFormat} &rarr; {targetFormat}
            </span>
          </div>

          {/* Quality Slider (Images) */}
          {(isImageTarget || targetFormat === 'jpg' || targetFormat === 'webp' || targetFormat === 'avif') && (
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
              <p className="text-[11px] text-ink-muted">
                Higher quality preserves finer details but increases the output file size.
              </p>
            </div>
          )}

          {/* Resize Controls (Images) */}
          {isImageTarget && (
            <div className="space-y-3 pt-2 border-t border-neutral-border dark:border-dark-border">
              <span className="text-xs font-semibold text-brand-950 dark:text-dark-text">Resize Dimensions (px)</span>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-ink-muted mb-1 block">Width</label>
                  <input
                    type="number"
                    min="1"
                    placeholder="Auto (preserve)"
                    value={options.width ?? ''}
                    onChange={(e) =>
                      setOptions({ ...options, width: e.target.value ? Number(e.target.value) : undefined })
                    }
                    className="w-full px-3 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text focus:ring-1 focus:ring-brand-600"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-ink-muted mb-1 block">Height</label>
                  <input
                    type="number"
                    min="1"
                    placeholder="Auto (preserve)"
                    value={options.height ?? ''}
                    onChange={(e) =>
                      setOptions({ ...options, height: e.target.value ? Number(e.target.value) : undefined })
                    }
                    className="w-full px-3 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text focus:ring-1 focus:ring-brand-600"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] text-ink-muted mb-1 block">Fit Mode</label>
                <select
                  value={options.fit || 'contain'}
                  onChange={(e) => setOptions({ ...options, fit: e.target.value as any })}
                  className="w-full px-3 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
                >
                  <option value="contain">Contain (Keep aspect ratio)</option>
                  <option value="cover">Cover (Crop to fill)</option>
                  <option value="fill">Fill (Stretch to dimensions)</option>
                  <option value="inside">Inside (Do not exceed)</option>
                </select>
              </div>

              {/* Strip metadata */}
              <label className="flex items-center gap-2 pt-1 cursor-pointer">
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

          {/* Orientation (PDF targets) */}
          {isPdfTarget && (
            <div className="space-y-2 pt-2 border-t border-neutral-border dark:border-dark-border">
              <span className="text-xs font-semibold text-brand-950 dark:text-dark-text">Page Orientation</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setOptions({ ...options, orientation: 'portrait' })}
                  className={`p-2.5 rounded-xl border text-xs font-medium transition-colors ${
                    (options.orientation || 'portrait') === 'portrait'
                      ? 'border-brand-600 bg-brand-50 dark:bg-brand-950 text-brand-700 dark:text-brand-300'
                      : 'border-neutral-border dark:border-dark-border text-ink-secondary'
                  }`}
                >
                  Portrait (Vertical)
                </button>
                <button
                  type="button"
                  onClick={() => setOptions({ ...options, orientation: 'landscape' })}
                  className={`p-2.5 rounded-xl border text-xs font-medium transition-colors ${
                    options.orientation === 'landscape'
                      ? 'border-brand-600 bg-brand-50 dark:bg-brand-950 text-brand-700 dark:text-brand-300'
                      : 'border-neutral-border dark:border-dark-border text-ink-secondary'
                  }`}
                >
                  Landscape (Horizontal)
                </button>
              </div>
            </div>
          )}

          {/* Delimiter (Data targets) */}
          {(isDataTarget || sourceFormat === 'csv' || sourceFormat === 'tsv') && (
            <div className="space-y-2 pt-2 border-t border-neutral-border dark:border-dark-border">
              <span className="text-xs font-semibold text-brand-950 dark:text-dark-text">CSV / TSV Delimiter</span>
              <select
                value={options.delimiter || ','}
                onChange={(e) => setOptions({ ...options, delimiter: e.target.value })}
                className="w-full px-3 py-1.5 text-xs bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text"
              >
                <option value=",">Comma (,)</option>
                <option value="&#9;">Tab (\t)</option>
                <option value=";">Semicolon (;)</option>
                <option value="|">Pipe (|)</option>
              </select>
            </div>
          )}

          {/* Compression Level (Archives) */}
          {isArchiveTarget && (
            <div className="space-y-2 pt-2 border-t border-neutral-border dark:border-dark-border">
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
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-neutral-scaffold/60 dark:bg-dark-scaffold/60 border-t border-neutral-border dark:border-dark-border flex items-center justify-between">
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset</span>
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
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-brand-700 hover:bg-brand-800 rounded-lg shadow-sm transition-colors"
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
