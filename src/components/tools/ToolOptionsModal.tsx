'use client';

import React, { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { useModalDialog } from '@/hooks/useModalDialog';
import { defaultToolOptions, type WebTool, type WebToolOptions } from '@/lib/tools/tool-names';
import { HELP_TEXT_CLASS, INPUT_CLASS, LABEL_CLASS, SECTION_HEADING_CLASS, SELECT_CLASS } from '../workbench/options/section-primitives';

/** Each archive format and the key of its label: a key cannot hold a dot. */
const ARCHIVE_FORMATS = [['zip', 'zip'], ['7z', '7z'], ['tar', 'tar'], ['tar.gz', 'tarGz']] as const;
const ROTATIONS = [90, 180, 270] as const;
const RADIO_ROW = 'flex items-center gap-3 min-h-[44px] text-sm font-normal text-ink cursor-pointer';

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
  const byEveryN = !byRanges && options.split?.everyNPages !== undefined;
  return (
    <section className="space-y-3">
      <fieldset>
        <legend className={LABEL_CLASS}>{t('split.label')}</legend>
        <label className={RADIO_ROW}>
          <input type="radio" name="tool-split-mode" checked={!byRanges && !byEveryN} onChange={() => onChange({ ...options, split: {} })} className="size-4 accent-accent cursor-pointer" />
          {t('split.every')}
        </label>
        <label className={RADIO_ROW}>
          <input type="radio" name="tool-split-mode" checked={byRanges} onChange={() => onChange({ ...options, split: { ranges: '' } })} className="size-4 accent-accent cursor-pointer" />
          {t('split.ranges')}
        </label>
        <label className={RADIO_ROW}>
          <input type="radio" name="tool-split-mode" checked={byEveryN} onChange={() => onChange({ ...options, split: { everyNPages: 2 } })} className="size-4 accent-accent cursor-pointer" />
          {t('split.everyN')}
        </label>
      </fieldset>
      {byEveryN && (
        <div>
          <label htmlFor="tool-split-every-n" className={LABEL_CLASS}>{t('split.everyNLabel')}</label>
          <input
            id="tool-split-every-n" type="number" min={1} max={1000} value={options.split?.everyNPages ?? 2}
            onChange={(e) => onChange({ ...options, split: { everyNPages: Math.max(1, Number(e.target.value) || 1) } })}
            className={INPUT_CLASS}
          />
        </div>
      )}
      {byRanges && (
        <div>
          <label htmlFor="tool-split-ranges" className={LABEL_CLASS}>{t('split.rangesLabel')}</label>
          <input
            id="tool-split-ranges" type="text" inputMode="text" autoComplete="off" value={options.split?.ranges ?? ''}
            placeholder={t('split.rangesHint')} onChange={(e) => onChange({ ...options, split: { ranges: e.target.value } })}
            className={INPUT_CLASS}
          />
          <p className={HELP_TEXT_CLASS}>{t('split.rangesHelp')}</p>
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
            <input type="radio" name="tool-rotation" checked={rotation === degrees} onChange={() => setRotate({ rotation: degrees })} className="size-4 accent-accent cursor-pointer" />
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
        <p className={HELP_TEXT_CLASS}>{t('rotate.pagesHelp')}</p>
      </div>
    </section>
  );
}

function ProtectSection({ options, onChange, t }: Readonly<SectionProps>) {
  const protect = options.protect ?? {};
  const perms = protect.permissions ?? {};
  const setProtect = (patch: Partial<NonNullable<WebToolOptions['protect']>>) =>
    onChange({ ...options, protect: { ...protect, ...patch } });
  const setPerm = (patch: Partial<NonNullable<NonNullable<WebToolOptions['protect']>['permissions']>>) =>
    setProtect({ permissions: { ...perms, ...patch } });

  return (
    <>
      <section className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="tool-protect-user" className={LABEL_CLASS}>{t('protect.userPassword')}</label>
            <input
              id="tool-protect-user" type="password" autoComplete="off" value={protect.userPassword ?? ''}
              onChange={(e) => setProtect({ userPassword: e.target.value || undefined })}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label htmlFor="tool-protect-owner" className={LABEL_CLASS}>{t('protect.ownerPassword')}</label>
            <input
              id="tool-protect-owner" type="password" autoComplete="off" value={protect.ownerPassword ?? ''}
              onChange={(e) => setProtect({ ownerPassword: e.target.value || undefined })}
              className={INPUT_CLASS}
            />
          </div>
        </div>
        <div>
          <label htmlFor="tool-protect-keylength" className={LABEL_CLASS}>{t('protect.keyLength')}</label>
          <select
            id="tool-protect-keylength"
            value={protect.keyLength ?? 256}
            onChange={(e) => setProtect({ keyLength: Number(e.target.value) as 128 | 256 })}
            className={SELECT_CLASS}
          >
            <option value={256}>{t('protect.key256')}</option>
            <option value={128}>{t('protect.key128')}</option>
          </select>
        </div>
      </section>
      <section className="space-y-1">
        <h3 className={SECTION_HEADING_CLASS}>{t('protect.permissions')}</h3>
        <label className={RADIO_ROW}>
          <input type="checkbox" checked={perms.print !== 'none'} onChange={(e) => setPerm({ print: e.target.checked ? 'full' : 'none' })} className="size-4 accent-accent cursor-pointer" />
          <span className="select-none">{t('protect.permPrint')}</span>
        </label>
        <label className={RADIO_ROW}>
          <input type="checkbox" checked={perms.extract !== false} onChange={(e) => setPerm({ extract: e.target.checked })} className="size-4 accent-accent cursor-pointer" />
          <span className="select-none">{t('protect.permCopy')}</span>
        </label>
        <label className={RADIO_ROW}>
          <input type="checkbox" checked={perms.modify === 'all'} onChange={(e) => setPerm({ modify: e.target.checked ? 'all' : 'none' })} className="size-4 accent-accent cursor-pointer" />
          <span className="select-none">{t('protect.permModify')}</span>
        </label>
      </section>
    </>
  );
}

function UnlockSection({ options, onChange, t }: Readonly<SectionProps>) {
  const unlock = options.unlock ?? {};
  return (
    <section className="space-y-4">
      <div>
        <label htmlFor="tool-unlock-pass" className={LABEL_CLASS}>{t('unlock.password')}</label>
        <input
          id="tool-unlock-pass" type="password" autoComplete="off" value={unlock.password ?? options.password ?? ''}
          onChange={(e) => onChange({ ...options, unlock: { ...unlock, password: e.target.value || undefined }, password: e.target.value || undefined })}
          className={INPUT_CLASS}
        />
      </div>
      <label className={RADIO_ROW}>
        <input
          type="checkbox"
          checked={unlock.confirmEditRights ?? options.confirmEditRights ?? false}
          onChange={(e) => onChange({ ...options, unlock: { ...unlock, confirmEditRights: e.target.checked }, confirmEditRights: e.target.checked })}
          className="size-4 accent-accent cursor-pointer"
        />
        <span className="select-none">{t('unlock.confirmRights')}</span>
      </label>
    </section>
  );
}

function WatermarkSection({ options, onChange, t }: Readonly<SectionProps>) {
  const watermark = options.watermark ?? {};
  const setWatermark = (patch: Partial<NonNullable<WebToolOptions['watermark']>>) =>
    onChange({ ...options, watermark: { ...watermark, ...patch } });
  return (
    <section className="space-y-4">
      <div>
        <label htmlFor="tool-wm-text" className={LABEL_CLASS}>{t('watermark.text')}</label>
        <input
          id="tool-wm-text" type="text" autoComplete="off" value={watermark.text ?? ''}
          placeholder={t('watermark.textHint')}
          onChange={(e) => setWatermark({ text: e.target.value || undefined })}
          className={INPUT_CLASS}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="tool-wm-position" className={LABEL_CLASS}>{t('watermark.position')}</label>
          <select
            id="tool-wm-position"
            value={watermark.position ?? 'center'}
            onChange={(e) => setWatermark({ position: e.target.value as NonNullable<WebToolOptions['watermark']>['position'] })}
            className={SELECT_CLASS}
          >
            <option value="center">{t('watermark.posCenter')}</option>
            <option value="tile">{t('watermark.posTile')}</option>
            <option value="top-right">{t('watermark.posTopRight')}</option>
            <option value="bottom-right">{t('watermark.posBottomRight')}</option>
          </select>
        </div>
        <div>
          <label htmlFor="tool-wm-opacity" className={LABEL_CLASS}>{t('watermark.opacity')}</label>
          <input
            id="tool-wm-opacity" type="number" min={0.05} max={1} step={0.05} value={watermark.opacity ?? 0.3}
            onChange={(e) => setWatermark({ opacity: Number(e.target.value) })}
            className={INPUT_CLASS}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="tool-wm-rotation" className={LABEL_CLASS}>{t('watermark.rotation')}</label>
          <input
            id="tool-wm-rotation" type="number" min={-180} max={180} step={15} value={watermark.rotation ?? -45}
            onChange={(e) => setWatermark({ rotation: Number(e.target.value) })}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="tool-wm-pages" className={LABEL_CLASS}>{t('watermark.pages')}</label>
          <input
            id="tool-wm-pages" type="text" autoComplete="off" value={watermark.pages ?? ''}
            placeholder={t('watermark.pagesHint')}
            onChange={(e) => setWatermark({ pages: e.target.value || undefined })}
            className={INPUT_CLASS}
          />
        </div>
      </div>
    </section>
  );
}

function PageRangeSection({ options, onChange, t }: Readonly<SectionProps>) {
  return (
    <section className="space-y-3">
      <div>
        <label htmlFor="tool-pages-input" className={LABEL_CLASS}>{t('pages.label')}</label>
        <input
          id="tool-pages-input" type="text" autoComplete="off" value={options.pages ?? ''}
          placeholder={t('pages.hint')} onChange={(e) => onChange({ ...options, pages: e.target.value || undefined })}
          className={INPUT_CLASS}
        />
        <p className={HELP_TEXT_CLASS}>{t('pages.help')}</p>
      </div>
    </section>
  );
}

function PasswordOnlySection({ options, onChange, t }: Readonly<SectionProps>) {
  return (
    <section className="space-y-3">
      <div>
        <label htmlFor="tool-pass-input" className={LABEL_CLASS}>{t('password.label')}</label>
        <input
          id="tool-pass-input" type="password" autoComplete="off" value={options.password ?? ''}
          placeholder={t('password.hint')} onChange={(e) => onChange({ ...options, password: e.target.value || undefined })}
          className={INPUT_CLASS}
        />
      </div>
    </section>
  );
}

const SECTIONS: Partial<Record<WebTool, (props: Readonly<SectionProps>) => React.ReactElement>> = {
  'archive-create': ArchiveSection,
  'archive-extract': PasswordOnlySection,
  split: SplitSection,
  rotate: RotateSection,
  protect: ProtectSection,
  unlock: UnlockSection,
  watermark: WatermarkSection,
  'extract-pages': PageRangeSection,
  'delete-pages': PageRangeSection,
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
      <div className="px-5 sm:px-6 py-4 border-b border-rule flex items-center justify-between gap-4">
        <h2 id="tool-options-title" className="text-lg font-semibold leading-snug text-ink">{t('label', { tool: toolName })}</h2>
        <button
          type="button" aria-label={tModal('close')} onClick={onClose}
          className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-xs border border-rule text-ink-3 hover:text-ink hover:border-accent transition-colors cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-5 sm:px-6 py-5 space-y-6 max-h-[70dvh] overflow-y-auto divide-y divide-rule [&>section:not(:first-child)]:pt-5">
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
          className="btn-primary min-h-[44px] px-5 rounded-xs text-sm font-medium cursor-pointer"
        >
          {tModal('apply')}
        </button>
      </div>
    </dialog>
  );
}
