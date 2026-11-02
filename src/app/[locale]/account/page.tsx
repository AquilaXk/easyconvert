import { redirect } from '@/i18n/navigation';
import { resolvePageLocale, type LocaleParams } from '@/i18n/page';

export default async function AccountPage({ params }: Readonly<{ params: LocaleParams }>) {
  const locale = await resolvePageLocale(params);
  redirect({ href: '/dashboard', locale });
}
