'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, ChevronDown, Download, Sliders, X } from 'lucide-react';
import { ConversionQueueItem } from '@/lib/types';
import { getAvailableTargetFormats, FORMAT_REGISTRY } from '@/lib/registry';
import { maxFileBytes } from '@/lib/plan-limits';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import FormatSelector from '../FormatSelector';
import { useFileTooLargeMessage, useFormatBytes } from '../i18n/format';
import { useConversionFailureWording } from '../i18n/error-wording';
import { getPasswordValidationError } from './options/options-capabilities';
import { FormatIcon } from './FormatIcon';

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

type PasswordErrorTranslator = ReturnType<typeof useTranslations<'options.password.errors'>>;

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
): string | null {
  if (oversizeError) return oversizeError;
  if (optionError) return optionError;
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

/** Where a row's conversion stands, as the accessible name of its target select states it. */
function rowState(item: ConversionQueueItem, isBusy: boolean, hasRowError: boolean): string {
  if (isBusy || item.status === 'completed') return item.status;
  return hasRowError ? 'failed' : 'ready';
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
  const formatBytes = useFormatBytes();
  if (isBusy) {
    const rounded = Math.round(item.progress);
    return (
      <div className="flex items-center gap-2.5 w-36">
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
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success"><span aria-hidden="true" className="size-1.5 rounded-full bg-success" />{t('done')}</span>
        {item.resultSize !== undefined && <span className="text-xs text-ink-3 tabular-nums">{formatBytes(item.resultSize)}</span>}
        {item.resultUrl && (
          <a
            href={item.resultUrl} download={`${baseName}.${item.targetFormat}`}
            className="btn-primary inline-flex items-center justify-center gap-1.5 min-h-[44px] md:min-h-9 px-4 rounded-xs text-sm font-medium"
          >
            <Download aria-hidden="true" className="size-4" /><span>{t('download')}</span>
          </a>
        )}
      </div>
    );
  }
  if (item.status === 'error' || isOversize || optionError !== null) {
    return (
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-danger"><span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />{t('failed')}</span>
        <button
          type="button" disabled={isRetryDisabled(item, isBusy, isOversize, optionError)} onClick={onRetry}
          className="transition-colors inline-flex items-center justify-center min-h-[44px] md:min-h-9 px-3.5 rounded-xs border border-danger-edge text-sm font-medium text-danger hover:bg-danger-soft cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('retry')}
        </button>
      </div>
    );
  }
  return null;
}

/**
 * One file of the queue, in the order of the reference layout: the type tile, the name over its size and format, then the
 * source badge, the target select limited to that file's targets, the options, the status and the remove button.
 */
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
  const sourceLabel = item.sourceFormat.toUpperCase();
  const category = FORMAT_REGISTRY[item.sourceFormat.toLowerCase()]?.category ?? 'other';

  return (
    <div className="rounded-xs border border-rule bg-surface px-4 py-3.5 sm:px-6 grid grid-cols-[2.75rem_minmax(0,1fr)_auto] lg:grid-cols-[2.75rem_minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-3 min-w-0">
      <div className="size-11 flex items-center justify-center rounded-xs bg-sunken">
        <FormatIcon format={item.sourceFormat} className="size-5 text-ink-3" />
      </div>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-ink truncate" title={item.name}>
          {item.name}
        </p>
        <p className="mt-0.5 text-xs text-ink-3 truncate">
          <span className="tabular-nums">{formatBytes(item.size)}</span>
          <span aria-hidden="true">{' · '}</span>
          <span>{t('formatName', { format: sourceLabel, category })}</span>
        </p>
        {rowError && (
          <p role="alert" className="text-xs text-danger mt-1">
            {rowError}
          </p>
        )}
      </div>

      <div className="col-span-3 row-start-2 border-t border-rule pt-3 lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:border-0 lg:pt-0 flex items-center flex-wrap gap-2 lg:gap-2.5">
        <span className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-xs bg-sunken text-sm font-semibold text-ink">
          <FormatIcon format={item.sourceFormat} className="size-3.5 text-ink-3" />
          {sourceLabel}
        </span>
        <ArrowRight aria-hidden="true" className="size-4 text-ink-3 shrink-0" />

        <div className="relative">
          <button
            type="button"
            data-testid="queue-target-format-btn"
            aria-label={
              hasTarget
                ? t('targetLabel', { name: item.name, src: sourceLabel, tgt: item.targetFormat.toUpperCase(), state: rowState(item, isBusy, rowError !== null) })
                : t('chooseTargetLabel', { name: item.name, src: sourceLabel })
            }
            aria-haspopup="dialog"
            aria-expanded={isFormatSelectorOpen}
            disabled={isBusy || isOversize}
            onClick={onToggleFormatSelector}
            className="transition-colors inline-flex items-center justify-between gap-2 min-w-32 min-h-[44px] md:min-h-9 px-2.5 rounded-xs border border-rule bg-canvas text-sm text-ink hover:border-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span>{hasTarget ? item.targetFormat.toUpperCase() : t('selectFormat')}</span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
          </button>

          {isFormatSelectorOpen && !isOversize && (
            <FormatSelector
              sourceFormat={item.sourceFormat}
              availableFormats={getAvailableTargetFormats(item.sourceFormat)}
              selectedFormatId={item.targetFormat}
              onSelect={onSelectTargetFormat}
              onClose={onCloseFormatSelector}
              title={t('selectorTitle', { format: sourceLabel })}
            />
          )}
        </div>

        <button
          type="button"
          data-testid="queue-options-btn"
          aria-label={t('optionsLabel', { name: item.name })}
          disabled={!item.targetFormat || isBusy || isOversize}
          onClick={onOpenOptions}
          className="transition-colors inline-flex items-center justify-center gap-2 min-w-[44px] min-h-[44px] md:min-h-9 px-2.5 rounded-xs border border-rule text-sm font-medium text-ink hover:border-rule-strong cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Sliders aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">{t('options')}</span>
        </button>

        <RowStatusDisplay
          item={item}
          isBusy={isBusy}
          isOversize={isOversize}
          optionError={optionError}
          onRetry={onRetry}
        />
      </div>

      <button
        type="button"
        aria-label={t(isBusy ? 'cancelLabel' : 'removeLabel', { name: item.name })}
        onClick={onRemove}
        className="col-start-3 row-start-1 lg:col-start-4 -mr-2 inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-xs text-ink-3 hover:text-danger hover:bg-danger-soft transition-colors cursor-pointer"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
