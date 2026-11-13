import { useTranslations } from 'next-intl';

const FAQ_ITEMS = ['credits', 'baseCost', 'free', 'account', 'packageOrSubscription', 'combine', 'cancel', 'limits', 'deletion', 'api'] as const;

/** The questions of the pricing page, answered from the figures the server enforces (`values`). */
export default function PricingFaq({ values }: Readonly<{ values: Record<string, number | string> }>) {
  const t = useTranslations('pricing');
  return (
    <div className="mt-6 space-y-8">
      {FAQ_ITEMS.map((item) => (
        <div key={item}>
          <h3 className="text-base font-semibold text-ink">{t(`faq.${item}.question`)}</h3>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-3">{t(`faq.${item}.answer`, values)}</p>
        </div>
      ))}
    </div>
  );
}
