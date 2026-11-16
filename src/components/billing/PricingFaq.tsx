import { useTranslations } from 'next-intl';
import { serializeJsonLd } from '@/i18n/metadata';

export const PRICING_FAQ_ITEMS = ['credits', 'baseCost', 'free', 'account', 'packageOrSubscription', 'combine', 'cancel', 'limits', 'deletion', 'api'] as const;

/** The questions of the pricing page, answered from the figures the server enforces (`values`), with matching Schema.org `FAQPage` JSON-LD. */
export default function PricingFaq({ values }: Readonly<{ values: Record<string, number | string> }>) {
  const t = useTranslations('pricing');
  const faqJsonLd = serializeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: PRICING_FAQ_ITEMS.map((item) => ({
      '@type': 'Question',
      name: t(`faq.${item}.question`),
      acceptedAnswer: {
        '@type': 'Answer',
        text: t(`faq.${item}.answer`, values),
      },
    })),
  });
  return (
    <div className="mt-6 space-y-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: faqJsonLd }} />
      {PRICING_FAQ_ITEMS.map((item) => (
        <div key={item}>
          <h3 className="text-base font-semibold text-ink">{t(`faq.${item}.question`)}</h3>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-3">{t(`faq.${item}.answer`, values)}</p>
        </div>
      ))}
    </div>
  );
}
