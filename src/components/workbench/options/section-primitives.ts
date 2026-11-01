import { ConversionOptions } from '@/lib/types';

export interface SectionProps {
  options: ConversionOptions;
  onChange: (next: ConversionOptions) => void;
}

export const INPUT_CLASS =
  'w-full min-h-[44px] px-3.5 rounded-sm text-base bg-surface/80 border border-rule-strong text-ink focus:border-accent';

export const LABEL_CLASS =
  'block text-xs font-semibold text-ink mb-1.5';

export const SECTION_HEADING_CLASS = 'text-sm font-bold text-ink mb-4';

export function parseOptionalPositiveInt(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

export function parseOptionalNonNegativeInt(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed;
}
