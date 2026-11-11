/**
 * The names of the session cookie. In production the cookie is `__Host-easyconvert_session`: the `__Host-` prefix makes a browser
 * refuse the cookie unless it is Secure, has Path=/ and no Domain, and refuse one that a sibling subdomain sets for the whole
 * site, so a page on another subdomain can neither shadow the session cookie nor plant one (session fixation). The prefix needs
 * HTTPS, so development and tests keep the plain name.
 *
 * Sessions issued before the prefix was used carry the plain name. Both names are read, the prefixed one first, until the
 * longest of those sessions has expired (SESSION_MAX_AGE_SECONDS, 7 days) and the plain name can be dropped from the reader;
 * only the prefixed name is written, and a sign-out clears both. No imports: the edge middleware reads these names too.
 */

export const LEGACY_SESSION_COOKIE_NAME = 'easyconvert_session';
export const HOST_SESSION_COOKIE_NAME = '__Host-easyconvert_session';

/** The names a request's session cookie may carry, in the order they are read. */
export const SESSION_COOKIE_NAMES: readonly string[] = [HOST_SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME];

/** The name the server writes the session cookie under. */
export function sessionCookieName(production: boolean = process.env.NODE_ENV === 'production'): string {
  return production ? HOST_SESSION_COOKIE_NAME : LEGACY_SESSION_COOKIE_NAME;
}

/** The session token of a `Cookie` header, under the first of SESSION_COOKIE_NAMES that it carries; null when none. */
export function sessionTokenFromCookieHeader(header: string | null | undefined): string | null {
  return sessionTokensFromCookieHeader(header)[0] ?? null;
}

/**
 * The session tokens of a `Cookie` header under every name of SESSION_COOKIE_NAMES that it carries, the one that is read first
 * first. A sign-out revokes all of them: while the plain name is still read, a request that carries both would otherwise
 * keep the session of the one that was not revoked.
 */
export function sessionTokensFromCookieHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  const cookies = new Map<string, string>();
  for (const part of header.split(';')) {
    const text = part.trim();
    const equals = text.indexOf('=');
    if (equals <= 0) continue;
    const name = text.slice(0, equals);
    if (!cookies.has(name)) cookies.set(name, text.slice(equals + 1));
  }
  return SESSION_COOKIE_NAMES.map((name) => cookies.get(name)).filter((value): value is string => Boolean(value));
}

/** The session token of a cookie store (`cookies()` of next/headers, `request.cookies`), under the first name it carries. */
export function sessionTokenFromCookieStore(store: { get(name: string): { value: string } | undefined }): string | null {
  for (const name of SESSION_COOKIE_NAMES) {
    const value = store.get(name)?.value;
    if (value) return value;
  }
  return null;
}

/** Whether a request carries any session cookie (the edge CSRF check applies to ambient credentials). */
export function hasSessionCookie(store: { has(name: string): boolean }): boolean {
  return SESSION_COOKIE_NAMES.some((name) => store.has(name)) || store.has('session');
}
