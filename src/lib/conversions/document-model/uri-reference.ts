/**
 * Link targets as URI references (RFC 3986), which is what an EPUB `href` must be and what an HTML parser reads
 * leniently: a character a URI may not carry (a space, `[`, `|`, `^`, `<`, a letter outside ASCII) is written as the
 * percent escapes of its UTF-8 bytes, as a browser sends it; a `%` that does not start an escape is `%25`. A web address
 * the URL parser refuses (a space inside the host) is no link at all, as in a browser.
 */

const URL_IGNORED_CHARACTERS = /[\t\n\r]/g;
/** Characters a URI keeps outside the host: unreserved, sub-delimiters, `:`, `/`, `?`, `#`, `@` and `%`. */
const URI_CHARACTER_OUTSIDE_HOST = /[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]/;
const STRAY_PERCENT = /%(?![0-9A-Fa-f]{2})/g;
const AUTHORITY_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/;
const WEB_SCHEME = /^(?:https?|ftp):/i;

/** UTF-8 escapes of U+FFFD, written for a lone surrogate, which has no UTF-8 form (policy 55 writes U+FFFD for it in text). */
const REPLACEMENT_CHARACTER_ESCAPE = '%EF%BF%BD';
const LONE_SURROGATE = /^[\uD800-\uDFFF]$/;

function encodeIllegalCharacters(text: string): string {
  let encoded = '';
  for (const character of text.replace(STRAY_PERCENT, '%25')) {
    if (URI_CHARACTER_OUTSIDE_HOST.test(character)) encoded += character;
    else if (LONE_SURROGATE.test(character)) encoded += REPLACEMENT_CHARACTER_ESCAPE;
    else encoded += encodeURIComponent(character);
  }
  return encoded;
}

/** The fragment of an in-document link, escaped as a URI reference needs. */
export function fragmentReference(fragment: string): string {
  return `#${encodeIllegalCharacters(fragment)}`;
}

/** `href` as a URI reference, or undefined for a web address that is not an address. */
export function uriReference(href: string): string | undefined {
  const target = href.replace(URL_IGNORED_CHARACTERS, '').trim();
  if (WEB_SCHEME.test(target) && !URL.canParse(target)) return undefined;
  const authority = AUTHORITY_PREFIX.exec(target)?.[0] ?? '';
  return authority + encodeIllegalCharacters(target.slice(authority.length));
}
