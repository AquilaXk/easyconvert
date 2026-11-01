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
    return 'bg-accent-soft border-accent';
  }
  if (isSelf) {
    return 'bg-sunken border-rule opacity-80';
  }
  return 'border-rule hover:border-accent';
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
    <section className="border-t border-rule-strong pt-6 sm:pt-8 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg sm:text-xl text-ink">
          {inputVal} {fromName} Converted to All {categoryName} Units
        </h2>
        <span className="text-xs text-ink-3">{rows.length} units</span>
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
              className={`p-3.5 rounded-md border transition-colors flex items-center justify-between gap-2 ${cardClass}`}
            >
              <div className="min-w-0">
                <div className="text-xs font-bold text-ink truncate">
                  {conv.name}
                </div>
                <div className="text-sm font-mono font-bold text-accent-ink truncate">
                  <span>{formatted}</span>{' '}
                  <span className="text-xs text-ink-3 font-sans">{conv.symbol}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onCopyRow(copyText, conv.key)}
                aria-label={`Copy ${conv.name} value`}
                className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] p-2 rounded-sm text-ink-3 hover:text-accent-ink hover:bg-accent-soft transition-colors shrink-0 cursor-pointer"
              >
                {copiedKey === conv.key ? (
                  <Check className="w-4 h-4 text-success" aria-hidden="true" />
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
    <section className="border-t border-rule-strong pt-6 sm:pt-8 space-y-4">
      <h2 className="text-lg sm:text-xl text-ink">
        {fromDef.name} to {toDef.name} Quick Reference Table
      </h2>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs sm:text-sm">
          <thead>
            <tr className="border-b border-rule text-ink-3">
              <th scope="col" className="py-2.5 px-4 font-bold">
                {fromDef.name} ({fromDef.symbol})
              </th>
              <th scope="col" className="py-2.5 px-4 font-bold">
                {toDef.name} ({toDef.symbol})
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {REFERENCE_VALUES.map((refVal) => {
              const converted = convertValue(refVal, fromDef, toDef);
              return (
                <tr
                  key={refVal}
                  className="hover:bg-sunken/50 transition-colors"
                >
                  <td className="py-2.5 px-4 font-mono font-semibold text-ink">
                    {refVal} {fromDef.symbol}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-accent-ink font-bold">
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
    <section className="border-t border-rule-strong pt-6 sm:pt-8 space-y-4">
      <div className="flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-accent-ink" aria-hidden="true" />
        <h2 className="text-lg sm:text-xl text-ink">
          Popular Unit Conversions
        </h2>
      </div>

      <div className="flex flex-wrap gap-2.5">
        {POPULAR_CONVERSIONS.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => onSelectPreset(item.category, item.from, item.to)}
            className="min-h-[44px] px-3.5 py-2 rounded-sm text-xs font-semibold border border-rule text-ink-2 hover:text-ink hover:border-accent transition-colors cursor-pointer"
          >
            {item.label}
          </button>
        ))}
      </div>
    </section>
  );
}
