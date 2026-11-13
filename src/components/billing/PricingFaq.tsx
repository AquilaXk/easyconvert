'use client';

import { useTranslations } from 'next-intl';
import { usePaidPlansOnSale, useRefreshViewerPlan } from '@/hooks/useViewerPlan';
import { formatBytesForDisplay } from '@/lib/format-bytes';
import { PLAN_MAX_FILE_BYTES } from '@/lib/plan-limits';

const FAQ_ITEMS = ['daily', 'account', 'limits', 'deletion', 'api', 'paid'] as const;

/**
 * The questions of the pricing page. The page is prerendered, so it answers as if the paid plans were not on sale; the answers about the
 * file limit and about buying a plan change when the session endpoint says they can be bought (the page already reads it for the header).
 */
export default function PricingFaq({ values }: Readonly<{ values: Record<string, number | string> }>) {
  const t = useTranslations('pricing');
  useRefreshViewerPlan();
  const onSale = usePaidPlansOnSale();
  const answerValues = {
    ...values,
    proSize: formatBytesForDisplay(PLAN_MAX_FILE_BYTES.pro),
    enterpriseSize: formatBytesForDisplay(PLAN_MAX_FILE_BYTES.enterprise),
  };
  const answerOf = (item: (typeof FAQ_ITEMS)[number]): string => {
    if (onSale && item === 'limits') return t('faq.limits.answerOnSale', answerValues);
    if (onSale && item === 'paid') return t('faq.paid.answerOnSale', answerValues);
    return t(`faq.${item}.answer`, answerValues);
  };

  return (
    <div className="mt-6 space-y-8">
      {FAQ_ITEMS.map((item) => (
        <div key={item}>
          <h3 className="text-base font-semibold text-ink">{t(`faq.${item}.question`)}</h3>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-3">{answerOf(item)}</p>
        </div>
      ))}
    </div>
  );
}
