'use client';

import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ConversionOptions, FormatCategory } from '@/lib/types';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { useModalDialog } from '@/hooks/useModalDialog';
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

const IMAGE_CATEGORIES: ReadonlyArray<FormatCategory> = ['image', 'vector', 'cad'];
const LAYOUT_TARGETS = new Set<string>(['document', 'presentation']);
const NON_LAYOUT_SOURCES = new Set<string>(['image', 'vector', 'cad']);
const OCR_TARGETS = new Set<string>(['txt', 'md', 'docx', 'rtf', 'html', 'searchable-pdf']);

function inCategories(
  category: FormatCategory | undefined,
  allowed: ReadonlyArray<FormatCategory>
): boolean {
  return Boolean(category && allowed.includes(category));
}

function resolvePasswordMode(src: string, tgt: string): 'archive-encrypt' | 'pdf-decrypt' | null {
  if (tgt === 'zip' || tgt === '7z') return 'archive-encrypt';
  if (src === 'pdf') return 'pdf-decrypt';
  return null;
}

function isDelimitedFormat(fmt: string): boolean {
  return (
    fmt === 'csv' ||
    fmt === 'tsv' ||
    (fmt !== 'json' && Boolean(FORMAT_REGISTRY[fmt]?.optionsSchema?.delimiter))
  );
}

const PAGE_SELECT_SOURCES = new Set<string>(['pdf', 'tiff', 'tif']);

function computeMediaCaps(
  sourceCategory: FormatCategory | undefined,
  targetCategory: FormatCategory | undefined,
  tgt: string
) {
  const showVideo = targetCategory === 'video' || (sourceCategory === 'video' && tgt === 'gif');
  const targetIsImage = inCategories(targetCategory, IMAGE_CATEGORIES);
  const sourceImageToPdf = inCategories(sourceCategory, IMAGE_CATEGORIES) && tgt === 'pdf';
  const showImage = !showVideo && (targetIsImage || sourceImageToPdf);
  const videoHasAudioSource = sourceCategory === 'video' || sourceCategory === 'audio';
  const showAudio = targetCategory === 'audio' || (targetCategory === 'video' && videoHasAudioSource);
  return { showVideo, showImage, showAudio };
}

function computeDocumentCaps(
  src: string,
  tgt: string,
  sourceCategory: FormatCategory | undefined,
  targetCategory: FormatCategory | undefined
) {
  const canSelectPages = Boolean(FORMAT_REGISTRY[src]?.optionsSchema?.pages) || PAGE_SELECT_SOURCES.has(src);
  const isLayoutTarget = tgt === 'pdf' || Boolean(targetCategory && LAYOUT_TARGETS.has(targetCategory));
  const isLayoutSource = src !== 'pdf' && !(sourceCategory && NON_LAYOUT_SOURCES.has(sourceCategory));
  const canConfigureLayout = isLayoutTarget && isLayoutSource;
  const canConfigureOcr = (src === 'pdf' || sourceCategory === 'image') && OCR_TARGETS.has(tgt);
  const showDocument = canSelectPages || canConfigureLayout || canConfigureOcr;
  return { canSelectPages, canConfigureLayout, canConfigureOcr, showDocument };
}

function computeDataCaps(
  src: string,
  tgt: string,
  sourceCategory: FormatCategory | undefined,
  targetCategory: FormatCategory | undefined
) {
  const canConfigureDelimiter = isDelimitedFormat(src) || isDelimitedFormat(tgt);
  const canConfigureSheetIndex =
    sourceCategory === 'spreadsheet' || Boolean(FORMAT_REGISTRY[src]?.optionsSchema?.sheetIndex);
  const canConfigureHeaders =
    canConfigureDelimiter || canConfigureSheetIndex || targetCategory === 'spreadsheet';
  const showData = canConfigureHeaders;
  return { canConfigureDelimiter, canConfigureSheetIndex, canConfigureHeaders, showData };
}

function computeVisibleSections(sourceFormat: string, targetFormat: string) {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  const sourceCategory = FORMAT_REGISTRY[src]?.category;
  const targetCategory = tgt ? FORMAT_REGISTRY[tgt]?.category : undefined;
  const media = computeMediaCaps(sourceCategory, targetCategory, tgt);
  const doc = computeDocumentCaps(src, tgt, sourceCategory, targetCategory);
  const data = computeDataCaps(src, tgt, sourceCategory, targetCategory);
  const passwordMode = resolvePasswordMode(src, tgt);
  const showArchive = targetCategory === 'archive' && tgt !== 'tar';
  const flags = [
    media.showImage,
    doc.showDocument,
    passwordMode !== null,
    media.showVideo,
    media.showAudio,
    data.showData,
    showArchive,
  ];
  return {
    tgt,
    targetCategory,
    ...media,
    ...doc,
    ...data,
    passwordMode,
    showArchive,
    hasAny: flags.some(Boolean),
  };
}

export default function OptionsModal({
  filename,
  sourceFormat,
  targetFormat,
  initialOptions,
  onSave,
  onClose,
}: Readonly<OptionsModalProps>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<ConversionOptions>({ ...initialOptions });

  useModalDialog(dialogRef, true, onClose);

  const visible = computeVisibleSections(sourceFormat, targetFormat);
  const targetLabel = (targetFormat || 'target').toUpperCase();

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="options-modal-title"
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
        {visible.showDocument && (
          <DocumentOptionsSection
            options={options}
            onChange={setOptions}
            canSelectPages={visible.canSelectPages}
            canConfigureLayout={visible.canConfigureLayout}
            canConfigureOcr={visible.canConfigureOcr}
          />
        )}
        {visible.passwordMode && (
          <PasswordOptionsSection
            options={options}
            onChange={setOptions}
            mode={visible.passwordMode}
            targetFormat={visible.tgt}
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
        {visible.showData && (
          <DataOptionsSection
            options={options}
            onChange={setOptions}
            canConfigureDelimiter={visible.canConfigureDelimiter}
            canConfigureSheetIndex={visible.canConfigureSheetIndex}
            canConfigureHeaders={visible.canConfigureHeaders}
          />
        )}
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
