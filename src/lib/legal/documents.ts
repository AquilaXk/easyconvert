/**
 * The legal pages of the site: the path of each and its version, the date it takes effect, which the page shows at its
 * top. The texts are the Markdown files of docs/legal (src/lib/legal/texts.ts), kept out of this module so that a client
 * component that needs a version does not ship them.
 */
export const LEGAL_DOCUMENTS = {
  terms: { path: '/terms', version: '2026-11-03' },
  privacy: { path: '/privacy', version: '2026-11-03' },
  dpa: { path: '/dpa', version: '2026-11-03' },
  acceptableUse: { path: '/acceptable-use', version: '2026-11-03' },
} as const;

export type LegalDocumentId = keyof typeof LEGAL_DOCUMENTS;

/** The version of the terms that sign-up and API key creation record as accepted. */
export const TERMS_VERSION = LEGAL_DOCUMENTS.terms.version;
