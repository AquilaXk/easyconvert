'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { usePaidPlansOnSale, useViewerPlan } from '@/hooks/useViewerPlan';
import type { ConversionFailure } from '@/lib/conversion-failure';
import { isQuotaOrBudgetExhausted } from '../i18n/error-wording';

const ACTION_LINK_CLASS =
  'inline-flex min-h-6 items-center text-xs sm:text-sm font-semibold text-accent-ink underline underline-offset-2 whitespace-nowrap';

export function QuotaExhaustedActions({
  failure,
}: Readonly<{ failure: ConversionFailure | null | undefined }>) {
  const t = useTranslations('errors.quotaActions');
  const plan = useViewerPlan();
  const paidPlansOnSale = usePaidPlansOnSale();
  if (!isQuotaOrBudgetExhausted(failure)) return null;
  const showSignIn = plan === 'anonymous';
  if (!showSignIn && !paidPlansOnSale) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {showSignIn && (
        <Link href="/auth" className={ACTION_LINK_CLASS}>
          {t('signIn')}
        </Link>
      )}
      {paidPlansOnSale && (
        <Link href="/pricing" className={ACTION_LINK_CLASS}>
          {t('viewPlans')}
        </Link>
      )}
    </span>
  );
}
