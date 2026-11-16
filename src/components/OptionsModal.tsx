'use client';

import React, { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { ConversionOptions } from '@/lib/types';
import { useModalDialog } from '@/hooks/useModalDialog';
import {
  computeVisibleSections,
  getPasswordValidationError,
  sanitizeOptionsForPair,
  startingOptionsFor,
  type VisibleOptionsSections,
} from './workbench/options/options-capabilities';
import { VectorizeOptionsSection } from './vectorize/VectorizeOptionsSection';
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
  operation?: string;
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
          canConfigurePdfOptimize={visible.canConfigurePdfOptimize}
          canConfigurePdfa={visible.canConfigurePdfa}
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

function resolveEffectiveOperation(operation: string | undefined, initialOptions: ConversionOptions): string | undefined {
  if (operation) return operation;
  if (initialOptions.pdfa !== undefined) return 'pdfa';
  return initialOptions.optimize?.profile ? 'compress' : undefined;
}

export default function OptionsModal({
  filename, sourceFormat, targetFormat, operation, initialOptions, onSave, onClose,
}: Readonly<OptionsModalProps>) {
  const t = useTranslations('options.modal');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const effectiveOperation = resolveEffectiveOperation(operation, initialOptions);
  const [options, setOptions] = useState<ConversionOptions>(() =>
    sanitizeOptionsForPair(initialOptions, sourceFormat, targetFormat)
  );

  useModalDialog(dialogRef, true, onClose);

  const visible = computeVisibleSections(sourceFormat, targetFormat, effectiveOperation);
  const targetLabel = targetFormat ? targetFormat.toUpperCase() : t('targetFallback');
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
      className="w-full max-w-2xl rounded-xs p-0 bg-surface text-ink border border-rule shadow-elev-2"
    >
      <div className="px-5 sm:px-6 py-4 border-b border-rule flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="options-modal-title" className="text-base font-semibold text-ink">
            {t('heading')}
          </h2>
          <p className="text-xs text-ink-2 mt-0.5 truncate">
            {t('subtitle', { filename, src: sourceFormat.toUpperCase(), tgt: targetLabel })}
          </p>
        </div>
        <button
          type="button"
          aria-label={t('close')}
          onClick={onClose}
          className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-xs border border-rule text-ink-3 hover:text-ink hover:border-accent transition-colors cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-5 sm:px-6 py-5 space-y-6 max-h-[70dvh] overflow-y-auto divide-y divide-rule [&>section:not(:first-child)]:pt-5">
        {visible.showVectorize && <VectorizeOptionsSection options={options} onChange={setOptions} />}
        <DocumentAndSecurityGroup visible={visible} options={options} onChange={setOptions} />
        <MediaAndDataGroup visible={visible} options={options} onChange={setOptions} />
        {!visible.hasAny && (
          <p className="text-sm text-ink-2">
            {t('noOptions')}
          </p>
        )}
      </div>

      <div className="px-5 sm:px-6 py-4 bg-sunken/50 border-t border-rule rounded-b-xs flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOptions(startingOptionsFor(effectiveOperation, sourceFormat, targetFormat))}
          className="transition-colors min-h-[44px] px-4 rounded-xs border border-rule text-sm font-medium text-ink-2 hover:text-ink hover:border-accent cursor-pointer"
        >
          {t('reset')}
        </button>
        <button
          type="button"
          disabled={hasInvalidPassword}
          onClick={handleApply}
          className="btn-primary min-h-[44px] px-5 rounded-xs text-sm font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('apply')}
        </button>
      </div>
    </dialog>
  );
}
