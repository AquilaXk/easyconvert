import React from 'react';
import { Check, Copy, TrendingUp } from 'lucide-react';
import {
  POPULAR_CONVERSIONS,
  REFERENCE_VALUES,
  convertValue,
  formatEditableDecimal,
  type UnitDefinition,
} from '@/lib/unit-catalog';

export interface ConversionRow {
  key: string;
  name: string;
  symbol: string;
  value: number;
}

function getBreakdownCardClass(isTarget: boolean, isSelf: boolean): string {
  if (isTarget) {
    return 'bg-brand-50 dark:bg-dark-elevated border-brand-400 dark:border-brand-500/60 shadow-sm';
  }
  if (isSelf) {
    return 'bg-neutral-subtle dark:bg-dark-elevated/60 border-neutral-border dark:border-dark-border opacity-80';
  }
  return 'bg-neutral-scaffold dark:bg-dark-elevated border-neutral-border dark:border-dark-border hover:border-brand-400';
}

interface CategoryBreakdownSectionProps {
  inputVal: number;
  fromName: string;
  categoryName: string;
  rows: readonly ConversionRow[];
  fromUnitKey: string;
  toUnitKey: string;
  precision: number;
  copiedKey: string | null;
  onCopyRow: (text: string, key: string) => void;
}

export function CategoryBreakdownSection({
  inputVal,
  fromName,
  categoryName,
  rows,
  fromUnitKey,
  toUnitKey,
  precision,
  copiedKey,
  onCopyRow,
}: Readonly<CategoryBreakdownSectionProps>) {
  const copiedRow = copiedKey ? rows.find((item) => item.key === copiedKey) : undefined;

  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
          {inputVal} {fromName} Converted to All {categoryName} Units
        </h2>
        <span className="text-xs text-ink-muted dark:text-neutral-400">{rows.length} units</span>
      </div>

      <output aria-live="polite" className="sr-only">
        {copiedRow ? `Copied ${copiedRow.name} value to clipboard.` : ''}
      </output>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {rows.map((conv) => {
          const formatted = Number.isFinite(conv.value)
            ? conv.value.toLocaleString(undefined, { maximumFractionDigits: precision })
            : '0';
          const copyText = formatEditableDecimal(conv.value, precision);
          const cardClass = getBreakdownCardClass(conv.key === toUnitKey, conv.key === fromUnitKey);

          return (
            <div
              key={conv.key}
              className={`p-3.5 rounded-lg border transition-colors flex items-center justify-between gap-2 ${cardClass}`}
            >
              <div className="min-w-0">
                <div className="text-xs font-bold text-brand-950 dark:text-white truncate">
                  {conv.name}
                </div>
                <div className="text-sm font-mono font-bold text-brand-700 dark:text-brand-300 truncate">
                  <span>{formatted}</span>{' '}
                  <span className="text-xs text-ink-muted font-sans">{conv.symbol}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onCopyRow(copyText, conv.key)}
                aria-label={`Copy ${conv.name} value`}
                className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] p-2 rounded-md text-ink-muted hover:text-brand-700 dark:hover:text-white hover:bg-brand-100 dark:hover:bg-dark-border transition-colors shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
              >
                {copiedKey === conv.key ? (
                  <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" />
                ) : (
                  <Copy className="w-4 h-4" aria-hidden="true" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface QuickReferenceSectionProps {
  fromDef: UnitDefinition;
  toDef: UnitDefinition;
  precision: number;
}

export function QuickReferenceSection({
  fromDef,
  toDef,
  precision,
}: Readonly<QuickReferenceSectionProps>) {
  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm space-y-4">
      <h2 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
        {fromDef.name} to {toDef.name} Quick Reference Table
      </h2>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs sm:text-sm">
          <thead>
            <tr className="border-b border-neutral-border dark:border-dark-border text-ink-muted dark:text-neutral-400">
              <th scope="col" className="py-2.5 px-4 font-bold">
                {fromDef.name} ({fromDef.symbol})
              </th>
              <th scope="col" className="py-2.5 px-4 font-bold">
                {toDef.name} ({toDef.symbol})
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-border dark:divide-dark-border">
            {REFERENCE_VALUES.map((refVal) => {
              const converted = convertValue(refVal, fromDef, toDef);
              return (
                <tr
                  key={refVal}
                  className="hover:bg-neutral-subtle/50 dark:hover:bg-dark-elevated transition-colors"
                >
                  <td className="py-2.5 px-4 font-mono font-semibold text-brand-950 dark:text-white">
                    {refVal} {fromDef.symbol}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-brand-700 dark:text-brand-300 font-bold">
                    {converted.toLocaleString(undefined, { maximumFractionDigits: precision })}{' '}
                    {toDef.symbol}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface PopularConversionsSectionProps {
  onSelectPreset: (category: string, from: string, to: string) => void;
}

export function PopularConversionsSection({
  onSelectPreset,
}: Readonly<PopularConversionsSectionProps>) {
  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm space-y-4">
      <div className="flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-brand-700 dark:text-brand-400" aria-hidden="true" />
        <h2 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
          Popular Unit Conversions
        </h2>
      </div>

      <div className="flex flex-wrap gap-2.5">
        {POPULAR_CONVERSIONS.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => onSelectPreset(item.category, item.from, item.to)}
            className="min-h-[44px] px-3.5 py-2 rounded-md text-xs font-semibold bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border text-ink-secondary dark:text-neutral-300 hover:text-brand-950 dark:hover:text-white hover:border-brand-400 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
          >
            {item.label}
          </button>
        ))}
      </div>
    </section>
  );
}
