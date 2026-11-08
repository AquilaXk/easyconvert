import { useCallback } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { byteMagnitude, displayByteUnit } from '@/lib/format-bytes';
import { fileTooLargeFacts, PLAN_MAX_FILE_BYTES, type Plan } from '@/lib/plan-limits';

/**
 * Formatting hooks of the page's locale. Each returns the same function while the locale stays, so a callback or an effect
 * that depends on one runs again only when the language changes.
 */

/** Writes a byte count as `formatBytesForDisplay` does (1024 multiples shown as KB, MB and GB, one decimal), with the number in the page's locale. */
export function useFormatBytes(): (bytes: number) => string {
  const format = useFormatter();
  return useCallback(
    (bytes: number) => {
      const { value, unit } = byteMagnitude(bytes);
      return `${format.number(value, { maximumFractionDigits: 1 })} ${displayByteUnit(unit)}`;
    },
    [format]
  );
}

/** The line under the drop zone, for example `Up to 1 GB per file`. */
export function useFileLimitCopy(): (plan: Plan) => string {
  const t = useTranslations('plans');
  const formatBytes = useFormatBytes();
  return useCallback((plan: Plan) => t('fileLimit', { size: formatBytes(PLAN_MAX_FILE_BYTES[plan]) }), [t, formatBytes]);
}

/** The message for a file over its plan's limit, worded from `fileTooLargeFacts`. */
export function useFileTooLargeMessage(): (plan: Plan, sizeBytes: number) => string {
  const t = useTranslations('plans');
  const formatBytes = useFormatBytes();
  return useCallback(
    (plan: Plan, sizeBytes: number) => {
      const facts = fileTooLargeFacts(plan, sizeBytes);
      const size = facts.sizeInExactBytes ? t('exactBytes', { count: sizeBytes }) : formatBytes(sizeBytes);
      const limit = t('tooLarge', { size, limit: formatBytes(facts.limitBytes), plan: facts.plan });
      if (!facts.next) return limit;
      return `${limit} ${t('nextPlanAllows', { plan: facts.next.plan, limit: formatBytes(facts.next.limitBytes) })}`;
    },
    [t, formatBytes]
  );
}

/** The name of an account tier as the session answers it; a tier the copy does not know reads as it came. */
export function useTierLabel(): (tier: string) => string {
  const t = useTranslations('plans.tier');
  return useCallback((tier: string) => (tier === 'free' || tier === 'pro' || tier === 'enterprise' ? t(tier) : tier), [t]);
}
