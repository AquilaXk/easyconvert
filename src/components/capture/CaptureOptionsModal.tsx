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

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampFloat(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
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

  useModalDialog(dialogRef, true, onClose);

  const isPdf = targetFormat === 'pdf';
  const isJpg = targetFormat === 'jpg';
  const waitUntil = draft.waitUntil ?? 'load';
  const paper = draft.pdf?.paper ?? 'A4';
  const landscape = draft.pdf?.landscape ?? false;
  const margin = draft.pdf?.margin ?? DEFAULT_MARGIN;
  const printBackground = draft.pdf?.printBackground ?? true;
  const viewportWidth = draft.viewport?.width ?? DEFAULT_WIDTH;
  const viewportHeight = draft.viewport?.height ?? DEFAULT_HEIGHT;
  const fullPage = draft.fullPage ?? false;
  const quality = draft.quality ?? DEFAULT_QUALITY;

  const updatePdf = (patch: Partial<NonNullable<WebsiteCaptureOptions['pdf']>>) => {
    setDraft((prev) => ({ ...prev, pdf: { ...prev.pdf, ...patch } }));
  };

  const updateViewport = (patch: Partial<NonNullable<WebsiteCaptureOptions['viewport']>>) => {
    setDraft((prev) => ({ ...prev, viewport: { ...prev.viewport, ...patch } }));
  };

  const handleReset = () => {
    setDraft({});
  };

  const handleSave = () => {
    onSave(draft);
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
        {isPdf ? (
          <section className="space-y-4">
            <h3 className={SECTION_HEADING_CLASS}>{t('pdfSection')}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="capture-pdf-paper" className={LABEL_CLASS}>
                  {t('paperLabel')}
                </label>
                <select
                  id="capture-pdf-paper"
                  value={paper}
                  onChange={(e) => updatePdf({ paper: e.target.value as (typeof PDF_PAPERS)[number] })}
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
                  value={margin}
                  onChange={(e) => updatePdf({ margin: clampFloat(e.target.value, 0, 50, DEFAULT_MARGIN) })}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <label className={CHECK_ROW}>
              <input
                type="checkbox"
                checked={landscape}
                onChange={(e) => updatePdf({ landscape: e.target.checked })}
                className="size-4 accent-accent cursor-pointer"
              />
              <span>{t('landscapeLabel')}</span>
            </label>
            <label className={CHECK_ROW}>
              <input
                type="checkbox"
                checked={printBackground}
                onChange={(e) => updatePdf({ printBackground: e.target.checked })}
                className="size-4 accent-accent cursor-pointer"
              />
              <span>{t('printBackgroundLabel')}</span>
            </label>
          </section>
        ) : (
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
                  value={viewportWidth}
                  onChange={(e) => updateViewport({ width: clampInt(e.target.value, 200, 3840, DEFAULT_WIDTH) })}
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
                  value={viewportHeight}
                  onChange={(e) => updateViewport({ height: clampInt(e.target.value, 200, 16384, DEFAULT_HEIGHT) })}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <label className={CHECK_ROW}>
              <input
                type="checkbox"
                checked={fullPage}
                onChange={(e) => setDraft((prev) => ({ ...prev, fullPage: e.target.checked }))}
                className="size-4 accent-accent cursor-pointer"
              />
              <span>{t('fullPageLabel')}</span>
            </label>
            {isJpg && (
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
                  value={quality}
                  onChange={(e) => setDraft((prev) => ({ ...prev, quality: clampInt(e.target.value, 1, 100, DEFAULT_QUALITY) }))}
                  className={INPUT_CLASS}
                />
              </div>
            )}
          </section>
        )}

        <section>
          <label htmlFor="capture-wait-until" className={LABEL_CLASS}>
            {t('waitUntilLabel')}
          </label>
          <select
            id="capture-wait-until"
            value={waitUntil}
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
