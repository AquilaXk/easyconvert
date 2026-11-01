import UnitConverterPageView from '@/components/pages/UnitConverterPageView';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'unitConverter', '/unit-converter');
}

export default async function UnitConverterPage({ params }: Readonly<{ params: LocaleParams }>) {
  await resolvePageLocale(params);
  return <UnitConverterPageView />;
}
