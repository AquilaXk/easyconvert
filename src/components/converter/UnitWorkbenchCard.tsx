import React from 'react';
import { ArrowRightLeft, Check, Copy, HelpCircle } from 'lucide-react';
import { UNIT_CATEGORIES, type UnitCategory, type UnitDefinition } from '@/lib/unit-catalog';

interface CategorySelectorBarProps {
  activeCategoryKey: string;
  onSelectCategory: (key: string) => void;
}

export function CategorySelectorBar({
  activeCategoryKey,
  onSelectCategory,
}: Readonly<CategorySelectorBarProps>) {
  return (
    <fieldset className="border-0 p-0 m-0 min-w-0">
      <legend className="sr-only">Unit categories</legend>
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
              className={`inline-flex items-center gap-2 min-h-[44px] px-3.5 py-2 rounded-md text-xs sm:text-sm font-semibold border transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 ${
                isActive
                  ? 'bg-brand-700 text-white border-brand-700'
                  : 'bg-white dark:bg-dark-surface border-neutral-border dark:border-dark-border text-ink-secondary dark:text-neutral-300 hover:text-brand-950 dark:hover:text-white hover:border-brand-400'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-brand-700 dark:text-brand-400'}`} aria-hidden="true" />
              <span>{cat.name}</span>
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
  const { currentCategory, fromDef, toDef, fromUnitKey, toUnitKey } = selection;
  const { inputStr, formattedResult, rawCopyValue, precision, formulaText, isCopied } = values;
  const { onChangeInput, onChangeFromUnit, onChangeToUnit, onChangePrecision, onSwap, onCopyResult } = handlers;
  const unitEntries = Object.entries(currentCategory.units);

  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-border dark:border-dark-border pb-5">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-brand-950 dark:text-white">
            {fromDef.name} to {toDef.name} Converter
          </h2>
          <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 mt-1">
            High-precision client calculation with zero network round-trips.
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <label htmlFor="unit-precision-select" className="text-xs font-semibold text-ink-secondary dark:text-neutral-300">
            Decimals
          </label>
          <select
            id="unit-precision-select"
            value={precision}
            onChange={(e) => onChangePrecision(Number.parseInt(e.target.value, 10))}
            className="min-h-[44px] px-3 py-2 rounded-md bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border text-base text-brand-950 dark:text-white font-medium focus:border-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 cursor-pointer"
          >
            <option value={2}>2 decimals</option>
            <option value={4}>4 decimals</option>
            <option value={6}>6 decimals</option>
            <option value={8}>8 decimals</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] items-center gap-5">
        <div className="space-y-3 p-5 rounded-lg bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border">
          <label htmlFor="unit-from-value" className="block text-xs font-semibold uppercase tracking-wider text-ink-secondary dark:text-neutral-300">
            From Value
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
            className="w-full min-h-[48px] px-4 py-2.5 rounded-md bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-brand-950 dark:text-white font-mono text-lg sm:text-xl font-bold focus:border-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 transition-colors"
          />

          <label htmlFor="unit-from-select" className="block text-xs font-semibold text-ink-secondary dark:text-neutral-300 pt-1">
            Source Unit
          </label>
          <select
            id="unit-from-select"
            value={fromUnitKey}
            onChange={(e) => onChangeFromUnit(e.target.value)}
            className="w-full min-h-[44px] px-3.5 py-2 rounded-md bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-base font-medium text-brand-950 dark:text-white focus:border-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 cursor-pointer"
          >
            {unitEntries.map(([key, def]) => (
              <option key={key} value={key}>{def.name} ({def.symbol})</option>
            ))}
          </select>
        </div>

        <div className="flex justify-center">
          <button
            type="button"
            onClick={onSwap}
            aria-label="Swap source and target units"
            className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] p-2.5 rounded-md bg-neutral-scaffold hover:bg-brand-50 dark:bg-dark-elevated dark:hover:bg-dark-border text-brand-700 dark:text-brand-300 border border-neutral-border dark:border-dark-border transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
          >
            <ArrowRightLeft className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 p-5 rounded-lg bg-brand-50/50 dark:bg-dark-elevated border border-brand-200 dark:border-dark-border">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="unit-to-value" className="block text-xs font-semibold uppercase tracking-wider text-brand-700 dark:text-brand-400">
              Converted Result ({toDef.symbol})
            </label>
            <button
              type="button"
              onClick={() => onCopyResult(rawCopyValue)}
              aria-label="Copy converted result"
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 rounded-md text-xs font-semibold bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-brand-700 dark:text-brand-300 hover:border-brand-400 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
            >
              {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
              <span>{isCopied ? 'Copied' : 'Copy'}</span>
            </button>
            <output aria-live="polite" className="sr-only">
              {isCopied ? 'Copied converted result to clipboard.' : ''}
            </output>
          </div>

          <input
            id="unit-to-value"
            type="text"
            readOnly
            value={`${formattedResult} ${toDef.symbol}`}
            className="w-full min-h-[48px] px-4 py-2.5 rounded-md bg-white dark:bg-dark-surface border border-brand-300 dark:border-dark-border text-brand-700 dark:text-brand-300 font-mono text-lg sm:text-xl font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
          />

          <label htmlFor="unit-to-select" className="block text-xs font-semibold text-ink-secondary dark:text-neutral-300 pt-1">
            Target Unit
          </label>
          <select
            id="unit-to-select"
            value={toUnitKey}
            onChange={(e) => onChangeToUnit(e.target.value)}
            className="w-full min-h-[44px] px-3.5 py-2 rounded-md bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-base font-medium text-brand-950 dark:text-white focus:border-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 cursor-pointer"
          >
            {unitEntries.map(([key, def]) => (
              <option key={key} value={key}>{def.name} ({def.symbol})</option>
            ))}
          </select>
        </div>
      </div>

      <div className="p-4 rounded-lg bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-ink-secondary dark:text-neutral-300">
          <HelpCircle className="w-4 h-4 text-brand-700 dark:text-brand-400 shrink-0" aria-hidden="true" />
          <span className="px-2 py-0.5 rounded bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border font-semibold text-brand-950 dark:text-white">
            Formula
          </span>
          <code className="font-mono text-brand-700 dark:text-brand-300 font-semibold">{formulaText}</code>
        </div>
        <span className="text-emerald-700 dark:text-emerald-400 font-semibold self-start sm:self-auto">
          100% In-Browser &amp; Private
        </span>
      </div>
    </section>
  );
}
