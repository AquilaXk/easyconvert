import ApiDocsPageView from '@/components/pages/ApiDocsPageView';
import PageMessages from '@/i18n/PageMessages';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'apiDocs', '/api-docs');
}

export default async function ApiDocsPage({ params }: Readonly<{ params: LocaleParams }>) {
  await resolvePageLocale(params);
  return (
    <PageMessages page="apiDocs">
      <ApiDocsPageView />
    </PageMessages>
  );
}
