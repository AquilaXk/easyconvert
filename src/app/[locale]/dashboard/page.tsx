import DashboardPageView from '@/components/pages/DashboardPageView';
import PageMessages from '@/i18n/PageMessages';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'dashboard', '/dashboard');
}

export default async function DashboardPage({ params }: Readonly<{ params: LocaleParams }>) {
  await resolvePageLocale(params);
  return (
    <PageMessages page="dashboard">
      <DashboardPageView />
    </PageMessages>
  );
}
