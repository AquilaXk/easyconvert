import StatusPageView from '@/components/pages/StatusPageView';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'status', '/status');
}

export default async function StatusPage({ params }: Readonly<{ params: LocaleParams }>) {
  await resolvePageLocale(params);
  return <StatusPageView />;
}
