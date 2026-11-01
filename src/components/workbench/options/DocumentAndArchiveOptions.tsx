'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import {
  INPUT_CLASS,
  SELECT_CLASS,
  RANGE_CLASS,
  rangeFill,
  LABEL_CLASS,
  parseOptionalNonNegativeInt,
  SECTION_HEADING_CLASS,
  type SectionProps,
} from './section-primitives';
import { getPasswordValidationError, type PasswordMode } from './options-capabilities';

/** OCR language codes; each one's name is `options.document.ocrLanguages.<code>` in the messages. */
const OCR_LANGUAGE_CHOICES = ['eng', 'auto', 'kor', 'jpn', 'chi_sim', 'deu', 'fra', 'spa'] as const;

const DELIMITER_CHOICES: ReadonlyArray<{ value: string; key: 'comma' | 'semicolon' | 'tab' | 'pipe' }> = [
  { value: ',', key: 'comma' },
  { value: ';', key: 'semicolon' },
  { value: '\t', key: 'tab' },
  { value: '|', key: 'pipe' },
];

export interface DocumentOptionsSectionProps extends SectionProps {
  canSelectPages: boolean;
  canConfigureLayout: boolean;
  canConfigureOcr: boolean;
  ocrAlwaysEnabled?: boolean;
}

function OcrOptionsFields({
  options,
  onChange,
  ocrAlwaysEnabled,
}: Readonly<SectionProps & { ocrAlwaysEnabled: boolean }>) {
  const t = useTranslations('options.document');
  const ocrActive = Boolean(options.ocrEnabled);
  return (
    <div className="space-y-3">
      {ocrAlwaysEnabled ? (
        <p className="text-xs text-ink-2">
          {t('ocrAutomatic')}
        </p>
      ) : (
        <div className="flex items-center gap-3 min-h-[44px]">
          <input
            id="opt-doc-ocr"
            type="checkbox"
            checked={ocrActive}
            onChange={(e) =>
              onChange({
                ...options,
                ocrEnabled: e.target.checked ? true : undefined,
                ocrLanguage: e.target.checked ? options.ocrLanguage || 'eng' : undefined,
              })
            }
            className="size-4 cursor-pointer"
          />
          <label htmlFor="opt-doc-ocr" className="text-sm text-ink cursor-pointer select-none">
            {t('ocrEnable')}
          </label>
        </div>
      )}
      <div className="max-w-xs">
        <label htmlFor="opt-doc-ocr-lang" className={LABEL_CLASS}>{t('ocrLanguage')}</label>
        <select
          id="opt-doc-ocr-lang"
          disabled={!ocrAlwaysEnabled && !ocrActive}
          value={options.ocrLanguage || 'eng'}
          onChange={(e) => onChange({ ...options, ocrLanguage: e.target.value })}
          className={`${SELECT_CLASS} disabled:opacity-50`}
        >
          {OCR_LANGUAGE_CHOICES.map((code) => (
            <option key={code} value={code}>{t(`ocrLanguages.${code}`)}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function DocumentOptionsSection({
  options,
  onChange,
  canSelectPages,
  canConfigureLayout,
  canConfigureOcr,
  ocrAlwaysEnabled = false,
}: Readonly<DocumentOptionsSectionProps>) {
  const t = useTranslations('options.document');
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>{t('heading')}</h3>
      {(canSelectPages || canConfigureLayout) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {canSelectPages && (
            <div>
              <label htmlFor="opt-doc-pages" className={LABEL_CLASS}>{t('pages')}</label>
              <input
                id="opt-doc-pages"
                type="text"
                value={options.pages || ''}
                onChange={(e) => onChange({ ...options, pages: e.target.value || undefined })}
                placeholder={t('pagesPlaceholder')}
                className={INPUT_CLASS}
              />
            </div>
          )}
          {canConfigureLayout && (
            <div>
              <label htmlFor="opt-doc-orientation" className={LABEL_CLASS}>{t('orientation')}</label>
              <select
                id="opt-doc-orientation"
                value={options.orientation ?? ''}
                onChange={(e) =>
                  onChange({
                    ...options,
                    orientation: e.target.value ? (e.target.value as 'portrait' | 'landscape') : undefined,
                  })
                }
                className={SELECT_CLASS}
              >
                <option value="">{t('orientationAuto')}</option>
                <option value="portrait">{t('portrait')}</option>
                <option value="landscape">{t('landscape')}</option>
              </select>
            </div>
          )}
        </div>
      )}
      {canConfigureOcr && (
        <OcrOptionsFields options={options} onChange={onChange} ocrAlwaysEnabled={ocrAlwaysEnabled} />
      )}
    </section>
  );
}

export interface PasswordOptionsSectionProps extends SectionProps {
  mode: PasswordMode;
  sourceFormat?: string;
  targetFormat: string;
}

type PasswordTranslator = ReturnType<typeof useTranslations<'options.password'>>;

function describePasswordSection(t: PasswordTranslator, mode: PasswordMode, sourceFormat: string, targetFormat: string) {
  const tgt = targetFormat.toUpperCase();
  const isZip = targetFormat.toLowerCase() === 'zip';
  const maxLength = isZip ? 99 : 256;
  const zipConstraint = isZip ? ` ${t('zipConstraint')}` : '';
  if (mode === 'archive-encrypt') {
    return {
      heading: t('encrypt.heading'),
      label: t('encrypt.label', { tgt }),
      helper: `${t('encrypt.helper')}${zipConstraint}`,
      maxLength,
    };
  }
  if (mode === 'archive-reencrypt') {
    const src = sourceFormat ? sourceFormat.toUpperCase() : t('reencrypt.sourceFallback');
    return {
      heading: t('reencrypt.heading'),
      label: t('reencrypt.label', { src, tgt }),
      helper: `${t('reencrypt.helper', { src, tgt })}${zipConstraint}`,
      maxLength,
    };
  }
  return {
    heading: t('decrypt.heading'),
    label: t('decrypt.label'),
    helper: t('decrypt.helper'),
    maxLength,
  };
}

export function PasswordOptionsSection({
  options,
  onChange,
  mode,
  sourceFormat = '',
  targetFormat,
}: Readonly<PasswordOptionsSectionProps>) {
  const t = useTranslations('options.password');
  const copy = describePasswordSection(t, mode, sourceFormat, targetFormat);
  const effectiveSource = sourceFormat || (mode === 'pdf-decrypt' ? 'pdf' : '');
  const passwordProblem = getPasswordValidationError(effectiveSource, targetFormat, options.password);
  const passwordError = passwordProblem ? t(`errors.${passwordProblem}`) : null;
  const hasInvalidPassword = passwordError !== null;
  return (
    <section className="space-y-2">
      <h3 className={SECTION_HEADING_CLASS}>{copy.heading}</h3>
      <div>
        <label htmlFor="opt-doc-password" className={LABEL_CLASS}>{copy.label}</label>
        <input
          id="opt-doc-password"
          type="password"
          autoComplete="off"
          maxLength={copy.maxLength}
          aria-invalid={hasInvalidPassword || undefined}
          aria-describedby={hasInvalidPassword ? 'opt-doc-password-error' : 'opt-doc-password-help'}
          value={options.password || ''}
          onChange={(e) => onChange({ ...options, password: e.target.value || undefined })}
          placeholder={t('placeholder')}
          className={INPUT_CLASS}
        />
        {passwordError && (
          <p id="opt-doc-password-error" role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {passwordError}
          </p>
        )}
        <p id="opt-doc-password-help" className="mt-1.5 text-xs text-ink-3">{copy.helper}</p>
      </div>
    </section>
  );
}

export interface DataOptionsSectionProps extends SectionProps {
  canConfigureDelimiter: boolean;
  canConfigureSheetIndex: boolean;
}

export function DataOptionsSection({
  options, onChange, canConfigureDelimiter, canConfigureSheetIndex,
}: Readonly<DataOptionsSectionProps>) {
  const t = useTranslations('options.data');
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>{t('heading')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {canConfigureDelimiter && (
          <div>
            <label htmlFor="opt-data-delimiter" className={LABEL_CLASS}>{t('delimiter')}</label>
            <select
              id="opt-data-delimiter"
              value={options.delimiter ?? ''}
              onChange={(e) => onChange({ ...options, delimiter: e.target.value || undefined })}
              className={SELECT_CLASS}
            >
              <option value="">{t('delimiterAuto')}</option>
              {DELIMITER_CHOICES.map((d) => <option key={d.value} value={d.value}>{t(`delimiters.${d.key}`)}</option>)}
            </select>
          </div>
        )}
        {canConfigureSheetIndex && (
          <div>
            <label htmlFor="opt-data-sheet-index" className={LABEL_CLASS}>{t('sheetIndex')}</label>
            <input
              id="opt-data-sheet-index" type="number" min={0} value={options.sheetIndex ?? ''}
              onChange={(e) => {
                const nextIndex = parseOptionalNonNegativeInt(e.target.value);
                onChange({
                  ...options,
                  sheetIndex: nextIndex,
                  sheetMode: nextIndex === undefined ? undefined : 'index',
                });
              }}
              placeholder={t('sheetIndexPlaceholder')} className={INPUT_CLASS}
            />
          </div>
        )}
      </div>
    </section>
  );
}

export function ArchiveOptionsSection({ options, onChange }: Readonly<SectionProps>) {
  const t = useTranslations('options.archive');
  const level = options.compressionLevel ?? 6;
  return (
    <section className="space-y-3">
      <h3 className={SECTION_HEADING_CLASS}>{t('heading')}</h3>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="opt-archive-compression" className="text-xs font-semibold text-ink">
            {t('level')}
          </label>
          <span className="text-xs font-mono text-accent-ink">{t('levelValue', { level })}</span>
        </div>
        <input id="opt-archive-compression" type="range" min={0} max={9} step={1} value={level} onChange={(e) => onChange({ ...options, compressionLevel: Number(e.target.value) })} className={RANGE_CLASS} style={rangeFill(level, 0, 9)} />
      </div>
    </section>
  );
}
