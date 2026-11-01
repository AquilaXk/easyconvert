import React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft, Check, Copy, HelpCircle } from 'lucide-react';
import { UNIT_CATEGORIES, type UnitCategory, type UnitDefinition } from '@/lib/unit-catalog';
import { useUnitCopy } from './unit-copy';

interface CategorySelectorBarProps {
  activeCategoryKey: string;
  onSelectCategory: (key: string) => void;
}

export function CategorySelectorBar({
  activeCategoryKey,
  onSelectCategory,
}: Readonly<CategorySelectorBarProps>) {
  const t = useTranslations('unitConverter');
  const { categoryName } = useUnitCopy();
  return (
    <fieldset className="border-0 p-0 m-0 min-w-0">
      <legend className="sr-only">{t('categoriesLegend')}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(UNIT_CATEGORIES).map(([key, cat]) => {
          const Icon = cat.icon;
          const isActive = activeCategoryKey === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelectCategory(key)}
              className={`inline-flex items-center gap-2 min-h-[44px] px-3.5 py-2 rounded-sm text-xs sm:text-sm font-semibold border transition-colors cursor-pointer ${
                isActive
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-surface border-rule text-ink-2 hover:text-ink hover:border-accent'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-ink' : 'text-accent-ink'}`} aria-hidden="true" />
              <span>{categoryName(cat)}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export interface UnitWorkbenchSelection {
  currentCategory: UnitCategory;
  fromDef: UnitDefinition;
  toDef: UnitDefinition;
  fromUnitKey: string;
  toUnitKey: string;
}

export interface UnitWorkbenchValues {
  inputStr: string;
  formattedResult: string;
  rawCopyValue: string;
  precision: number;
  formulaText: string;
  isCopied: boolean;
}

export interface UnitWorkbenchHandlers {
  onChangeInput: (next: string) => void;
  onChangeFromUnit: (next: string) => void;
  onChangeToUnit: (next: string) => void;
  onChangePrecision: (next: number) => void;
  onSwap: () => void;
  onCopyResult: (value: string) => void;
}

export interface UnitWorkbenchCardProps {
  selection: Readonly<UnitWorkbenchSelection>;
  values: Readonly<UnitWorkbenchValues>;
  handlers: Readonly<UnitWorkbenchHandlers>;
}

const PRECISION_CHOICES = [2, 4, 6, 8] as const;

function isEditableNumericDraft(val: string): boolean {
  let hasDot = false;
  const start = val.startsWith('-') ? 1 : 0;
  for (let i = start; i < val.length; i += 1) {
    const code = val.codePointAt(i);
    if (code === 46) {
      if (hasDot) return false;
      hasDot = true;
    } else if (code === undefined || code < 48 || code > 57) {
      return false;
    }
  }
  return true;
}

export function UnitWorkbenchCard({
  selection,
  values,
  handlers,
}: Readonly<UnitWorkbenchCardProps>) {
  const t = useTranslations('unitConverter');
  const { unitName } = useUnitCopy();
  const { currentCategory, fromDef, toDef, fromUnitKey, toUnitKey } = selection;
  const { inputStr, formattedResult, rawCopyValue, precision, formulaText, isCopied } = values;
  const { onChangeInput, onChangeFromUnit, onChangeToUnit, onChangePrecision, onSwap, onCopyResult } = handlers;
  const unitEntries = Object.entries(currentCategory.units);

  return (
    <section className="border-t border-rule-strong pt-6 sm:pt-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-rule pb-5">
        <div>
          <h2 className="text-2xl sm:text-3xl text-ink">
            {t('heading', { from: unitName(currentCategory, fromDef), to: unitName(currentCategory, toDef) })}
          </h2>
          <p className="text-xs sm:text-sm text-ink-2 mt-1">
            {t('intro')}
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <label htmlFor="unit-precision-select" className="text-xs font-semibold text-ink-2">
            {t('decimals')}
          </label>
          <select
            id="unit-precision-select"
            value={precision}
            onChange={(e) => onChangePrecision(Number.parseInt(e.target.value, 10))}
            className="bg-surface/80 min-h-[44px] px-3 py-2 rounded-sm border border-rule-strong text-base text-ink font-medium focus:border-accent cursor-pointer"
          >
            {PRECISION_CHOICES.map((digits) => (
              <option key={digits} value={digits}>{t('decimalsValue', { digits })}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] items-center gap-5">
        <div className="space-y-3 p-5 rounded-md border border-rule">
          <label htmlFor="unit-from-value" className="block text-xs font-semibold uppercase tracking-wider text-ink-2">
            {t('fromValue')}
          </label>
          <input
            id="unit-from-value"
            type="text"
            inputMode="decimal"
            value={inputStr}
            onChange={(e) => {
              const val = e.target.value;
              if (isEditableNumericDraft(val)) onChangeInput(val);
            }}
            placeholder="0"
            className="w-full min-h-[48px] px-4 py-2.5 rounded-sm bg-surface/80 border border-rule-strong text-ink font-mono text-lg sm:text-xl font-bold focus:border-accent transition-colors"
          />

          <label htmlFor="unit-from-select" className="block text-xs font-semibold text-ink-2 pt-1">
            {t('sourceUnit')}
          </label>
          <select
            id="unit-from-select"
            value={fromUnitKey}
            onChange={(e) => onChangeFromUnit(e.target.value)}
            className="w-full min-h-[44px] px-3.5 py-2 rounded-sm bg-surface/80 border border-rule-strong text-base font-medium text-ink focus:border-accent cursor-pointer"
          >
            {unitEntries.map(([key, def]) => (
              <option key={key} value={key}>{unitName(currentCategory, def)} ({def.symbol})</option>
            ))}
          </select>
        </div>

        <div className="flex justify-center">
          <button
            type="button"
            onClick={onSwap}
            aria-label={t('swap')}
            className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] p-2.5 rounded-sm hover:bg-accent-soft text-accent-ink border border-rule transition-colors cursor-pointer"
          >
            <ArrowRightLeft className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 p-5 rounded-md bg-accent-soft/50 border border-accent-edge">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="unit-to-value" className="block text-xs font-semibold uppercase tracking-wider text-accent-ink">
              {t('result', { symbol: toDef.symbol })}
            </label>
            <button
              type="button"
              onClick={() => onCopyResult(rawCopyValue)}
              aria-label={t('copyLabel')}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 rounded-sm text-xs font-semibold bg-surface border border-rule text-accent-ink hover:border-accent transition-colors cursor-pointer"
            >
              {isCopied ? <Check className="w-3.5 h-3.5 text-success" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
              <span>{isCopied ? t('copied') : t('copy')}</span>
            </button>
            <output aria-live="polite" className="sr-only">
              {isCopied ? t('copiedAnnouncement') : ''}
            </output>
          </div>

          <input
            id="unit-to-value"
            type="text"
            readOnly
            value={`${formattedResult} ${toDef.symbol}`}
            className="w-full min-h-[48px] px-4 py-2.5 rounded-sm bg-surface border border-accent-edge text-accent-ink font-mono text-lg sm:text-xl font-bold"
          />

          <label htmlFor="unit-to-select" className="block text-xs font-semibold text-ink-2 pt-1">
            {t('targetUnit')}
          </label>
          <select
            id="unit-to-select"
            value={toUnitKey}
            onChange={(e) => onChangeToUnit(e.target.value)}
            className="w-full min-h-[44px] px-3.5 py-2 rounded-sm bg-surface/80 border border-rule-strong text-base font-medium text-ink focus:border-accent cursor-pointer"
          >
            {unitEntries.map(([key, def]) => (
              <option key={key} value={key}>{unitName(currentCategory, def)} ({def.symbol})</option>
            ))}
          </select>
        </div>
      </div>

      <div className="p-4 rounded-md border border-rule flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-ink-2">
          <HelpCircle className="w-4 h-4 text-accent-ink shrink-0" aria-hidden="true" />
          <span className="px-2 py-0.5 rounded-md bg-surface border border-rule font-semibold text-ink">
            {t('formula')}
          </span>
          <code className="font-mono text-accent-ink font-semibold">{formulaText}</code>
        </div>
        <span className="text-success font-semibold self-start sm:self-auto">
          {t('private')}
        </span>
      </div>
    </section>
  );
}
