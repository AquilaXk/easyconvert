import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import NotFoundPageView from '@/components/pages/NotFoundPageView';
import PageMessages from '@/i18n/PageMessages';

/** The 404 page names itself in the tab and to a screen reader, in the language of the path, not as the home page of the layout above it. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta.notFound');
  return { title: t('title'), description: t('description') };
}

export default function LocaleNotFound() {
  return (
    <PageMessages page="notFound">
      <NotFoundPageView />
    </PageMessages>
  );
}
