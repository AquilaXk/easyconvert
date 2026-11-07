'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Upload } from 'lucide-react';
import { useFileLimitCopy } from '../i18n/format';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import { TIER_LIMITS } from '@/lib/plan-limits';
import type { HeroOperation } from '../hero/useHeroUpload';
import FileSourceButton from './FileSourceButton';

interface HeroDropzoneCardProps {
  /** The page's operation when it is not a conversion, which words the heading and the button. */
  operation?: HeroOperation;
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onOpenFileDialog: () => void;
  onImportFile: (file: File) => void;
  /** The conversions a day the server allows an anonymous caller, read on the server. */
  dailyLimit: number;
}

/** The upload card: one bordered drop area with the select-file split button, and the limits of the viewer's plan under it. */
export default function HeroDropzoneCard({
  operation,
  isDragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpenFileDialog,
  onImportFile,
  dailyLimit,
}: Readonly<HeroDropzoneCardProps>) {
  const t = useTranslations('hero.dropzone');
  const tOperation = useTranslations('hero.operations');
  const fileLimitCopy = useFileLimitCopy();
  const plan = useViewerPlan();
  const limits = [
    fileLimitCopy(plan),
    t('dailyConversions', { count: plan === 'anonymous' ? dailyLimit : TIER_LIMITS[plan] }),
    t('autoDeleted'),
  ];

  return (
    <div className="w-full min-w-0">
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`rounded-xs border bg-surface px-6 py-8 sm:px-10 sm:py-10 text-center shadow-elev-2 transition-colors duration-200 ${
          isDragOver ? 'border-accent bg-accent-soft' : 'border-rule hover:border-rule-strong/40'
        }`}
      >
        <Upload aria-hidden="true" className="mx-auto mb-6 size-10 text-accent-ink" />
        <h2 className="text-xl sm:text-2xl text-ink">{operation ? tOperation(`${operation}.heading`) : t('heading')}</h2>
        <p className="mt-1 text-sm sm:text-base text-ink-3">{t('hint')}</p>
        <FileSourceButton
          variant="primary"
          label={operation ? tOperation(`${operation}.selectFile`) : t('selectFile')}
          onPickDevice={onOpenFileDialog}
          onImportFile={onImportFile}
          className="mt-6"
        />
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
