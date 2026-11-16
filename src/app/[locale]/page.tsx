import { getTranslations } from 'next-intl/server';
import HomePageView from '@/components/pages/HomePageView';
import PageMessages from '@/i18n/PageMessages';
import { getAnonymousDailyLimit } from '@/lib/plan-limits';
import { siteMetadataBase, webApplicationJsonLd } from '@/i18n/metadata';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'home', '/');
}

export default async function HomePage({ params }: Readonly<{ params: LocaleParams }>) {
  const locale = await resolvePageLocale(params);
  const t = await getTranslations({ locale, namespace: 'meta.home' });
  const jsonLd = webApplicationJsonLd({
    locale,
    pathname: '/',
    name: t('title'),
    description: t('description'),
  });
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <PageMessages page="home">
        <HomePageView dailyLimit={getAnonymousDailyLimit()} apiOrigin={siteMetadataBase()?.origin ?? ''} />
      </PageMessages>
    </>
  );
}
