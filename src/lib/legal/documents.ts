/**
 * The legal pages of the site: the path of each and its version, the date it takes effect, which the page shows at its
 * top. The texts are the Markdown files of docs/legal (src/lib/legal/texts.ts), kept out of this module so that a client
 * component that needs a version does not ship them.
 */
const LEGAL_TEXTS_VERSION = '2026-11-08';

export const LEGAL_DOCUMENTS = {
  terms: { path: '/terms', version: LEGAL_TEXTS_VERSION },
  privacy: { path: '/privacy', version: LEGAL_TEXTS_VERSION },
  dpa: { path: '/dpa', version: LEGAL_TEXTS_VERSION },
  acceptableUse: { path: '/acceptable-use', version: LEGAL_TEXTS_VERSION },
} as const;

export type LegalDocumentId = keyof typeof LEGAL_DOCUMENTS;

/** The version of the terms that sign-up and API key creation record as accepted. */
export const TERMS_VERSION = LEGAL_DOCUMENTS.terms.version;

const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Why a request's `acceptedTermsVersion` does not accept the terms in force, or undefined when it does: `terms_outdated` for an
 * earlier version, which a page loaded before the terms changed sends and a reload fixes, `terms_not_accepted` for anything else.
 */
export function termsRefusal(sent: unknown): 'terms_not_accepted' | 'terms_outdated' | undefined {
  if (sent === TERMS_VERSION) return undefined;
  return typeof sent === 'string' && VERSION_PATTERN.test(sent) && sent < TERMS_VERSION ? 'terms_outdated' : 'terms_not_accepted';
}

/** The English text of a refusal of `termsRefusal`, which names the version to send. */
export function termsRefusalText(code: 'terms_not_accepted' | 'terms_outdated'): string {
  return code === 'terms_outdated'
    ? `The terms of service changed: reload the page, read them, and send acceptedTermsVersion "${TERMS_VERSION}".`
    : `Accept the terms of service: send acceptedTermsVersion "${TERMS_VERSION}".`;
}
