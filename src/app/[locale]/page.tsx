import HomePageView from '@/components/pages/HomePageView';
import PageMessages from '@/i18n/PageMessages';
import { getAnonymousDailyLimit } from '@/lib/plan-limits';
import { siteMetadataBase } from '@/i18n/metadata';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'home', '/');
}

export default async function HomePage({ params }: Readonly<{ params: LocaleParams }>) {
  const locale = await resolvePageLocale(params);
  return (
    <PageMessages page="home" webAppJsonLd={{ kind: 'home', locale }}>
      <HomePageView dailyLimit={getAnonymousDailyLimit()} apiOrigin={siteMetadataBase()?.origin ?? ''} />
    </PageMessages>
  );
}
