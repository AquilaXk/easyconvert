/** The most characters of a route the 404 page shows; a longer one is cut and ends in an ellipsis. */
export const MAX_ROUTE_CHARS = 100;

const ELLIPSIS = '\u2026';

/** A control character, a line or paragraph separator, or a character that changes the direction of the text around it. */
const UNSAFE_TO_SHOW = /[\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/**
 * What the 404 page names as the route that was not found: the path without its leading slash, decoded so a visitor reads
 * `한글` where the address bar holds `%ED%95%9C%EA%B8%80`. A path that does not decode, or whose decoded form holds a control
 * or direction character, is shown as it came (percent-encoded, so the character is spelled out and changes nothing around
 * it). A long route is cut to `MAX_ROUTE_CHARS` characters.
 */
export function displayRoute(pathname: string): string {
  const received = pathname.slice(1);
  const decoded = decodeOrNull(received);
  const shown = decoded !== null && !UNSAFE_TO_SHOW.test(decoded) ? decoded : received;
  const characters = Array.from(shown);
  return characters.length > MAX_ROUTE_CHARS ? `${characters.slice(0, MAX_ROUTE_CHARS).join('')}${ELLIPSIS}` : shown;
}

function decodeOrNull(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}
