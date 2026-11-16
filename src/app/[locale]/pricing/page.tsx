import PricingPageView from '@/components/pages/PricingPageView';
import PageMessages from '@/i18n/PageMessages';
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
  await resolvePageLocale(params);
  return (
    <PageMessages page="pricing">
      <PricingPageView anonymousDaily={getAnonymousDailyLimit()} billing={readPublicBillingConfig()} />
    </PageMessages>
  );
}
