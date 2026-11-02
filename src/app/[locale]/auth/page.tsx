import AuthPageView from '@/components/pages/AuthPageView';
import PageMessages from '@/i18n/PageMessages';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'auth', '/auth');
}

export default async function AuthPage({ params }: Readonly<{ params: LocaleParams }>) {
  await resolvePageLocale(params);
  return (
    <PageMessages page="auth">
      <AuthPageView />
    </PageMessages>
  );
}
