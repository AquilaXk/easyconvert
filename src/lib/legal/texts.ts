import type { AppLocale } from '@/i18n/routing';
import type { LegalDocumentId } from './documents';
import termsEn from '../../../docs/legal/terms.en.md?raw';
import termsKo from '../../../docs/legal/terms.ko.md?raw';
import privacyEn from '../../../docs/legal/privacy.en.md?raw';
import privacyKo from '../../../docs/legal/privacy.ko.md?raw';
import dpaEn from '../../../docs/legal/dpa.en.md?raw';
import dpaKo from '../../../docs/legal/dpa.ko.md?raw';
import acceptableUseEn from '../../../docs/legal/acceptable-use.en.md?raw';
import acceptableUseKo from '../../../docs/legal/acceptable-use.ko.md?raw';

/** The Markdown source of each legal page in each language, read from docs/legal at build time. */
export const LEGAL_TEXTS: Readonly<Record<LegalDocumentId, Readonly<Record<AppLocale, string>>>> = {
  terms: { en: termsEn, ko: termsKo },
  privacy: { en: privacyEn, ko: privacyKo },
  dpa: { en: dpaEn, ko: dpaKo },
  acceptableUse: { en: acceptableUseEn, ko: acceptableUseKo },
};
