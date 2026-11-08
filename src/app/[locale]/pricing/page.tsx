import PricingPageView from '@/components/pages/PricingPageView';
import PageMessages from '@/i18n/PageMessages';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';
import { getAnonymousDailyLimit } from '@/lib/plan-limits';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'pricing', '/pricing');
}

export default async function PricingPage({ params }: Readonly<{ params: LocaleParams }>) {
  await resolvePageLocale(params);
  return (
    <PageMessages page="pricing">
      <PricingPageView anonymousDaily={getAnonymousDailyLimit()} />
    </PageMessages>
  );
}
