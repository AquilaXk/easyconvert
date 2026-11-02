'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Upload } from 'lucide-react';
import { useFileLimitCopy } from '../i18n/format';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import type { Plan } from '@/lib/plan-limits';
import FileSourceButton from './FileSourceButton';

interface HeroDropzoneCardProps {
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onOpenFileDialog: () => void;
  onImportFile: (file: File) => void;
  /** The conversions a day the server allows an anonymous caller, read on the server. */
  dailyLimit: number;
  /** What the card shows under the select button: the format chips of the home page. */
  children?: React.ReactNode;
}

/** The plans whose day the free allowance bounds; a paid plan has its own allowance. */
const FREE_ALLOWANCE_PLANS: ReadonlySet<Plan> = new Set(['anonymous', 'free']);

/** The upload card: a dashed drop area with the select-file split button, and the limits of the viewer's plan under it. */
export default function HeroDropzoneCard({
  isDragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpenFileDialog,
  onImportFile,
  dailyLimit,
  children,
}: Readonly<HeroDropzoneCardProps>) {
  const t = useTranslations('hero.dropzone');
  const fileLimitCopy = useFileLimitCopy();
  const plan = useViewerPlan();
  const limits = [
    fileLimitCopy(plan),
    ...(FREE_ALLOWANCE_PLANS.has(plan) ? [t('dailyConversions', { count: dailyLimit })] : []),
    t('autoDeleted'),
  ];

  return (
    <div className="w-full min-w-0">
      <div className="rounded-xl border border-rule bg-surface p-3 sm:p-[18px] shadow-elev-2">
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`rounded-md border-2 border-dashed px-4 py-7 sm:px-6 sm:py-8 text-center transition-colors duration-200 ${
            isDragOver ? 'border-accent bg-accent-soft' : 'border-accent-edge'
          }`}
        >
          <div className="mx-auto mb-4 size-14 rounded-sm border border-accent-edge bg-accent-soft text-accent-ink flex items-center justify-center">
            <Upload aria-hidden="true" className="size-6" />
          </div>
          <h2 className="text-[22px] font-normal tracking-[-0.04em] text-ink">{t('heading')}</h2>
          <p className="mt-1.5 text-sm text-ink-3">{t('hint')}</p>
          <FileSourceButton
            variant="primary"
            label={t('selectFile')}
            onPickDevice={onOpenFileDialog}
            onImportFile={onImportFile}
            className="mt-5"
          />
          {children}
        </div>
      </div>
      <p className="mt-3 px-2 text-center text-[13px] font-semibold text-ink-3 tabular-nums">
        {limits.map((limit, index) => (
          <React.Fragment key={limit}>
            {index > 0 && <span aria-hidden="true">{' · '}</span>}
            <span className="whitespace-nowrap">{limit}</span>
          </React.Fragment>
        ))}
      </p>
    </div>
  );
}
