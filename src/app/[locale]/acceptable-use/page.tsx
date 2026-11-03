import LegalDocumentPage, { legalPageMetadata } from '@/components/legal/LegalDocumentPage';
import type { LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return legalPageMetadata(params, 'acceptableUse');
}

export default function AcceptableUsePage({ params }: Readonly<{ params: LocaleParams }>) {
  return <LegalDocumentPage params={params} id="acceptableUse" />;
}
