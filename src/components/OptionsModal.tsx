'use client';

import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ConversionOptions, FormatCategory } from '@/lib/types';
import { FORMAT_REGISTRY } from '@/lib/registry';
import {
  ArchiveOptionsSection,
  AudioOptionsSection,
  DataOptionsSection,
  DocumentOptionsSection,
  ImageOptionsSection,
  PasswordOptionsSection,
  VideoOptionsSection,
} from './workbench/OptionsSections';

export interface OptionsModalProps {
  filename: string;
  sourceFormat: string;
  targetFormat: string;
  initialOptions: ConversionOptions;
  onSave: (options: ConversionOptions) => void;
  onClose: () => void;
}

const DEFAULT_OPTIONS: ConversionOptions = {
  quality: 85,
  fit: 'contain',
  stripMetadata: false,
  orientation: 'portrait',
  delimiter: ',',
  compressionLevel: 6,
};

const PASSWORD_CAPABLE_SOURCES = new Set([
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'ppt',
  'odt',
  'ods',
  'odp',
  'zip',
  '7z',
  'rar',
]);

const IMAGE_CATEGORIES: ReadonlyArray<FormatCategory> = ['image', 'vector', 'cad'];
const DOCUMENT_CATEGORIES: ReadonlyArray<FormatCategory> = ['document', 'ebook', 'presentation'];
const DATA_CATEGORIES: ReadonlyArray<FormatCategory> = ['spreadsheet', 'data'];

function inCategories(
  category: FormatCategory | undefined,
  allowed: ReadonlyArray<FormatCategory>
): boolean {
  return Boolean(category && allowed.includes(category));
}

function computeVisibleSections(sourceFormat: string, targetFormat: string) {
  const src = sourceFormat.toLowerCase();
  const tgt = (targetFormat || '').toLowerCase();
  const sourceCategory = FORMAT_REGISTRY[src]?.category;
  const targetCategory = tgt ? FORMAT_REGISTRY[tgt]?.category : undefined;

  const showVideo = targetCategory === 'video' || (sourceCategory === 'video' && tgt === 'gif');
  const showImage =
    !showVideo &&
    (inCategories(sourceCategory, IMAGE_CATEGORIES) || inCategories(targetCategory, IMAGE_CATEGORIES));
  const showDocument =
    inCategories(sourceCategory, DOCUMENT_CATEGORIES) ||
    inCategories(targetCategory, DOCUMENT_CATEGORIES) ||
    src === 'pdf' ||
    tgt === 'pdf' ||
    src === 'tiff' ||
    src === 'tif';
  const showPassword = PASSWORD_CAPABLE_SOURCES.has(src) || tgt === 'pdf';
  const showAudio =
    sourceCategory === 'audio' || targetCategory === 'audio' || targetCategory === 'video';
  const showData =
    inCategories(sourceCategory, DATA_CATEGORIES) || inCategories(targetCategory, DATA_CATEGORIES);
  const showArchive = targetCategory === 'archive';

  const hasAny =
    showImage ||
    showDocument ||
    showPassword ||
    showVideo ||
    showAudio ||
    showData ||
    showArchive;

  return {
    src,
    targetCategory,
    showImage,
    showDocument,
    showPassword,
    showVideo,
    showAudio,
    showData,
    showArchive,
    hasAny,
  };
}

export default function OptionsModal({
  filename,
  sourceFormat,
  targetFormat,
  initialOptions,
  onSave,
  onClose,
}: OptionsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<ConversionOptions>({ ...initialOptions });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  }, []);

  const visible = computeVisibleSections(sourceFormat, targetFormat);
  const targetLabel = (targetFormat || 'target').toUpperCase();

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="options-modal-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          onClose();
        }
      }}
      className="w-full max-w-2xl rounded-xl p-0 bg-white dark:bg-dark-surface text-brand-950 dark:text-white border border-neutral-border dark:border-dark-border shadow-2xl"
    >
      <div className="px-5 sm:px-6 py-4 border-b border-neutral-border dark:border-dark-border flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="options-modal-title" className="text-base font-bold text-brand-950 dark:text-white">
            Conversion Options
          </h2>
          <p className="text-xs text-ink-secondary dark:text-neutral-400 mt-0.5 truncate">
            {filename} ({sourceFormat.toUpperCase()} to {targetLabel})
          </p>
        </div>
        <button
          type="button"
          aria-label="Close options"
          onClick={onClose}
          className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md border border-neutral-border dark:border-dark-border text-ink-muted hover:text-brand-950 dark:hover:text-white hover:border-brand-700 transition-colors cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-5 sm:px-6 py-5 space-y-6 max-h-[70dvh] overflow-y-auto divide-y divide-neutral-border dark:divide-dark-border [&>section:not(:first-child)]:pt-5">
        {visible.showImage && <ImageOptionsSection options={options} onChange={setOptions} />}
        {visible.showDocument && <DocumentOptionsSection options={options} onChange={setOptions} />}
        {visible.showPassword && (
          <PasswordOptionsSection
            options={options}
            onChange={setOptions}
            sourceFormat={visible.src}
          />
        )}
        {visible.showVideo && (
          <VideoOptionsSection
            options={options}
            onChange={setOptions}
            showCodec={visible.targetCategory === 'video'}
          />
        )}
        {visible.showAudio && (
          <AudioOptionsSection
            options={options}
            onChange={setOptions}
            includeTrim={!visible.showVideo}
          />
        )}
        {visible.showData && <DataOptionsSection options={options} onChange={setOptions} />}
        {visible.showArchive && <ArchiveOptionsSection options={options} onChange={setOptions} />}
        {!visible.hasAny && (
          <p className="text-sm text-ink-secondary dark:text-neutral-300">
            Standard lossless conversion parameters apply for this format pair.
          </p>
        )}
      </div>

      <div className="px-5 sm:px-6 py-4 bg-neutral-subtle dark:bg-[#121629] border-t border-neutral-border dark:border-dark-border rounded-b-xl flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOptions({ ...DEFAULT_OPTIONS })}
          className="min-h-[44px] px-4 rounded-md border border-neutral-300 dark:border-dark-border bg-white dark:bg-dark-surface text-sm font-medium text-ink-secondary dark:text-neutral-300 hover:text-brand-950 dark:hover:text-white hover:border-brand-700 transition-colors cursor-pointer"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={() => {
            onSave(options);
            onClose();
          }}
          className="min-h-[44px] px-5 rounded-md bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white text-sm font-semibold transition-colors cursor-pointer"
        >
          Apply Options
        </button>
      </div>
    </dialog>
  );
}
