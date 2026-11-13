import AuthPageView from '@/components/pages/AuthPageView';
import { isAuthMailEnabled } from '@/lib/auth/mail-config';
import { isGoogleSignInEnabled } from '@/lib/auth/oauth';
import PageMessages from '@/i18n/PageMessages';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

// Rendered for each request: whether Google sign-in and the reset mail are on is the running server's configuration, which a page
// made at build time does not know. Asked from the browser instead, the button and the link appeared only after the page had drawn.
export const dynamic = 'force-dynamic';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'auth', '/auth');
}

export default async function AuthPage({ params }: Readonly<{ params: LocaleParams }>) {
  await resolvePageLocale(params);
  return (
    <PageMessages page="auth">
      <AuthPageView googleEnabled={isGoogleSignInEnabled()} passwordResetEnabled={isAuthMailEnabled()} />
    </PageMessages>
  );
}
