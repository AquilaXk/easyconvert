'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, ChevronDown, Download, Sliders, X } from 'lucide-react';
import { ConversionQueueItem } from '@/lib/types';
import { getAvailableTargetFormats, FORMAT_REGISTRY } from '@/lib/registry';
import { maxFileBytes } from '@/lib/plan-limits';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import { useFileTooLargeMessage, useFormatBytes } from '../i18n/format';
import { useConversionFailureWording } from '../i18n/error-wording';
import { getPasswordValidationError } from './options/options-capabilities';
import { FormatIcon } from './FormatIcon';
import FormatPickerButton from './FormatPickerButton';

export interface QueueItemRowProps {
  item: ConversionQueueItem;
  onSelectTargetFormat: (targetFormat: string) => void;
  onOpenOptions: () => void;
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

/**
 * Where a row's conversion stands, as the accessible name of its target select states it. A conversion that ran and failed
 * reads as failed; a file over the limit or with an option the target cannot take reads as one that cannot convert, which
 * its error text explains; neither offers a retry, as the reference row does not.
 */
function rowState(item: ConversionQueueItem, isBusy: boolean, isBlocked: boolean): string {
  if (isBusy || item.status === 'completed') return item.status;
  if (isBlocked) return 'blocked';
  return item.status === 'error' ? 'failed' : 'ready';
}

/** The error line under a row, as the reference draws it: a failure badge when the conversion ran, then the reason. */
function RowError({ message, ranAndFailed }: Readonly<{ message: string; ranAndFailed: boolean }>) {
  const t = useTranslations('queue.row');
  return (
    <div className="col-span-full border-t border-rule pt-3 flex items-center gap-2.5 min-w-0">
      {ranAndFailed && (
        <span className="shrink-0 inline-flex items-center px-2 py-1 rounded-xs bg-danger-soft text-danger border border-danger-edge text-xs font-medium uppercase tracking-wider">
          {t('failed')}
        </span>
      )}
      <p role="alert" className="min-w-0 text-sm text-ink">
        {message}
      </p>
    </div>
  );
}

function RowStatusDisplay({ item, isBusy }: Readonly<{ item: ConversionQueueItem; isBusy: boolean }>) {
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
  return null;
}

/**
 * One file of the queue, in the order of the reference layout: the type tile, the name over its size and format, then the
 * source badge, the target select limited to that file's targets, the options, the status and the remove button.
 */
export default function QueueItemRow({
  item,
  onSelectTargetFormat,
  onOpenOptions,
  onRemove,
}: Readonly<QueueItemRowProps>) {
  const t = useTranslations('queue.row');
  const tFormat = useTranslations('formatSelector');
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
  const isBlocked = isOversize || optionError !== null;
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
          <span>{tFormat('formatName', { format: sourceLabel, category })}</span>
        </p>
      </div>

      <div className="col-span-3 row-start-2 border-t border-rule pt-3 lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:border-0 lg:pt-0 flex items-center flex-wrap gap-2 lg:gap-2.5">
        <span className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-xs bg-sunken text-sm font-semibold text-ink">
          <FormatIcon format={item.sourceFormat} className="size-3.5 text-ink-3" />
          {sourceLabel}
        </span>
        <ArrowRight aria-hidden="true" className="size-4 text-ink-3 shrink-0" />

        <FormatPickerButton
          testId="queue-target-format-btn"
          ariaLabel={
            hasTarget
              ? t('targetLabel', { name: item.name, src: sourceLabel, tgt: item.targetFormat.toUpperCase(), state: rowState(item, isBusy, isBlocked) })
              : t('chooseTargetLabel', { name: item.name, src: sourceLabel })
          }
          disabled={isBusy || isOversize}
          className="transition-colors inline-flex items-center justify-between gap-2 min-w-32 min-h-[44px] md:min-h-9 px-2.5 rounded-xs border border-rule bg-canvas text-sm text-ink hover:border-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          sourceFormat={item.sourceFormat}
          availableFormats={getAvailableTargetFormats(item.sourceFormat)}
          selectedFormatId={item.targetFormat}
          onSelect={onSelectTargetFormat}
          title={t('selectorTitle', { format: sourceLabel })}
        >
          <span>{hasTarget ? item.targetFormat.toUpperCase() : t('selectFormat')}</span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
        </FormatPickerButton>

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

        <RowStatusDisplay item={item} isBusy={isBusy} />
      </div>

      <button
        type="button"
        aria-label={t(isBusy ? 'cancelLabel' : 'removeLabel', { name: item.name })}
        onClick={onRemove}
        className="col-start-3 row-start-1 lg:col-start-4 -mr-2 inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-xs text-ink-3 hover:text-danger hover:bg-danger-soft transition-colors cursor-pointer"
      >
        <X aria-hidden="true" className="size-4" />
      </button>

      {rowError && <RowError message={rowError} ranAndFailed={!isBlocked} />}
    </div>
  );
}
