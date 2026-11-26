'use client';

import React, { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { useModalDialog } from '@/hooks/useModalDialog';
import type { WebsiteCaptureOptions } from '@/lib/capture-options';
import {
  HELP_TEXT_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  SECTION_HEADING_CLASS,
  SELECT_CLASS,
} from '../workbench/options/section-primitives';

const PDF_PAPERS = ['A4', 'Letter', 'A3', 'A5', 'Legal', 'Tabloid'] as const;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_MARGIN = 10;
const DEFAULT_QUALITY = 85;
const CHECK_ROW = 'flex items-center gap-3 min-h-[44px] text-sm font-normal text-ink cursor-pointer';

function clampInt(raw: string, min: number, max: number): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, parsed));
}

function clampFloat(raw: string, min: number, max: number): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, parsed));
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

interface CaptureDraftFields {
  draft: WebsiteCaptureOptions;
  marginText: string;
  widthText: string;
  heightText: string;
  qualityText: string;
}

function buildCaptureOptions(targetFormat: 'pdf' | 'png' | 'jpg', fields: CaptureDraftFields): WebsiteCaptureOptions {
  const next: WebsiteCaptureOptions = {};
  if (fields.draft.waitUntil !== undefined) next.waitUntil = fields.draft.waitUntil;
  if (targetFormat === 'pdf') {
    const margin = clampFloat(fields.marginText, 0, 50);
    const pdf: NonNullable<WebsiteCaptureOptions['pdf']> = {
      ...(fields.draft.pdf?.paper !== undefined ? { paper: fields.draft.pdf.paper } : {}),
      ...(fields.draft.pdf?.landscape !== undefined ? { landscape: fields.draft.pdf.landscape } : {}),
      ...(fields.draft.pdf?.printBackground !== undefined ? { printBackground: fields.draft.pdf.printBackground } : {}),
      ...(margin !== undefined ? { margin } : {}),
    };
    if (Object.keys(pdf).length > 0) next.pdf = pdf;
    return next;
  }
  const width = clampInt(fields.widthText, 200, 3840);
  const height = clampInt(fields.heightText, 200, 16384);
  if (width !== undefined || height !== undefined) {
    next.viewport = {
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };
  }
  if (fields.draft.fullPage !== undefined) next.fullPage = fields.draft.fullPage;
  if (targetFormat === 'jpg') {
    const quality = clampInt(fields.qualityText, 1, 100);
    if (quality !== undefined) next.quality = quality;
  }
  return next;
}

function PdfCaptureSection({
  pdf,
  marginText,
  onMarginChange,
  onUpdatePdf,
}: Readonly<{
  pdf: WebsiteCaptureOptions['pdf'];
  marginText: string;
  onMarginChange: (value: string) => void;
  onUpdatePdf: (patch: Partial<NonNullable<WebsiteCaptureOptions['pdf']>>) => void;
}>) {
  const t = useTranslations('websiteCapture.options');
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>{t('pdfSection')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="capture-pdf-paper" className={LABEL_CLASS}>
            {t('paperLabel')}
          </label>
          <select
            id="capture-pdf-paper"
            value={pdf?.paper ?? 'A4'}
            onChange={(e) => onUpdatePdf({ paper: e.target.value as (typeof PDF_PAPERS)[number] })}
            className={SELECT_CLASS}
          >
            {PDF_PAPERS.map((size) => (
              <option key={size} value={size}>
                {t(`papers.${size}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="capture-pdf-margin" className={LABEL_CLASS}>
            {t('marginLabel')}
          </label>
          <input
            id="capture-pdf-margin"
            type="number"
            min={0}
            max={50}
            step={1}
            placeholder={String(DEFAULT_MARGIN)}
            value={marginText}
            onChange={(e) => onMarginChange(e.target.value)}
            onBlur={() => onMarginChange(formatOptionalNumber(clampFloat(marginText, 0, 50)))}
            className={INPUT_CLASS}
          />
        </div>
      </div>
      <label className={CHECK_ROW}>
        <input
          type="checkbox"
          checked={pdf?.landscape ?? false}
          onChange={(e) => onUpdatePdf({ landscape: e.target.checked })}
          className="size-4 accent-accent cursor-pointer"
        />
        <span>{t('landscapeLabel')}</span>
      </label>
      <label className={CHECK_ROW}>
        <input
          type="checkbox"
          checked={pdf?.printBackground ?? true}
          onChange={(e) => onUpdatePdf({ printBackground: e.target.checked })}
          className="size-4 accent-accent cursor-pointer"
        />
        <span>{t('printBackgroundLabel')}</span>
      </label>
    </section>
  );
}

interface ImageCaptureSectionProps {
  isJpg: boolean;
  fullPage: boolean;
  widthText: string;
  heightText: string;
  qualityText: string;
  onWidthChange: (value: string) => void;
  onHeightChange: (value: string) => void;
  onQualityChange: (value: string) => void;
  onFullPageChange: (value: boolean) => void;
}

function ImageCaptureSection(props: Readonly<ImageCaptureSectionProps>) {
  const t = useTranslations('websiteCapture.options');
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>{t('imageSection')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="capture-viewport-width" className={LABEL_CLASS}>
            {t('viewportWidthLabel')}
          </label>
          <input
            id="capture-viewport-width"
            type="number"
            min={200}
            max={3840}
            step={1}
            placeholder={String(DEFAULT_WIDTH)}
            value={props.widthText}
            onChange={(e) => props.onWidthChange(e.target.value)}
            onBlur={() => props.onWidthChange(formatOptionalNumber(clampInt(props.widthText, 200, 3840)))}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="capture-viewport-height" className={LABEL_CLASS}>
            {t('viewportHeightLabel')}
          </label>
          <input
            id="capture-viewport-height"
            type="number"
            min={200}
            max={16384}
            step={1}
            placeholder={String(DEFAULT_HEIGHT)}
            value={props.heightText}
            onChange={(e) => props.onHeightChange(e.target.value)}
            onBlur={() => props.onHeightChange(formatOptionalNumber(clampInt(props.heightText, 200, 16384)))}
            className={INPUT_CLASS}
          />
        </div>
      </div>
      <label className={CHECK_ROW}>
        <input
          type="checkbox"
          checked={props.fullPage}
          onChange={(e) => props.onFullPageChange(e.target.checked)}
          className="size-4 accent-accent cursor-pointer"
        />
        <span>{t('fullPageLabel')}</span>
      </label>
      {props.isJpg && (
        <div>
          <label htmlFor="capture-jpg-quality" className={LABEL_CLASS}>
            {t('qualityLabel')}
          </label>
          <input
            id="capture-jpg-quality"
            type="number"
            min={1}
            max={100}
            step={1}
            placeholder={String(DEFAULT_QUALITY)}
            value={props.qualityText}
            onChange={(e) => props.onQualityChange(e.target.value)}
            onBlur={() => props.onQualityChange(formatOptionalNumber(clampInt(props.qualityText, 1, 100)))}
            className={INPUT_CLASS}
          />
        </div>
      )}
    </section>
  );
}

export interface CaptureOptionsModalProps {
  targetFormat: 'pdf' | 'png' | 'jpg';
  initialOptions: WebsiteCaptureOptions;
  onSave: (next: WebsiteCaptureOptions) => void;
  onClose: () => void;
}

export default function CaptureOptionsModal({
  targetFormat,
  initialOptions,
  onSave,
  onClose,
}: Readonly<CaptureOptionsModalProps>) {
  const t = useTranslations('websiteCapture.options');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<WebsiteCaptureOptions>(initialOptions);
  const [marginText, setMarginText] = useState(() => formatOptionalNumber(initialOptions.pdf?.margin));
  const [widthText, setWidthText] = useState(() => formatOptionalNumber(initialOptions.viewport?.width));
  const [heightText, setHeightText] = useState(() => formatOptionalNumber(initialOptions.viewport?.height));
  const [qualityText, setQualityText] = useState(() => formatOptionalNumber(initialOptions.quality));

  useModalDialog(dialogRef, true, onClose);

  const handleReset = () => {
    setDraft({});
    setMarginText('');
    setWidthText('');
    setHeightText('');
    setQualityText('');
  };

  const handleSave = () => {
    onSave(buildCaptureOptions(targetFormat, { draft, marginText, widthText, heightText, qualityText }));
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="capture-options-heading"
      className="w-[calc(100dvw-1.5rem)] max-w-lg rounded-xs p-0 bg-surface text-ink border border-rule shadow-elev-2 overflow-hidden"
    >
      <div className="px-5 py-4 border-b border-rule flex items-center justify-between gap-3">
        <h2 id="capture-options-heading" className="text-lg font-semibold leading-snug text-ink">
          {t('title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="min-w-[44px] min-h-[44px] -mr-2 inline-flex items-center justify-center rounded-xs text-ink-2 hover:text-ink hover:bg-sunken transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 space-y-5 max-h-[70dvh] overflow-y-auto">
        {targetFormat === 'pdf' ? (
          <PdfCaptureSection
            pdf={draft.pdf}
            marginText={marginText}
            onMarginChange={setMarginText}
            onUpdatePdf={(patch) => setDraft((prev) => ({ ...prev, pdf: { ...prev.pdf, ...patch } }))}
          />
        ) : (
          <ImageCaptureSection
            isJpg={targetFormat === 'jpg'}
            fullPage={draft.fullPage ?? false}
            widthText={widthText}
            heightText={heightText}
            qualityText={qualityText}
            onWidthChange={setWidthText}
            onHeightChange={setHeightText}
            onQualityChange={setQualityText}
            onFullPageChange={(fullPage) => setDraft((prev) => ({ ...prev, fullPage }))}
          />
        )}

        <section>
          <label htmlFor="capture-wait-until" className={LABEL_CLASS}>
            {t('waitUntilLabel')}
          </label>
          <select
            id="capture-wait-until"
            value={draft.waitUntil ?? 'load'}
            onChange={(e) => setDraft((prev) => ({ ...prev, waitUntil: e.target.value as 'load' | 'idle' }))}
            className={SELECT_CLASS}
          >
            <option value="load">{t('waitUntilLoad')}</option>
            <option value="idle">{t('waitUntilIdle')}</option>
          </select>
          <p className={HELP_TEXT_CLASS}>{t('waitUntilHelp')}</p>
        </section>
      </div>

      <div className="px-5 py-4 border-t border-rule flex items-center justify-between gap-2.5">
        <button
          type="button"
          onClick={handleReset}
          className="min-h-[44px] px-3 text-sm font-medium text-ink-3 hover:text-ink transition-colors cursor-pointer"
        >
          {t('reset')}
        </button>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 text-sm font-medium text-ink-2 hover:text-ink hover:bg-sunken rounded-xs transition-colors cursor-pointer"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="btn-primary min-h-[44px] px-5 rounded-xs text-sm font-medium cursor-pointer"
          >
            {t('save')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
