import DashboardPageView from '@/components/pages/DashboardPageView';
import { readDashboardSession } from '@/lib/auth/session-gate';
import { loadDashboardSnapshot } from '@/lib/dashboard/snapshot';
import PageMessages from '@/i18n/PageMessages';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'dashboard', '/dashboard');
}

export default async function DashboardPage({ params }: Readonly<{ params: LocaleParams }>) {
  const user = await readDashboardSession(await resolvePageLocale(params));
  const snapshot = user ? await loadDashboardSnapshot(user) : undefined;
  return (
    <PageMessages page="dashboard">
      <DashboardPageView initial={snapshot} />
    </PageMessages>
  );
}
