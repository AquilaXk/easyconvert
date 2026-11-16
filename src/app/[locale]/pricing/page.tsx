import { getTranslations } from 'next-intl/server';
import { PRICING_FAQ_ITEMS } from '@/components/billing/PricingFaq';
import PricingPageView, { pricingLimitValues } from '@/components/pages/PricingPageView';
import PageMessages from '@/i18n/PageMessages';
import { serializeJsonLd } from '@/i18n/metadata';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';
import { readPublicBillingConfig } from '@/lib/billing/config';
import { getAnonymousDailyLimit } from '@/lib/plan-limits';

// Rendered for each request: whether paid plans are on sale is the running server's configuration, which a page made at build time does
// not know. Asked from the browser instead, the paid cards and the answers about them switched from "coming soon" after the page had drawn.
export const dynamic = 'force-dynamic';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'pricing', '/pricing');
}

export default async function PricingPage({ params }: Readonly<{ params: LocaleParams }>) {
  const locale = await resolvePageLocale(params);
  const anonymousDaily = getAnonymousDailyLimit();
  const values = pricingLimitValues(anonymousDaily);
  const tPricing = await getTranslations({ locale, namespace: 'pricing' });
  const faqJsonLd = serializeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: PRICING_FAQ_ITEMS.map((item) => ({
      '@type': 'Question',
      name: tPricing(`faq.${item}.question`),
      acceptedAnswer: {
        '@type': 'Answer',
        text: tPricing(`faq.${item}.answer`, values),
      },
    })),
  });
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: faqJsonLd }} />
      <PageMessages page="pricing">
        <PricingPageView anonymousDaily={anonymousDaily} billing={readPublicBillingConfig()} />
      </PageMessages>
    </>
  );
}
