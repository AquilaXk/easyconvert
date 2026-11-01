import type { Messages } from 'next-intl';

function pickKeys(table: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in table).map((key) => [key, table[key]]));
}

/**
 * The messages a page's client components read: everything but the page metadata, and the format dossiers and
 * descriptions only of `formatIds` (a converter page's two formats), so no page carries every format's prose.
 */
export function clientMessages(messages: Messages, formatIds: readonly string[] = []): Messages {
  const { meta: _meta, formatSpecs, formatDescriptions, ...rest } = messages;
  const ids = formatIds.map((id) => id.toLowerCase());
  return {
    ...rest,
    formatSpecs: pickKeys(formatSpecs, ids),
    formatDescriptions: pickKeys(formatDescriptions, ids),
  } as Messages;
}
