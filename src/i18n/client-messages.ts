import type { Messages } from 'next-intl';
import { formatMessageKey } from './message-keys';

type Namespace = keyof Messages;

/** What the header and the footer read; every page shows them. */
const CHROME = ['header', 'siteLinks', 'theme', 'languageSwitcher', 'userNav', 'plans', 'footer'] as const satisfies readonly Namespace[];

/** What the conversion workbench (drop zone, queue, options, format picker) reads. */
const WORKBENCH = ['hero', 'queue', 'options', 'formatSelector', 'formatCategories', 'urlImport', 'errors'] as const satisfies readonly Namespace[];

/**
 * The message namespaces each page's client components read, so a page carries only its own copy; a server component
 * reads every message on the server and needs none handed down. They follow the imports of each page's view:
 * tests/i18n-client-messages.test.ts fails when a client component reads a namespace its row lacks or its row names one
 * no client component of the page reads. The layout renders no translated client component, so its provider carries none.
 */
export const PAGE_NAMESPACES = {
  layout: [],
  home: [...CHROME, ...WORKBENCH, 'features', 'home'],
  converter: [
    ...CHROME, ...WORKBENCH, 'converterPage', 'slugPages', 'formatDetail', 'formatSpecs', 'formatDescriptions', 'infoPages',
  ],
  auth: [...CHROME, 'auth', 'errors'],
  dashboard: [...CHROME, 'dashboard', 'errors'],
  apiDocs: [...CHROME],
  pricing: [...CHROME],
  legal: [...CHROME],
  notFound: [...CHROME, 'notFound'],
} as const satisfies Record<string, readonly Namespace[]>;

export type ClientMessagesPage = keyof typeof PAGE_NAMESPACES;

/** Format dossiers and descriptions are large: a converter page carries only those of its two formats. */
const PER_FORMAT: ReadonlySet<Namespace> = new Set(['formatSpecs', 'formatDescriptions']);

function pickKeys(table: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(table, key)).map((key) => [key, table[key]]));
}

/** The messages `page`'s client components read; for a converter page, the format prose of `formatIds` only. */
export function clientMessages(messages: Messages, page: ClientMessagesPage, formatIds: readonly string[] = []): Messages {
  const formatKeys = formatIds.map((id) => formatMessageKey(id.toLowerCase()));
  const picked = (PAGE_NAMESPACES[page] as readonly Namespace[]).map((namespace) => [
    namespace,
    PER_FORMAT.has(namespace) ? pickKeys(messages[namespace] as Record<string, unknown>, formatKeys) : messages[namespace],
  ]);
  return Object.fromEntries(picked) as Messages;
}
