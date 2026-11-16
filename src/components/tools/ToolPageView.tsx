'use client';

import React, { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, CircleCheck, Download, Loader2, Package, Sliders, X } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { usePublishedHeight } from '@/components/ConversionQueue';
import HeroDropzoneCard from '@/components/workbench/HeroDropzoneCard';
import FileSourceButton from '@/components/workbench/FileSourceButton';
import { FormatIcon } from '@/components/workbench/FormatIcon';
import { QuotaExhaustedActions } from '@/components/workbench/QuotaExhaustedActions';
import { MAIN_FILE_INPUT_ID, useHeroUpload, type HeroOperation } from '@/components/hero/useHeroUpload';
import { useFileTooLargeMessage, useFormatBytes } from '@/components/i18n/format';
import { useConversionFailureWording } from '@/components/i18n/error-wording';
import { isSingleFileTool, useToolRun, type ToolFileItem } from '@/hooks/useToolRun';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import { streamZipReadable } from '@/lib/archive/streaming-zip';
import { warnBrowserFailure } from '@/lib/browser-failure';
import type { ConversionFailure } from '@/lib/conversion-failure';
import { downloadBlob } from '@/lib/download-blob';
import { maxFileBytes, SINGLE_REQUEST_FILE_MAX_BYTES } from '@/lib/plan-limits';
import { toolInputProblem, type ToolResult, type ToolResultFile } from '@/lib/tools/tool-client';
import { MAX_TOOL_FILES, MIN_MERGE_FILES, TOOLS_WITH_OPTIONS, type WebTool, type WebToolOptions } from '@/lib/tools/tool-names';
import ToolOptionsModal from './ToolOptionsModal';

const ROW_CLASS = 'rounded-xs border border-rule bg-surface px-4 py-3.5 sm:px-6 flex items-center gap-4 min-w-0';
const ICON_BUTTON_CLASS =
  'inline-flex items-center justify-center min-w-[44px] min-h-[44px] md:min-w-9 md:min-h-9 rounded-xs text-ink-3 hover:text-ink hover:bg-sunken transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
const SECONDARY_BUTTON_CLASS =
  'transition-colors min-h-[44px] md:min-h-[40px] px-3.5 rounded-xs border border-rule bg-canvas text-sm font-medium text-ink hover:border-rule-strong cursor-pointer';
const DOWNLOAD_CLASS = 'btn-primary inline-flex items-center justify-center gap-1.5 min-h-[44px] md:min-h-9 px-4 rounded-xs text-sm font-medium';

const extensionOf = (name: string): string => (/\.tar\.gz$/i.test(name) ? 'tar.gz' : (name.split('.').pop() ?? '').toLowerCase());

interface ToolPageViewProps {
  tool: WebTool;
  /** The page's operation, which words the upload card. */
  operation: HeroOperation;
  title: string;
  description: string;
  /** The conversions a day the server allows an anonymous caller, read on the server. */
  dailyLimit: number;
}

interface FileRowProps {
  item: ToolFileItem;
  position: number;
  count: number;
  movable: boolean;
  locked: boolean;
  tooLarge: string | null;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onDragStart?: (index: number) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (index: number) => void;
}

/** One file of the list: its type tile, name and size, the arrows that order it, and the button that takes it out. */
function FileRow({ item, position, count, movable, locked, tooLarge, onMove, onRemove, onDragStart, onDragOver, onDrop }: Readonly<FileRowProps>) {
  const t = useTranslations('tools.row');
  const formatBytes = useFormatBytes();
  const { name } = item.file;
  return (
    <div
      draggable={movable && !locked}
      onDragStart={() => onDragStart?.(position)}
      onDragOver={onDragOver}
      onDrop={() => onDrop?.(position)}
      className="flex flex-col gap-2"
    >
      <div className={ROW_CLASS}>
        <div className="size-11 flex items-center justify-center rounded-xs bg-sunken shrink-0">
          <FormatIcon format={extensionOf(name)} className="size-6 text-ink-3" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-ink truncate" title={name}>{name}</p>
          <p className="mt-0.5 text-xs text-ink-3 tabular-nums">{formatBytes(item.file.size)}</p>
        </div>
        {movable && (
          <div className="flex items-center">
            <button type="button" aria-label={t('moveUp', { name })} disabled={locked || position === 0} onClick={() => onMove(-1)} className={ICON_BUTTON_CLASS}>
              <ArrowUp aria-hidden="true" className="size-4" />
            </button>
            <button type="button" aria-label={t('moveDown', { name })} disabled={locked || position === count - 1} onClick={() => onMove(1)} className={ICON_BUTTON_CLASS}>
              <ArrowDown aria-hidden="true" className="size-4" />
            </button>
          </div>
        )}
        <button type="button" aria-label={t('remove', { name })} disabled={locked} onClick={onRemove} className={`${ICON_BUTTON_CLASS} -mr-2 hover:text-danger hover:bg-danger-soft`}>
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {tooLarge && <p role="alert" className="text-sm text-danger px-1">{tooLarge}</p>}
    </div>
  );
}

function ResultRow({ file, label }: Readonly<{ file: ToolResultFile; label: string }>) {
  const t = useTranslations('queue.row');
  const tResult = useTranslations('tools.result');
  const formatBytes = useFormatBytes();
  return (
    <div className={ROW_CLASS}>
      <div className="size-11 flex items-center justify-center rounded-xs bg-sunken shrink-0">
        <FormatIcon format={extensionOf(file.name)} className="size-6 text-ink-3" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-ink truncate" title={file.name}>{file.name}</p>
        <p className="mt-0.5 text-xs text-ink-3 tabular-nums">{formatBytes(file.size)}</p>
      </div>
      <a href={file.url} download={file.name} aria-label={tResult('downloadName', { name: label })} className={DOWNLOAD_CLASS}>
        <Download aria-hidden="true" className="size-4" /><span>{t('download')}</span>
      </a>
    </div>
  );
}

function ResultList({ result }: Readonly<{ result: ToolResult }>) {
  const t = useTranslations('tools.result');
  const files = result.kind === 'file' ? [result.file] : result.entries;
  return (
    <section aria-label={t('label')} className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-ink-2">{result.kind === 'entries' ? t('files', { count: files.length }) : t('label')}</h2>
      <ul className="flex flex-col gap-3.5">
        {files.map((file) => <li key={file.url}><ResultRow file={file} label={file.name} /></li>)}
      </ul>
    </section>
  );
}

/** Every file of an unpacked archive in one ZIP, streamed via /api/storage/bundle or client-zip. */
async function zipOfEntries(entries: readonly ToolResultFile[]): Promise<Blob> {
  const hasKeys = entries.length > 0 && entries.every((e) => Boolean(e.key));
  if (hasKeys) {
    try {
      const res = await fetch('/api/storage/bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: entries.map((e) => ({ key: e.key!, name: e.name })),
          archiveName: 'files.zip',
        }),
      });
      if (res.ok) return await res.blob();
    } catch {
      // Fall through to browser streaming
    }
  }

  async function* generateEntries() {
    for (const entry of entries) {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`Could not fetch "${entry.name}"`);
      const blob = await res.blob();
      yield {
        name: entry.name,
        data: blob,
        size: blob.size,
      };
    }
  }

  return await new Response(streamZipReadable(generateEntries())).blob();
}

interface ToolBarProps {
  summary: string;
  failure: string | null;
  rawFailure: ConversionFailure | null;
  busy: boolean;
  done: boolean;
  canRun: boolean;
  actionLabel: string;
  addMore: boolean;
  hasOptions: boolean;
  entries: readonly ToolResultFile[] | null;
  onAdd: () => void;
  onImport: (file: File) => void;
  onOptions: () => void;
  onRun: () => void;
  onCancel: () => void;
  onStartOver: () => void;
}

/** The bar pinned to the bottom of the viewport while files are on screen, as the converter's queue has it. */
function ToolBar({ summary, failure, rawFailure, busy, done, canRun, actionLabel, addMore, hasOptions, entries, onAdd, onImport, onOptions, onRun, onCancel, onStartOver }: Readonly<ToolBarProps>) {
  const t = useTranslations('queue');
  const tTool = useTranslations('tools');
  const tRow = useTranslations('queue.row');
  const zipFailed = useTranslations('errors.queue')('zipFailed');
  const barRef = useRef<HTMLDivElement>(null);
  const [bundleFailed, setBundleFailed] = useState(false);
  usePublishedHeight(barRef, '--queue-bar-height');
  const downloadAll = async () => {
    if (!entries) return;
    setBundleFailed(false);
    try {
      downloadBlob(await zipOfEntries(entries), 'files.zip');
    } catch (error: unknown) {
      warnBrowserFailure('Bundling the unpacked files into a ZIP failed', error);
      setBundleFailed(true);
    }
  };
  // One button holds the place of the run, the cancel and the start over, so keyboard focus stays on it as the run goes by.
  const primaryClass = busy || done
    ? SECONDARY_BUTTON_CLASS
    : 'btn-primary min-h-[48px] px-6 rounded-xs text-lg font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';
  let primaryAction = onRun;
  let primaryLabel = actionLabel;
  if (busy) {
    primaryAction = onCancel;
    primaryLabel = tTool('cancel');
  } else if (done) {
    primaryAction = onStartOver;
    primaryLabel = tTool('result.startOver');
  }
  return (
    <div ref={barRef} data-queue-bar className="sticky bottom-0 z-30 border-t border-rule bg-surface">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col md:flex-row md:items-center gap-3">
        <div className="min-w-0 md:flex-1 flex flex-col items-center md:items-start">
          <p className="flex items-center gap-2 text-sm text-ink-3">
            {done && <CircleCheck aria-hidden="true" className="size-4 shrink-0" />}
            {busy && <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />}
            <output aria-live="polite">{summary}</output>
          </p>
          {failure && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <p role="alert" className="text-xs text-danger">{failure}</p>
              <QuotaExhaustedActions failure={rawFailure} />
            </div>
          )}
          {bundleFailed && <p role="alert" className="mt-1 text-xs text-danger">{zipFailed}</p>}
        </div>
        <div className="flex flex-col md:flex-row md:items-center gap-2.5">
          {addMore && <FileSourceButton variant="secondary" label={t('addMore')} disabled={busy} onPickDevice={onAdd} onImportFile={onImport} />}
          {hasOptions && (
            <button
              type="button" disabled={busy} onClick={onOptions}
              className="transition-colors inline-flex items-center justify-center gap-2 min-h-[44px] md:min-h-[40px] px-3.5 rounded-xs border border-rule bg-canvas text-sm font-medium text-ink hover:border-rule-strong cursor-pointer disabled:opacity-50"
            >
              <Sliders aria-hidden="true" className="size-4" /><span>{tRow('options')}</span>
            </button>
          )}
          {entries && entries.length > 1 && (
            <button
              type="button" onClick={() => void downloadAll()}
              className="transition-colors min-h-[44px] md:min-h-[40px] px-3.5 rounded-xs bg-accent-soft text-accent-ink border border-accent-edge hover:border-accent text-sm font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Package aria-hidden="true" className="size-4" /><span>{tTool('result.downloadAll')}</span>
            </button>
          )}
          <button type="button" disabled={!busy && !done && !canRun} onClick={primaryAction} className={primaryClass}>
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

type MissingOptionKey = 'needRanges' | 'needPassword' | 'needUnlockPassword' | 'needWatermark' | 'needPages';

function missingOptionKeyOf(tool: WebTool, options: WebToolOptions): MissingOptionKey | null {
  if (tool === 'split' && options.split?.ranges !== undefined && options.split.ranges.trim() === '') {
    return 'needRanges';
  }
  if (tool === 'protect') {
    const hasPass = Boolean(options.protect?.userPassword?.trim() || options.protect?.ownerPassword?.trim());
    return hasPass ? null : 'needPassword';
  }
  if (tool === 'unlock') {
    const hasPass = Boolean((options.unlock?.password ?? options.password)?.trim());
    return hasPass ? null : 'needUnlockPassword';
  }
  if (tool === 'watermark') {
    return options.watermark?.text?.trim() ? null : 'needWatermark';
  }
  if (tool === 'extract-pages' || tool === 'delete-pages') {
    return options.pages?.trim() ? null : 'needPages';
  }
  return null;
}

interface SummaryParams {
  running: boolean;
  done: boolean;
  needsMore: boolean;
  oversize: boolean;
  problem: string | null;
  missingOption: MissingOptionKey | null;
  leftOut: string;
  count: number;
  t: ReturnType<typeof useTranslations<'tools'>>;
  formatBytes: (bytes: number) => string;
}

function resolveSummary({ running, done, needsMore, oversize, problem, missingOption, leftOut, count, t, formatBytes }: SummaryParams): string {
  if (running) return t('running');
  if (done) return t('status.done');
  if (needsMore) return t('status.needTwo');
  if (oversize) return t('status.oversize');
  if (problem === 'tooMany') return t('status.tooMany', { max: MAX_TOOL_FILES });
  if (problem === 'tooLarge') return t('status.tooLarge', { size: formatBytes(SINGLE_REQUEST_FILE_MAX_BYTES) });
  if (problem === 'empty') return t('status.empty');
  if (missingOption) return t(`status.${missingOption}`);
  if (leftOut) return leftOut;
  return t('status.ready', { count });
}

/** A page of a tool that works on several files or on the pages of one: the title and the upload card, then the files, the options and one run. */
export default function ToolPageView({ tool, operation, title, description, dailyLimit }: Readonly<ToolPageViewProps>) {
  const t = useTranslations('tools');
  const run = useToolRun(tool);
  const upload = useHeroUpload((files) => run.add(files), undefined, operation, !isSingleFileTool(tool));
  const plan = useViewerPlan();
  const formatBytes = useFormatBytes();
  const fileTooLarge = useFileTooLargeMessage();
  const failureWording = useConversionFailureWording();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [draggedRowIndex, setDraggedRowIndex] = useState<number | null>(null);

  const limit = maxFileBytes(plan);
  const running = run.phase === 'running';
  const done = run.phase === 'done';
  const oversize = run.items.some((item) => item.file.size > limit);
  const needsMore = tool === 'merge' && run.items.length < MIN_MERGE_FILES;
  const missingOption = missingOptionKeyOf(tool, run.options);
  const problem = toolInputProblem(run.items.map((item) => item.file));
  const canRun = run.items.length > 0 && !running && !done && !oversize && !needsMore && missingOption === null && problem === null;

  const handleRowDrop = (targetIndex: number) => {
    if (draggedRowIndex === null || draggedRowIndex === targetIndex) return;
    run.reorder(draggedRowIndex, targetIndex);
    setDraggedRowIndex(null);
  };

  const leftOut = [run.skipped > 0 ? t('status.skipped', { count: run.skipped }) : null, run.surplus > 0 ? t('status.surplus', { count: run.surplus }) : null].filter(Boolean).join(' ');
  const summary = resolveSummary({
    running, done, needsMore, oversize, problem, missingOption, leftOut,
    count: run.items.length, t, formatBytes,
  });

  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      <main id="main-content" className="flex-1">
        <input {...upload.fileInput} />
        {run.items.length === 0 ? (
          <section className="pt-10 pb-16 lg:pt-14 lg:pb-20">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="text-center lg:text-left lg:max-w-2xl">
                <h1 className="text-3xl sm:text-4xl lg:text-5xl text-ink">{title}</h1>
                <p className="mt-5 text-base sm:text-lg sm:leading-relaxed text-ink-3">{description}</p>
              </div>
              <div className="mt-10 lg:mt-12 max-w-2xl mx-auto">
                <HeroDropzoneCard {...upload.dropzone} dailyLimit={dailyLimit} />
                {run.skipped > 0 && <p role="alert" className="mt-3 text-center text-sm text-danger">{t('status.skipped', { count: run.skipped })}</p>}
              </div>
            </div>
          </section>
        ) : (
          <section aria-label={t('label')} className="min-h-[calc(100dvh-var(--header-height))] flex flex-col">
            <div className="py-6 sm:py-8 border-b border-rule">
              <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <h1 className="text-3xl sm:text-4xl leading-tight text-ink">{title}</h1>
                <p className="mt-1.5 text-sm text-ink-2 max-w-2xl">{description}</p>
              </div>
            </div>
            <div className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
              <ul className="flex flex-col gap-3.5">
                {run.items.map((item, position) => (
                  <li key={item.id}>
                    <FileRow
                      item={item} position={position} count={run.items.length} movable={!isSingleFileTool(tool)} locked={running}
                      tooLarge={item.file.size > limit ? fileTooLarge(plan, item.file.size) : null}
                      onMove={(delta) => run.move(item.id, delta)} onRemove={() => run.remove(item.id)}
                      onDragStart={() => setDraggedRowIndex(position)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => handleRowDrop(position)}
                    />
                  </li>
                ))}
              </ul>
              {run.result && <ResultList result={run.result} />}
            </div>
            <ToolBar
              summary={summary} failure={run.failure ? failureWording(run.failure) : null} rawFailure={run.failure} busy={running} done={done} canRun={canRun}
              actionLabel={t(`actions.${tool}`)} addMore={!isSingleFileTool(tool)} hasOptions={TOOLS_WITH_OPTIONS.has(tool)}
              entries={run.result?.kind === 'entries' ? run.result.entries : null}
              onAdd={() => document.getElementById(MAIN_FILE_INPUT_ID)?.click()} onImport={(file) => run.add([file])}
              onOptions={() => setOptionsOpen(true)} onRun={() => void run.run()} onCancel={run.cancel} onStartOver={run.clear}
            />
            {optionsOpen && <ToolOptionsModal tool={tool} toolName={title} initialOptions={run.options} onSave={run.setOptions} onClose={() => setOptionsOpen(false)} />}
          </section>
        )}
      </main>
      <Footer />
    </div>
  );
}
