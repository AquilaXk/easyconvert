import { routing, type AppLocale } from '@/i18n/routing';

/** What the SMTP sender needs, read from the environment at call time (`SMTP_*`, `MAIL_FROM`; src/lib/config/schema.ts). */
export interface MailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

const DEFAULT_SMTP_PORT = 587;
const MAX_TCP_PORT = 65_535;

function setValue(name: string): string | undefined {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== '' ? raw : undefined;
}

/**
 * The public origin the links of a mail point to: the configured site URL, never a request header. It is `APP_ORIGIN`,
 * else `NEXT_PUBLIC_APP_URL`, else `APP_URL`, as an origin (no path, query or user info); undefined when none is set
 * or the value is not an http(s) URL.
 */
export function siteOrigin(): string | undefined {
  for (const name of ['APP_ORIGIN', 'NEXT_PUBLIC_APP_URL', 'APP_URL']) {
    const raw = setValue(name);
    if (raw === undefined) continue;
    try {
      const url = new URL(raw.trim());
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * The SMTP settings, or null when mail is not configured: the host, the account and its password, and a public origin for
 * the links are all required. A null result turns password reset and email verification off.
 */
export function readMailConfig(): MailConfig | null {
  const host = setValue('SMTP_HOST');
  const user = setValue('SMTP_USER');
  const password = setValue('SMTP_PASSWORD');
  if (host === undefined || user === undefined || password === undefined || siteOrigin() === undefined) return null;
  const rawPort = setValue('SMTP_PORT');
  const port = rawPort === undefined ? DEFAULT_SMTP_PORT : Number(rawPort.trim());
  if (!Number.isInteger(port) || port < 1 || port > MAX_TCP_PORT) return null;
  return { host: host.trim(), port, user: user.trim(), password, from: (setValue('MAIL_FROM') ?? user).trim() };
}

export function isAuthMailEnabled(): boolean {
  return readMailConfig() !== null;
}

/** The language of a mail: a language the site has, else the default one. */
export function mailLocale(value: unknown): AppLocale {
  return routing.locales.find((locale) => locale === value) ?? routing.defaultLocale;
}

/** The link a mail carries: the page in the recipient's language on the configured origin, with the token in the fragment. */
export function mailLink(locale: AppLocale, pagePath: string, token: string): string {
  const origin = siteOrigin();
  if (origin === undefined) throw new Error('No public origin is configured');
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`;
  return `${origin}${prefix}${pagePath}#token=${token}`;
}
