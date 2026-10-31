'use client';

import React from 'react';
import { ConversionOptions } from '@/lib/types';
import {
  INPUT_CLASS, LABEL_CLASS, parseOptionalNonNegativeInt,
  pickFromList, SECTION_HEADING_CLASS, SectionProps,
} from '../OptionsSections';
import type { PasswordMode } from './options-capabilities';

const ORIENTATION_VALUES: ReadonlyArray<NonNullable<ConversionOptions['orientation']>> = ['portrait', 'landscape'];

const OCR_LANGUAGE_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'eng', label: 'English' },
  { value: 'auto', label: 'Automatic Detection' },
  { value: 'kor', label: 'Korean' },
  { value: 'jpn', label: 'Japanese' },
  { value: 'chi_sim', label: 'Chinese (Simplified)' },
  { value: 'deu', label: 'German' },
  { value: 'fra', label: 'French' },
  { value: 'spa', label: 'Spanish' },
];

const DELIMITER_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab (\\t)' },
  { value: '|', label: 'Pipe (|)' },
];

export interface DocumentOptionsSectionProps extends SectionProps {
  canSelectPages: boolean;
  canConfigureLayout: boolean;
  canConfigureOcr: boolean;
}

export function DocumentOptionsSection({
  options, onChange, canSelectPages, canConfigureLayout, canConfigureOcr,
}: Readonly<DocumentOptionsSectionProps>) {
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Document &amp; Page Layout</h3>
      {(canSelectPages || canConfigureLayout) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {canSelectPages && (
            <div>
              <label htmlFor="opt-doc-pages" className={LABEL_CLASS}>Page Range</label>
              <input
                id="opt-doc-pages" type="text" value={options.pages || ''}
                onChange={(e) => onChange({ ...options, pages: e.target.value || undefined })}
                placeholder="All pages (e.g. 1-5)" className={INPUT_CLASS}
              />
            </div>
          )}
          {canConfigureLayout && (
            <div>
              <label htmlFor="opt-doc-orientation" className={LABEL_CLASS}>Orientation</label>
              <select
                id="opt-doc-orientation"
                value={options.orientation || 'portrait'}
                onChange={(e) => onChange({ ...options, orientation: pickFromList(ORIENTATION_VALUES, e.target.value, 'portrait') })}
                className={INPUT_CLASS}
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </div>
          )}
        </div>
      )}
      {canConfigureOcr && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 min-h-[44px]">
            <input
              id="opt-doc-ocr"
              type="checkbox"
              checked={Boolean(options.ocrEnabled)}
              onChange={(e) =>
                onChange({
                  ...options,
                  ocrEnabled: e.target.checked,
                  ocrLanguage: e.target.checked ? options.ocrLanguage || 'eng' : options.ocrLanguage,
                })
              }
              className="w-4 h-4 rounded accent-[#5C6BC0] cursor-pointer"
            />
            <label htmlFor="opt-doc-ocr" className="text-sm text-brand-950 dark:text-neutral-200 cursor-pointer select-none">
              Enable OCR text recognition
            </label>
          </div>
          <div className="max-w-xs">
            <label htmlFor="opt-doc-ocr-lang" className={LABEL_CLASS}>OCR Language</label>
            <select
              id="opt-doc-ocr-lang"
              disabled={!options.ocrEnabled}
              value={options.ocrLanguage || 'eng'}
              onChange={(e) => onChange({ ...options, ocrLanguage: e.target.value })}
              className={`${INPUT_CLASS} disabled:opacity-50`}
            >
              {OCR_LANGUAGE_CHOICES.map((lang) => <option key={lang.value} value={lang.value}>{lang.label}</option>)}
            </select>
          </div>
        </div>
      )}
    </section>
  );
}

export interface PasswordOptionsSectionProps extends SectionProps {
  mode: PasswordMode;
  sourceFormat?: string;
  targetFormat: string;
}

function describePasswordSection(mode: PasswordMode, sourceFormat: string, targetFormat: string) {
  if (mode === 'archive-encrypt') {
    return {
      heading: 'Archive Encryption',
      label: `Output Archive Password (${targetFormat.toUpperCase()})`,
      helper: 'Optional AES-256 password to protect the generated archive.',
    };
  }
  if (mode === 'archive-decrypt') {
    const srcUpper = sourceFormat.toUpperCase();
    return {
      heading: `Archive Password (${srcUpper})`,
      label: `Archive Password (${srcUpper})`,
      helper: 'Enter the password if the source archive is encrypted.',
    };
  }
  return {
    heading: 'PDF Decryption',
    label: 'Open Password (PDF)',
    helper: 'Enter the document open password if the source PDF is encrypted.',
  };
}

export function PasswordOptionsSection({
  options, onChange, mode, sourceFormat = '', targetFormat,
}: Readonly<PasswordOptionsSectionProps>) {
  const copy = describePasswordSection(mode, sourceFormat, targetFormat);
  return (
    <section className="space-y-2">
      <h3 className={SECTION_HEADING_CLASS}>{copy.heading}</h3>
      <div>
        <label htmlFor="opt-doc-password" className={LABEL_CLASS}>{copy.label}</label>
        <input
          id="opt-doc-password" type="password" autoComplete="off" value={options.password || ''}
          onChange={(e) => onChange({ ...options, password: e.target.value || undefined })}
          placeholder="Leave blank if no password is needed" className={INPUT_CLASS}
        />
        <p className="mt-1.5 text-xs text-ink-muted dark:text-neutral-400">{copy.helper}</p>
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
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Tabular &amp; Structured Data</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {canConfigureDelimiter && (
          <div>
            <label htmlFor="opt-data-delimiter" className={LABEL_CLASS}>Field Delimiter</label>
            <select
              id="opt-data-delimiter"
              value={options.delimiter ?? ''}
              onChange={(e) => onChange({ ...options, delimiter: e.target.value || undefined })}
              className={INPUT_CLASS}
            >
              <option value="">Auto (match format)</option>
              {DELIMITER_CHOICES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>
        )}
        {canConfigureSheetIndex && (
          <div>
            <label htmlFor="opt-data-sheet-index" className={LABEL_CLASS}>Worksheet Index (0-based)</label>
            <input
              id="opt-data-sheet-index" type="number" min={0} value={options.sheetIndex ?? ''}
              onChange={(e) => onChange({ ...options, sheetIndex: parseOptionalNonNegativeInt(e.target.value) })}
              placeholder="0 (first sheet)" className={INPUT_CLASS}
            />
          </div>
        )}
      </div>
    </section>
  );
}

export function ArchiveOptionsSection({ options, onChange }: Readonly<SectionProps>) {
  const level = options.compressionLevel ?? 6;
  return (
    <section className="space-y-3">
      <h3 className={SECTION_HEADING_CLASS}>Archive Compression</h3>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="opt-archive-compression" className="text-xs font-semibold text-brand-950 dark:text-neutral-200">
            Compression Level
          </label>
          <span className="text-xs font-mono text-brand-700 dark:text-brand-300">Level {level}</span>
        </div>
        <input id="opt-archive-compression" type="range" min={0} max={9} step={1} value={level} onChange={(e) => onChange({ ...options, compressionLevel: Number(e.target.value) })} className="w-full min-h-[44px] accent-[#5C6BC0] cursor-pointer" />
      </div>
    </section>
  );
}
