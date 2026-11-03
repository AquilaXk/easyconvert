import NotFoundPageView from '@/components/pages/NotFoundPageView';
import PageMessages from '@/i18n/PageMessages';

export default function LocaleNotFound() {
  return (
    <PageMessages page="notFound">
      <NotFoundPageView />
    </PageMessages>
  );
}
