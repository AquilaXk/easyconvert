import ForgotPasswordPageView from '@/components/pages/ForgotPasswordPageView';
import PageMessages from '@/i18n/PageMessages';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export async function generateMetadata({ params }: { params: LocaleParams }) {
  const metadata = await localizedPageMetadata(params, 'passwordReset', '/auth/forgot-password');
  // A page that carries a token in its address is not for a search index, and sends no Referer when it is left.
  return { ...metadata, robots: { index: false, follow: false }, referrer: 'no-referrer' as const };
}

export default async function ForgotPasswordPage({ params }: Readonly<{ params: LocaleParams }>) {
  await resolvePageLocale(params);
  return (
    <PageMessages page="auth">
      <ForgotPasswordPageView />
    </PageMessages>
  );
}
