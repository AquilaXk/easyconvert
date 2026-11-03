import LegalDocumentPage, { legalPageMetadata } from '@/components/legal/LegalDocumentPage';
import type { LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return legalPageMetadata(params, 'terms');
}

export default function TermsPage({ params }: Readonly<{ params: LocaleParams }>) {
  return <LegalDocumentPage params={params} id="terms" />;
}
