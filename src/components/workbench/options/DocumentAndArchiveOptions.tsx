'use client';

import React from 'react';
import { ConversionOptions } from '@/lib/types';
import {
  INPUT_CLASS,
  LABEL_CLASS,
  parseOptionalNonNegativeInt,
  pickFromList,
  SECTION_HEADING_CLASS,
  SectionProps,
} from '../OptionsSections';

const ORIENTATION_VALUES: ReadonlyArray<NonNullable<ConversionOptions['orientation']>> = ['portrait', 'landscape'];
const MARGIN_VALUES: ReadonlyArray<NonNullable<ConversionOptions['margin']>> = ['normal', 'narrow', 'wide'];

const OCR_LANGUAGE_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: 'Automatic Detection' },
  { value: 'eng', label: 'English' },
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
  options,
  onChange,
  canSelectPages,
  canConfigureLayout,
  canConfigureOcr,
}: Readonly<DocumentOptionsSectionProps>) {
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Document &amp; Page Layout</h3>
      {(canSelectPages || canConfigureLayout) && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {canSelectPages && (
            <div>
              <label htmlFor="opt-doc-pages" className={LABEL_CLASS}>Page Range</label>
              <input
                id="opt-doc-pages"
                type="text"
                value={options.pages || ''}
                onChange={(e) => onChange({ ...options, pages: e.target.value || undefined })}
                placeholder="All pages (e.g. 1-5)"
                className={INPUT_CLASS}
              />
            </div>
          )}
          {canConfigureLayout && (
            <>
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
              <div>
                <label htmlFor="opt-doc-margin" className={LABEL_CLASS}>Page Margins</label>
                <select
                  id="opt-doc-margin"
                  value={options.margin || 'normal'}
                  onChange={(e) => onChange({ ...options, margin: pickFromList(MARGIN_VALUES, e.target.value, 'normal') })}
                  className={INPUT_CLASS}
                >
                  <option value="normal">Normal</option>
                  <option value="narrow">Narrow</option>
                  <option value="wide">Wide</option>
                </select>
              </div>
            </>
          )}
        </div>
      )}
      {canConfigureOcr && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 min-h-[44px]">
            <input
              id="opt-doc-ocr"
              type="checkbox"
              checked={options.ocrEnabled !== false}
              onChange={(e) => onChange({ ...options, ocrEnabled: e.target.checked })}
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
              disabled={options.ocrEnabled === false}
              value={options.ocrLanguage || 'auto'}
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
  mode: 'archive-encrypt' | 'pdf-decrypt';
  targetFormat: string;
}

export function PasswordOptionsSection({ options, onChange, mode, targetFormat }: Readonly<PasswordOptionsSectionProps>) {
  const isArchive = mode === 'archive-encrypt';
  const heading = isArchive ? 'Archive Encryption' : 'PDF Decryption';
  const label = isArchive ? `Output Archive Password (${targetFormat.toUpperCase()})` : 'Open Password (PDF)';
  const helper = isArchive
    ? 'Optional AES-256 password to protect the generated archive.'
    : 'Enter the document open password if the source PDF is encrypted.';

  return (
    <section className="space-y-2">
      <h3 className={SECTION_HEADING_CLASS}>{heading}</h3>
      <div>
        <label htmlFor="opt-doc-password" className={LABEL_CLASS}>{label}</label>
        <input
          id="opt-doc-password"
          type="password"
          autoComplete="off"
          value={options.password || ''}
          onChange={(e) => onChange({ ...options, password: e.target.value || undefined })}
          placeholder="Leave blank if no password is needed"
          className={INPUT_CLASS}
        />
        <p className="mt-1.5 text-xs text-ink-muted dark:text-neutral-400">{helper}</p>
      </div>
    </section>
  );
}

export interface DataOptionsSectionProps extends SectionProps {
  canConfigureDelimiter: boolean;
  canConfigureSheetIndex: boolean;
  canConfigureHeaders: boolean;
}

export function DataOptionsSection({
  options,
  onChange,
  canConfigureDelimiter,
  canConfigureSheetIndex,
  canConfigureHeaders,
}: Readonly<DataOptionsSectionProps>) {
  return (
    <section className="space-y-4">
      <h3 className={SECTION_HEADING_CLASS}>Tabular &amp; Structured Data</h3>
      {(canConfigureDelimiter || canConfigureSheetIndex) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {canConfigureDelimiter && (
            <div>
              <label htmlFor="opt-data-delimiter" className={LABEL_CLASS}>Field Delimiter</label>
              <select
                id="opt-data-delimiter"
                value={options.delimiter || ','}
                onChange={(e) => onChange({ ...options, delimiter: e.target.value })}
                className={INPUT_CLASS}
              >
                {DELIMITER_CHOICES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>
          )}
          {canConfigureSheetIndex && (
            <div>
              <label htmlFor="opt-data-sheet-index" className={LABEL_CLASS}>Worksheet Index (0-based)</label>
              <input
                id="opt-data-sheet-index"
                type="number"
                min={0}
                value={options.sheetIndex ?? ''}
                onChange={(e) => onChange({ ...options, sheetIndex: parseOptionalNonNegativeInt(e.target.value) })}
                placeholder="0 (first sheet)"
                className={INPUT_CLASS}
              />
            </div>
          )}
        </div>
      )}
      {canConfigureHeaders && (
        <div className="flex items-center gap-3 min-h-[44px]">
          <input
            id="opt-data-headers"
            type="checkbox"
            checked={options.hasHeaders !== false}
            onChange={(e) => onChange({ ...options, hasHeaders: e.target.checked })}
            className="w-4 h-4 rounded accent-[#5C6BC0] cursor-pointer"
          />
          <label htmlFor="opt-data-headers" className="text-sm text-brand-950 dark:text-neutral-200 cursor-pointer select-none">
            First row contains column headers
          </label>
        </div>
      )}
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
