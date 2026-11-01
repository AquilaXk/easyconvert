'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import {
  Archive, BookOpen, ChevronDown, Compass, Database, Download,
  FileImage, FileText, Music, Presentation, Sliders, Type, Video, X, type LucideIcon,
} from 'lucide-react';
import { ConversionQueueItem, FormatCategory } from '@/lib/types';
import { getAvailableTargetFormats, FORMAT_REGISTRY } from '@/lib/registry';
import { maxFileBytes } from '@/lib/plan-limits';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import FormatSelector from '../FormatSelector';
import { useFileTooLargeMessage, useFormatBytes } from '../i18n/format';
import { useConversionFailureWording, type ErrorWording } from '../i18n/error-wording';
import TechnicalDetails from '../i18n/TechnicalDetails';
import { getPasswordValidationError } from './options/options-capabilities';

export interface QueueItemRowProps {
  item: ConversionQueueItem;
  isFormatSelectorOpen: boolean;
  onToggleFormatSelector: () => void;
  onCloseFormatSelector: () => void;
  onSelectTargetFormat: (targetFormat: string) => void;
  onOpenOptions: () => void;
  onRetry: () => void;
  onRemove: () => void;
}

const CATEGORY_ICONS: Partial<Record<FormatCategory, LucideIcon>> = {
  audio: Music,
  video: Video,
  image: FileImage,
  vector: Compass,
  cad: Compass,
  ebook: BookOpen,
  presentation: Presentation,
  spreadsheet: Database,
  data: Database,
  archive: Archive,
  font: Type,
};

type RowTranslator = ReturnType<typeof useTranslations<'queue.row'>>;
type PasswordErrorTranslator = ReturnType<typeof useTranslations<'options.password.errors'>>;

function getFormatLabel(t: RowTranslator, ext: string): string {
  const clean = ext.toLowerCase();
  return FORMAT_REGISTRY[clean]?.name || t('unknownFormat', { ext: clean.toUpperCase() });
}

function renderCategoryIcon(ext: string): React.ReactNode {
  const clean = ext.toLowerCase();
  const Icon = (clean !== 'pdf' && CATEGORY_ICONS[FORMAT_REGISTRY[clean]?.category || 'document']) || FileText;
  return <Icon className="w-5 h-5 text-accent-ink" />;
}

function resolveOptionError(tPassword: PasswordErrorTranslator, item: ConversionQueueItem): string | null {
  if (!item.targetFormat) return null;
  const problem = getPasswordValidationError(item.sourceFormat, item.targetFormat, item.options.password);
  return problem ? tPassword(problem) : null;
}

function resolveRowError(
  failureWording: ReturnType<typeof useConversionFailureWording>,
  item: ConversionQueueItem,
  optionError: string | null,
  oversizeError: string | null
): ErrorWording | null {
  if (oversizeError) return { message: oversizeError };
  if (optionError) return { message: optionError };
  if (item.status !== 'error') return null;
  return failureWording(item.error ?? { code: 'conversionFailed' });
}

function isRetryDisabled(
  item: ConversionQueueItem,
  isBusy: boolean,
  isOversize: boolean,
  optionError: string | null
): boolean {
  return isBusy || !item.targetFormat || isOversize || optionError !== null;
}

function RowStatusDisplay({
  item, isBusy, isOversize, optionError, onRetry,
}: Readonly<{
  item: ConversionQueueItem;
  isBusy: boolean;
  isOversize: boolean;
  optionError: string | null;
  onRetry: () => void;
}>) {
  const t = useTranslations('queue.row');
  if (isBusy) {
    const rounded = Math.round(item.progress);
    return (
      <div className="flex items-center gap-2.5 min-w-[140px]">
        <progress
          value={rounded} max={100} aria-label={t(item.status === 'uploading' ? 'uploadingLabel' : 'convertingLabel', { name: item.name })}
          className="thread flex-1"
        />
        <span className="text-xs text-accent-ink tabular-nums">{rounded}%</span>
      </div>
    );
  }
  if (item.status === 'completed') {
    const baseName = item.name.replace(/\.[^/.]+$/, '') || item.name;
    return (
      <div className="flex items-center gap-2">
        <span className="settle inline-flex items-center gap-1.5 px-1 text-xs font-semibold text-success"><span aria-hidden="true" className="size-1.5 rounded-full bg-success" />{t('done')}</span>
        {item.resultUrl && (
          <a
            href={item.resultUrl} download={`${baseName}.${item.targetFormat}`}
            className="settle lift bg-accent hover:bg-accent-hover hover:shadow-glow active:bg-accent-press text-on-accent inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-sm text-xs font-semibold"
          >
            <Download className="w-4 h-4" /><span>{t('download')}</span>
          </a>
        )}
      </div>
    );
  }
  if (item.status === 'error' || isOversize || optionError !== null) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 px-1 text-xs font-semibold text-danger"><span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />{t('failed')}</span>
        <button
          type="button" disabled={isRetryDisabled(item, isBusy, isOversize, optionError)} onClick={onRetry}
          className="transition-colors inline-flex items-center justify-center min-h-[44px] px-3.5 rounded-sm border border-danger-edge text-xs font-semibold text-danger hover:bg-danger-soft cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('retry')}
        </button>
      </div>
    );
  }
  if (!item.targetFormat) return null;
  return (
    <span className="inline-flex items-center gap-1.5 px-1 text-xs font-medium text-ink-3"><span aria-hidden="true" className="size-1.5 rounded-full bg-rule-strong" />{t('ready')}</span>
  );
}

export default function QueueItemRow({
  item,
  isFormatSelectorOpen,
  onToggleFormatSelector,
  onCloseFormatSelector,
  onSelectTargetFormat,
  onOpenOptions,
  onRetry,
  onRemove,
}: Readonly<QueueItemRowProps>) {
  const t = useTranslations('queue.row');
  const tPassword = useTranslations('options.password.errors');
  const formatBytes = useFormatBytes();
  const fileTooLargeMessage = useFileTooLargeMessage();
  const failureWording = useConversionFailureWording();
  const isBusy = item.status === 'uploading' || item.status === 'converting';
  const plan = useViewerPlan();
  const isIdle = !isBusy && item.status !== 'completed';
  // Read at render, not when the file was dropped: the plan of the session may answer after the drop.
  const isOversize = isIdle && item.size > maxFileBytes(plan);
  const hasTarget = Boolean(item.targetFormat);
  const optionError = isIdle ? resolveOptionError(tPassword, item) : null;
  const rowError = isIdle
    ? resolveRowError(failureWording, item, optionError, isOversize ? fileTooLargeMessage(plan, item.size) : null)
    : null;

  const targetButtonClass = hasTarget
    ? 'border-rule-strong text-ink hover:border-accent font-mono font-semibold uppercase'
    : 'border-warning-edge bg-warning-soft text-warning hover:border-accent font-medium';

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 min-w-0">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="w-8 shrink-0 flex items-center justify-center">
          {renderCategoryIcon(item.sourceFormat)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink truncate" title={item.name}>
            {item.name}
          </p>
          <p className="text-xs text-ink-2 flex items-center flex-wrap gap-1.5 mt-0.5">
            <span className="font-mono tabular-nums">{formatBytes(item.size)}</span>
            <span aria-hidden="true">&bull;</span>
            <span>{getFormatLabel(t, item.sourceFormat)}</span>
          </p>
          {rowError && (
            <>
              <p role="alert" className="text-xs text-danger mt-1">
                {rowError.message}
              </p>
              <TechnicalDetails text={rowError.technical} />
            </>
          )}
        </div>
      </div>

      <div className="flex items-center flex-wrap gap-2 shrink-0">
        <span className="text-xs text-ink-3 font-medium">{t('to')}</span>

        <div className="relative">
          <button
            type="button"
            data-testid="queue-target-format-btn"
            aria-label={t('selectFormatLabel', { name: item.name })}
            aria-haspopup="dialog"
            aria-expanded={isFormatSelectorOpen}
            disabled={isBusy || isOversize}
            onClick={onToggleFormatSelector}
            className={`transition-colors inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-sm border text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${targetButtonClass}`}
          >
            <span>{hasTarget ? item.targetFormat.toUpperCase() : t('selectFormat')}</span>
            <ChevronDown className="w-3.5 h-3.5 text-ink-3" />
          </button>

          {isFormatSelectorOpen && !isOversize && (
            <FormatSelector
              sourceFormat={item.sourceFormat}
              availableFormats={getAvailableTargetFormats(item.sourceFormat)}
              selectedFormatId={item.targetFormat}
              onSelect={onSelectTargetFormat}
              onClose={onCloseFormatSelector}
              title={t('selectorTitle', { format: item.sourceFormat.toUpperCase() })}
            />
          )}
        </div>

        <button
          type="button"
          data-testid="queue-options-btn"
          aria-label={t('optionsLabel', { name: item.name })}
          disabled={!item.targetFormat || isBusy || isOversize}
          onClick={onOpenOptions}
          className="transition-colors inline-flex items-center justify-center min-w-[44px] min-h-[44px] px-2.5 rounded-sm border border-rule text-ink-2 hover:border-accent hover:text-ink cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Sliders className="w-4 h-4" />
        </button>

        <RowStatusDisplay
          item={item}
          isBusy={isBusy}
          isOversize={isOversize}
          optionError={optionError}
          onRetry={onRetry}
        />

        <button
          type="button"
          aria-label={t(isBusy ? 'cancelLabel' : 'removeLabel', { name: item.name })}
          onClick={onRemove}
          className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-sm text-ink-3 hover:text-danger hover:bg-danger-soft transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
