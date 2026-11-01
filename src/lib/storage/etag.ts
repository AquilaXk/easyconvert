/**
 * An ETag without its quotes: the form in which the ETags of the parts of an upload are compared, whichever way a store
 * or a client quotes them. A weak ETag (`W/"x"`) keeps its prefix, so it is not the strong ETag of the same value.
 */
export function stripEtagQuotes(etag: string): string {
  return etag.replace(/"/g, '');
}
