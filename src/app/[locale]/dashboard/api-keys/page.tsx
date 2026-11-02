import { localizedPageMetadata, type LocaleParams } from '@/i18n/page';

export { default } from '../page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'dashboard', '/dashboard/api-keys');
}
