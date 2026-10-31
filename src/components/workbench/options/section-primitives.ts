import { ConversionOptions } from '@/lib/types';

export interface SectionProps {
  options: ConversionOptions;
  onChange: (next: ConversionOptions) => void;
}

export const INPUT_CLASS =
  'w-full min-h-[44px] px-3.5 rounded-md text-base bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border text-brand-950 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus:border-brand-700';

export const LABEL_CLASS =
  'block text-xs font-semibold text-brand-950 dark:text-neutral-200 mb-1.5';

export const SECTION_HEADING_CLASS = 'text-sm font-bold text-brand-950 dark:text-white mb-4';

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

export function pickFromList<T extends string>(
  list: ReadonlyArray<T>,
  raw: string,
  fallback: T
): T {
  return list.find((item) => item === raw) ?? fallback;
}
