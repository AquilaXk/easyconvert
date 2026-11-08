'use client';

import React, { useRef, useState } from 'react';
import JSZip from 'jszip';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, CircleCheck, Download, Loader2, Package, Sliders, X } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { usePublishedHeight } from '@/components/ConversionQueue';
import HeroDropzoneCard from '@/components/workbench/HeroDropzoneCard';
import FileSourceButton from '@/components/workbench/FileSourceButton';
import { FormatIcon } from '@/components/workbench/FormatIcon';
import { MAIN_FILE_INPUT_ID, useHeroUpload, type HeroOperation } from '@/components/hero/useHeroUpload';
import { useFileTooLargeMessage, useFormatBytes } from '@/components/i18n/format';
import { useConversionFailureWording } from '@/components/i18n/error-wording';
import { isSingleFileTool, useToolRun, type ToolFileItem } from '@/hooks/useToolRun';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import { maxFileBytes } from '@/lib/plan-limits';
import type { ToolResult, ToolResultFile } from '@/lib/tools/tool-client';
import { MIN_MERGE_FILES, TOOLS_WITH_OPTIONS, type WebTool } from '@/lib/tools/tool-names';
import ToolOptionsModal from './ToolOptionsModal';

const ROW_CLASS = 'rounded-xs border border-rule bg-surface px-4 py-3.5 sm:px-6 flex items-center gap-4 min-w-0';
const ICON_BUTTON_CLASS =
  'inline-flex items-center justify-center min-w-[44px] min-h-[44px] md:min-w-9 md:min-h-9 rounded-xs text-ink-3 hover:text-ink hover:bg-sunken transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
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
}

/** One file of the list: its type tile, name and size, the arrows that order it, and the button that takes it out. */
function FileRow({ item, position, count, movable, locked, tooLarge, onMove, onRemove }: Readonly<FileRowProps>) {
  const t = useTranslations('tools.row');
  const formatBytes = useFormatBytes();
  const { name } = item.file;
  return (
    <div className="flex flex-col gap-2">
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

/** Every file of an unpacked archive in one ZIP, built in the browser from what the server listed. */
async function zipOfEntries(entries: readonly ToolResultFile[]): Promise<Blob> {
  const zip = new JSZip();
  await Promise.all(entries.map(async (entry) => zip.file(entry.name, await (await fetch(entry.url)).blob())));
  return zip.generateAsync({ type: 'blob' });
}

interface ToolBarProps {
  summary: string;
  failure: string | null;
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
  onStartOver: () => void;
}

/** The bar pinned to the bottom of the viewport while files are on screen, as the converter's queue has it. */
function ToolBar({ summary, failure, busy, done, canRun, actionLabel, addMore, hasOptions, entries, onAdd, onImport, onOptions, onRun, onStartOver }: Readonly<ToolBarProps>) {
  const t = useTranslations('queue');
  const tTool = useTranslations('tools');
  const tRow = useTranslations('queue.row');
  const barRef = useRef<HTMLDivElement>(null);
  usePublishedHeight(barRef, '--queue-bar-height');
  const downloadAll = async () => {
    if (!entries) return;
    const url = URL.createObjectURL(await zipOfEntries(entries));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'files.zip';
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div ref={barRef} data-queue-bar className="sticky bottom-0 z-30 border-t border-rule bg-surface">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col md:flex-row md:items-center gap-3">
        <div className="min-w-0 md:flex-1 flex flex-col items-center md:items-start">
          <p className="flex items-center gap-2 text-sm text-ink-3">
            {done && <CircleCheck aria-hidden="true" className="size-4 shrink-0" />}
            <output aria-live="polite">{summary}</output>
          </p>
          {failure && <p role="alert" className="mt-1 text-xs text-danger">{failure}</p>}
        </div>
        <div className="flex flex-col md:flex-row md:items-center gap-2.5">
          {addMore && !done && <FileSourceButton variant="secondary" label={t('addMore')} disabled={busy} onPickDevice={onAdd} onImportFile={onImport} />}
          {hasOptions && !done && (
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
          {done ? (
            <button type="button" onClick={onStartOver} className="transition-colors min-h-[44px] md:min-h-[40px] px-3.5 rounded-xs border border-rule bg-canvas text-sm font-medium text-ink hover:border-rule-strong cursor-pointer">
              {tTool('result.startOver')}
            </button>
          ) : (
            <button
              type="button" disabled={!canRun} onClick={onRun}
              className="btn-primary min-h-[48px] px-6 rounded-xs text-lg font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {busy ? <><Loader2 aria-hidden="true" className="size-4 animate-spin" /><span>{tTool('running')}</span></> : <span>{actionLabel}</span>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A page of a tool that works on several files or on the pages of one: the title and the upload card, then the files, the options and one run. */
export default function ToolPageView({ tool, operation, title, description, dailyLimit }: Readonly<ToolPageViewProps>) {
  const t = useTranslations('tools');
  const run = useToolRun(tool);
  const upload = useHeroUpload((files) => run.add(files), undefined, operation);
  const plan = useViewerPlan();
  const fileTooLarge = useFileTooLargeMessage();
  const failureWording = useConversionFailureWording();
  const [optionsOpen, setOptionsOpen] = useState(false);

  const limit = maxFileBytes(plan);
  const running = run.phase === 'running';
  const done = run.phase === 'done';
  const oversize = run.items.some((item) => item.file.size > limit);
  const needsMore = tool === 'merge' && run.items.length < MIN_MERGE_FILES;
  const emptyRanges = tool === 'split' && run.options.split?.ranges !== undefined && run.options.split.ranges.trim() === '';
  const canRun = run.items.length > 0 && !running && !done && !oversize && !needsMore && !emptyRanges;

  let summary = t('status.ready', { count: run.items.length });
  if (running) summary = t('running');
  else if (done) summary = t('status.done');
  else if (needsMore) summary = t('status.needTwo');
  else if (oversize) summary = t('status.oversize');
  else if (run.skipped > 0) summary = t('status.skipped', { count: run.skipped });

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
                    />
                  </li>
                ))}
              </ul>
              {run.result && <ResultList result={run.result} />}
            </div>
            <ToolBar
              summary={summary} failure={run.failure ? failureWording(run.failure) : null} busy={running} done={done} canRun={canRun}
              actionLabel={t(`actions.${tool}`)} addMore={!isSingleFileTool(tool)} hasOptions={TOOLS_WITH_OPTIONS.has(tool)}
              entries={run.result?.kind === 'entries' ? run.result.entries : null}
              onAdd={() => document.getElementById(MAIN_FILE_INPUT_ID)?.click()} onImport={(file) => run.add([file])}
              onOptions={() => setOptionsOpen(true)} onRun={() => void run.run()} onStartOver={run.clear}
            />
            {optionsOpen && <ToolOptionsModal tool={tool} toolName={title} initialOptions={run.options} onSave={run.setOptions} onClose={() => setOptionsOpen(false)} />}
          </section>
        )}
      </main>
      <Footer />
    </div>
  );
}
