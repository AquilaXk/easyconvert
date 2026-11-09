'use client';

import React, { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { useModalDialog } from '@/hooks/useModalDialog';
import { defaultToolOptions, type WebTool, type WebToolOptions } from '@/lib/tools/tool-names';
import { INPUT_CLASS, LABEL_CLASS, SELECT_CLASS } from '../workbench/options/section-primitives';

/** Each archive format and the key of its label: a key cannot hold a dot. */
const ARCHIVE_FORMATS = [['zip', 'zip'], ['7z', '7z'], ['tar', 'tar'], ['tar.gz', 'tarGz']] as const;
const ROTATIONS = [90, 180, 270] as const;
const RADIO_ROW = 'flex items-center gap-3 min-h-[44px] text-sm text-ink cursor-pointer';

type Rotation = (typeof ROTATIONS)[number];
type OptionsTranslator = ReturnType<typeof useTranslations<'tools.options'>>;

interface SectionProps {
  options: WebToolOptions;
  onChange: (next: WebToolOptions) => void;
  t: OptionsTranslator;
}

function ArchiveSection({ options, onChange, t }: Readonly<SectionProps>) {
  return (
    <section>
      <label htmlFor="tool-archive-format" className={LABEL_CLASS}>{t('format.label')}</label>
      <select id="tool-archive-format" value={options.format ?? 'zip'} onChange={(e) => onChange({ ...options, format: e.target.value })} className={SELECT_CLASS}>
        {ARCHIVE_FORMATS.map(([format, key]) => <option key={format} value={format}>{t(`format.${key}`)}</option>)}
      </select>
    </section>
  );
}

function SplitSection({ options, onChange, t }: Readonly<SectionProps>) {
  const byRanges = options.split?.ranges !== undefined;
  return (
    <section className="space-y-3">
      <fieldset>
        <legend className={LABEL_CLASS}>{t('split.label')}</legend>
        <label className={RADIO_ROW}>
          <input type="radio" name="tool-split-mode" checked={!byRanges} onChange={() => onChange({ ...options, split: {} })} className="size-4" />
          {t('split.every')}
        </label>
        <label className={RADIO_ROW}>
          <input type="radio" name="tool-split-mode" checked={byRanges} onChange={() => onChange({ ...options, split: { ranges: '' } })} className="size-4" />
          {t('split.ranges')}
        </label>
      </fieldset>
      {byRanges && (
        <div>
          <label htmlFor="tool-split-ranges" className={LABEL_CLASS}>{t('split.rangesLabel')}</label>
          <input
            id="tool-split-ranges" type="text" inputMode="text" autoComplete="off" value={options.split?.ranges ?? ''}
            placeholder={t('split.rangesHint')} onChange={(e) => onChange({ ...options, split: { ranges: e.target.value } })}
            className={INPUT_CLASS}
          />
          <p className="mt-1.5 text-xs text-ink-3">{t('split.rangesHelp')}</p>
        </div>
      )}
    </section>
  );
}

function RotateSection({ options, onChange, t }: Readonly<SectionProps>) {
  const rotation = options.rotate?.rotation ?? 90;
  const setRotate = (next: { rotation?: Rotation; pages?: string }) => onChange({ ...options, rotate: { ...options.rotate, ...next } });
  return (
    <section className="space-y-3">
      <fieldset>
        <legend className={LABEL_CLASS}>{t('rotate.label')}</legend>
        {ROTATIONS.map((degrees) => (
          <label key={degrees} className={RADIO_ROW}>
            <input type="radio" name="tool-rotation" checked={rotation === degrees} onChange={() => setRotate({ rotation: degrees })} className="size-4" />
            {t(`rotate.r${degrees}`)}
          </label>
        ))}
      </fieldset>
      <div>
        <label htmlFor="tool-rotate-pages" className={LABEL_CLASS}>{t('rotate.pagesLabel')}</label>
        <input
          id="tool-rotate-pages" type="text" autoComplete="off" value={options.rotate?.pages ?? ''}
          placeholder={t('rotate.pagesHint')} onChange={(e) => setRotate({ pages: e.target.value.trim() === '' ? undefined : e.target.value })}
          className={INPUT_CLASS}
        />
        <p className="mt-1.5 text-xs text-ink-3">{t('rotate.pagesHelp')}</p>
      </div>
    </section>
  );
}

const SECTIONS: Partial<Record<WebTool, (props: Readonly<SectionProps>) => React.ReactElement>> = {
  'archive-create': ArchiveSection,
  split: SplitSection,
  rotate: RotateSection,
};

interface ToolOptionsModalProps {
  tool: WebTool;
  /** The name the dialog's heading carries: the page's title. */
  toolName: string;
  initialOptions: WebToolOptions;
  onSave: (options: WebToolOptions) => void;
  onClose: () => void;
}

/** The options dialog of a tool page, in the shell of the converter's options dialog. */
export default function ToolOptionsModal({ tool, toolName, initialOptions, onSave, onClose }: Readonly<ToolOptionsModalProps>) {
  const t = useTranslations('tools.options');
  const tModal = useTranslations('options.modal');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<WebToolOptions>(initialOptions);
  useModalDialog(dialogRef, true, onClose);
  const Section = SECTIONS[tool];

  return (
    <dialog ref={dialogRef} aria-labelledby="tool-options-title" className="w-full max-w-lg rounded-xs p-0 bg-surface text-ink border border-rule shadow-elev-2">
      <div className="px-5 sm:px-6 py-4 border-b border-rule flex items-start justify-between gap-4">
        <h2 id="tool-options-title" className="text-base font-semibold text-ink">{t('label', { tool: toolName })}</h2>
        <button
          type="button" aria-label={tModal('close')} onClick={onClose}
          className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-xs border border-rule text-ink-3 hover:text-ink hover:border-accent transition-colors cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-5 sm:px-6 py-5 max-h-[70dvh] overflow-y-auto">
        {Section && <Section options={options} onChange={setOptions} t={t} />}
      </div>
      <div className="px-5 sm:px-6 py-4 bg-sunken/50 border-t border-rule rounded-b-xs flex items-center justify-between gap-3">
        <button
          type="button" onClick={() => setOptions(defaultToolOptions(tool))}
          className="transition-colors min-h-[44px] px-4 rounded-xs border border-rule text-sm font-medium text-ink-2 hover:text-ink hover:border-accent cursor-pointer"
        >
          {tModal('reset')}
        </button>
        <button
          type="button" onClick={() => { onSave(options); onClose(); }}
          className="btn-primary min-h-[44px] px-5 rounded-xs text-sm font-semibold cursor-pointer"
        >
          {tModal('apply')}
        </button>
      </div>
    </dialog>
  );
}
