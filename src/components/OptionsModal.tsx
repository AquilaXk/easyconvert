'use client';

import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ConversionOptions } from '@/lib/types';
import { useModalDialog } from '@/hooks/useModalDialog';
import {
  computeVisibleSections,
  DEFAULT_OPTIONS,
  getPasswordValidationError,
  sanitizeOptionsForPair,
  type VisibleOptionsSections,
} from './workbench/options/options-capabilities';
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

interface ModalSectionGroupProps {
  visible: VisibleOptionsSections;
  options: ConversionOptions;
  onChange: (next: ConversionOptions) => void;
}

function DocumentAndSecurityGroup({ visible, options, onChange }: Readonly<ModalSectionGroupProps>) {
  return (
    <>
      {visible.showImage && (
        <ImageOptionsSection options={options} onChange={onChange} targetFormat={visible.tgt} />
      )}
      {visible.showDocument && (
        <DocumentOptionsSection
          options={options}
          onChange={onChange}
          canSelectPages={visible.canSelectPages}
          canConfigureLayout={visible.canConfigureLayout}
          canConfigureOcr={visible.canConfigureOcr}
          ocrAlwaysEnabled={visible.ocrAlwaysEnabled}
        />
      )}
      {visible.passwordMode && (
        <PasswordOptionsSection
          options={options}
          onChange={onChange}
          mode={visible.passwordMode}
          sourceFormat={visible.src}
          targetFormat={visible.tgt}
        />
      )}
    </>
  );
}

function MediaAndDataGroup({ visible, options, onChange }: Readonly<ModalSectionGroupProps>) {
  return (
    <>
      {visible.showVideo && (
        <VideoOptionsSection
          options={options}
          onChange={onChange}
          showCodec={visible.showVideoCodec}
          targetFormat={visible.tgt}
        />
      )}
      {visible.showAudio && (
        <AudioOptionsSection
          options={options}
          onChange={onChange}
          includeTrim={!visible.showVideo}
          targetFormat={visible.tgt}
        />
      )}
      {visible.showData && (
        <DataOptionsSection
          options={options}
          onChange={onChange}
          canConfigureDelimiter={visible.canConfigureDelimiter}
          canConfigureSheetIndex={visible.canConfigureSheetIndex}
        />
      )}
      {visible.showArchive && <ArchiveOptionsSection options={options} onChange={onChange} />}
    </>
  );
}

export default function OptionsModal({
  filename, sourceFormat, targetFormat, initialOptions, onSave, onClose,
}: Readonly<OptionsModalProps>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<ConversionOptions>(() =>
    sanitizeOptionsForPair(initialOptions, sourceFormat, targetFormat)
  );

  useModalDialog(dialogRef, true, onClose);

  const visible = computeVisibleSections(sourceFormat, targetFormat);
  const targetLabel = (targetFormat || 'target').toUpperCase();
  const hasInvalidPassword =
    getPasswordValidationError(sourceFormat, targetFormat, options.password) !== null;

  const handleApply = () => {
    if (hasInvalidPassword) return;
    onSave(sanitizeOptionsForPair(options, sourceFormat, targetFormat));
    onClose();
  };

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
        <DocumentAndSecurityGroup visible={visible} options={options} onChange={setOptions} />
        <MediaAndDataGroup visible={visible} options={options} onChange={setOptions} />
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
          disabled={hasInvalidPassword}
          onClick={handleApply}
          className="min-h-[44px] px-5 rounded-md bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Apply Options
        </button>
      </div>
    </dialog>
  );
}
