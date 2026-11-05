import { NextRequest, NextResponse } from 'next/server';
import createIntlMiddleware from 'next-intl/middleware';
import { routing, type AppLocale } from '@/i18n/routing';
import {
  CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS,
  ClientIpError,
  UNATTRIBUTED_CLIENT_KEY,
  clientIpKey,
  isClientIpTrustDeclared,
  loadClientIpConfig,
  rateLimitKey,
  resolveClientIp,
  type ResolvedClientIp,
} from '@/lib/security/client-ip';
import { requestBodyVerdict, type CountedBody } from '@/lib/api/request-body-limit';

/**
 * Next.js Edge-compatible Centralized Middleware
 * 1. Cross-Site Request Forgery (CSRF) Protection: Enforces strict Origin / Referer validation
 *    on cookie-authenticated state-changing requests (POST, PUT, PATCH, DELETE).
 * 2. Anonymous IP Edge Rate Limiting: Protective token bucket guard against burst abuse.
 * 3. Request body size: a declared body over what the route takes is refused before the route reads it, and a body sent
 *    without a length is counted as it arrives: a file route refuses its first byte, any other route takes 1 MiB.
 * 4. Locale routing of pages: English at the unprefixed paths, every other locale under its prefix. A visitor's language
 *    (cookie, then Accept-Language) is negotiated on the root only, so a shared link opens in the language it names, and
 *    only the language selector writes the locale cookie, so no page answer carries a Set-Cookie.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_LENGTH_REQUIRED = 411;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_SERVICE_UNAVAILABLE = 503;
const PROBLEM_BAD_REQUEST = 'https://api.easyconvert.io/problems/bad-request';
const PROBLEM_NOT_FOUND = 'https://api.easyconvert.io/problems/not-found';
const PROBLEM_PAYLOAD_TOO_LARGE = 'https://api.easyconvert.io/problems/payload-too-large';
const PROBLEM_LENGTH_REQUIRED = 'https://api.easyconvert.io/problems/length-required';
const PROBLEM_SERVICE_UNAVAILABLE = 'https://api.easyconvert.io/problems/service-unavailable';
const PROBLEM_TRUST_UNCONFIGURED = 'https://api.easyconvert.io/problems/client-ip-trust-unconfigured';

// Liveness endpoint: stays reachable in degraded (unattributed or undeclared) trust modes.
const HEALTH_PATH = '/api/health';
const HEALTH_METHODS = new Set(['GET', 'HEAD']);

// Fast Edge-compatible in-memory rate limiter per Edge worker instance
interface EdgeRateBucket {
  tokens: number;
  lastRefill: number;
}
const edgeIpBuckets = new Map<string, EdgeRateBucket>();
const EDGE_BUCKET_CAPACITY = 60;
const EDGE_REFILL_RATE = 10; // 10 tokens per second

// Degraded mode: when no client can be attributed every request shares ONE bucket, so it is sized for the
// whole site's traffic rather than for a single client. It still bounds a flood, but it is not per-client
// fairness; declare TRUSTED_PROXIES to get that back.
const EDGE_SHARED_BUCKET_CAPACITY = 600;
const EDGE_SHARED_REFILL_RATE = 100; // tokens per second

interface EdgeBucketLimits {
  capacity: number;
  refillRate: number;
}
const PER_CLIENT_LIMITS: EdgeBucketLimits = { capacity: EDGE_BUCKET_CAPACITY, refillRate: EDGE_REFILL_RATE };
const SHARED_LIMITS: EdgeBucketLimits = { capacity: EDGE_SHARED_BUCKET_CAPACITY, refillRate: EDGE_SHARED_REFILL_RATE };

function cleanExpiredEdgeBuckets() {
  const now = Date.now();
  if (edgeIpBuckets.size > 5000) {
    for (const [ip, bucket] of edgeIpBuckets.entries()) {
      if (now - bucket.lastRefill > 60000) {
        edgeIpBuckets.delete(ip);
      }
    }
  }
}

function checkEdgeIpRateLimit(clientIp: string): { allowed: boolean; retryAfterSec: number } {
  cleanExpiredEdgeBuckets();
  const now = Date.now();
  const limits = clientIp === UNATTRIBUTED_CLIENT_KEY ? SHARED_LIMITS : PER_CLIENT_LIMITS;
  let bucket = edgeIpBuckets.get(clientIp);

  if (!bucket) {
    bucket = { tokens: limits.capacity - 1, lastRefill: now };
    edgeIpBuckets.set(clientIp, bucket);
    return { allowed: true, retryAfterSec: 0 };
  }

  const elapsedSec = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(limits.capacity, bucket.tokens + elapsedSec * limits.refillRate);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  const needed = 1 - bucket.tokens;
  const retryAfterSec = Math.max(1, Math.ceil(needed / limits.refillRate));
  return { allowed: false, retryAfterSec };
}

function problemResponse(
  status: number,
  type: string,
  title: string,
  detail: string,
  instance: string,
  extraHeaders: Record<string, string> = {}
): NextResponse {
  return new NextResponse(JSON.stringify({ type, title, status, detail, instance }), {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...extraHeaders },
  });
}

let warnedTrustUnconfigured = false;

function warnTrustUnconfiguredOnce(): void {
  if (warnedTrustUnconfigured) return;
  warnedTrustUnconfigured = true;
  console.error(
    '[edge] TRUSTED_PROXIES is not set in production: refusing /api requests (503). Set it to the CIDR list of ' +
      'the proxy hops in front of this server, or to "none" if the server is directly exposed.'
  );
}

let warnedUnattributed = false;

function warnUnattributedOnce(): void {
  if (warnedUnattributed) return;
  warnedUnattributed = true;
  console.warn(
    '[edge] Client IP cannot be attributed: set TRUSTED_PROXIES (and/or TRUSTED_CDN) to declare the proxy in ' +
      'front of this server. Until then every request shares one (degraded) rate-limit bucket.'
  );
}

/** The problem answer for a body the route does not take, by its status. */
function bodyProblem(status: number, detail: string, pathname: string): NextResponse {
  if (status === HTTP_BAD_REQUEST) return problemResponse(HTTP_BAD_REQUEST, PROBLEM_BAD_REQUEST, 'Bad Request', detail, pathname);
  if (status === HTTP_LENGTH_REQUIRED) return problemResponse(HTTP_LENGTH_REQUIRED, PROBLEM_LENGTH_REQUIRED, 'Length Required', detail, pathname);
  return problemResponse(HTTP_PAYLOAD_TOO_LARGE, PROBLEM_PAYLOAD_TOO_LARGE, 'Payload Too Large', detail, pathname);
}

/**
 * Reads a body sent without a length as it arrives, and refuses it once more than `count.countUpTo` bytes came; the route
 * then reads the same bytes from the copy the framework keeps for it. The count decides the answer only: the framework
 * keeps its copy of what arrived either way, up to its own body limit.
 */
async function countedBody(body: ReadableStream<Uint8Array>, count: CountedBody, pathname: string): Promise<NextResponse> {
  const reader = body.getReader();
  let received = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    received += chunk.value.byteLength;
    if (received > count.countUpTo) {
      await reader.cancel();
      return bodyProblem(count.status, count.detail, pathname);
    }
  }
  return NextResponse.next();
}

function isOriginAllowed(incomingOrigin: string, request: NextRequest): boolean {
  try {
    const incomingUrl = new URL(incomingOrigin);
    const hostHeader = request.headers.get('host');

    // 1. Match request.nextUrl.origin
    if (incomingUrl.origin === request.nextUrl.origin) {
      return true;
    }

    // 2. Match Host header (accounting for http/https)
    if (hostHeader) {
      const hostOriginHttp = `http://${hostHeader}`;
      const hostOriginHttps = `https://${hostHeader}`;
      if (incomingUrl.origin === hostOriginHttp || incomingUrl.origin === hostOriginHttps) {
        return true;
      }
    }

    // 3. Match configured APP_ORIGIN / NEXT_PUBLIC_APP_URL
    const envAppOrigin = process.env.APP_ORIGIN || process.env.NEXT_PUBLIC_APP_URL;
    if (envAppOrigin) {
      const parsedEnv = new URL(envAppOrigin);
      if (incomingUrl.origin === parsedEnv.origin) {
        return true;
      }
    }

    // 4. Localhost / Loopback allowed in development or testing
    if (process.env.NODE_ENV !== 'production') {
      if (incomingUrl.hostname === 'localhost' || incomingUrl.hostname === '127.0.0.1') {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

const handleRootLocale = createIntlMiddleware(routing);
const handlePageLocale = createIntlMiddleware({ ...routing, localeDetection: false, localeCookie: false });

/** What reading a URL drops from the decoded path, namely a tab or a line break anywhere, and a space or control character at the end. */
const DROPPED_BY_URL_PARSING = /[\t\n\r]|(?:[\u0000-\u0020]$)/;

function hasDroppedUrlChar(pathname: string): boolean {
  try {
    return DROPPED_BY_URL_PARSING.test(decodeURI(pathname));
  } catch {
    return false;
  }
}

/** A path split into the language it names by its first segment, in any case (`/KO/x`), and the path after it; a path with none names the default language. */
function splitLocalePrefix(pathname: string): { locale: AppLocale; path: string } {
  const [, first = '', ...rest] = pathname.split('/');
  const locale = routing.locales.find((candidate) => candidate === first.toLowerCase());
  return locale ? { locale, path: `/${rest.join('/')}` } : { locale: routing.defaultLocale, path: pathname };
}

/**
 * The page's answer in the visitor's language. next-intl rewrites to the decoded path read back as a URL, which drops what
 * `DROPPED_BY_URL_PARSING` names, so `/pdf-to-jpg%20` would reach the page as `/pdf-to-jpg` and answer 200 for another path.
 * A path with a malformed percent escape cannot be decoded and falls through to `handlePageLocale`, which lets Next.js answer
 * 400. A path with a dropped character is rewritten here to `/${locale}${path}` as it came, ahead of any redirect for a
 * superfluous or capitalised language prefix (`/en/x`, `/KO/x`), so the page reads the whole slug and answers 404.
 */
function pageLocaleAnswer(request: NextRequest): NextResponse {
  const received = request.nextUrl.pathname;
  if (!hasDroppedUrlChar(received)) return handlePageLocale(request);

  const { locale, path } = splitLocalePrefix(received);
  const headers = new Headers(request.headers);
  headers.set('X-NEXT-INTL-LOCALE', locale);
  return NextResponse.rewrite(new URL(`/${locale}${path}${request.nextUrl.search}`, request.url), {
    request: { headers },
  });
}

/**
 * The root's answer is the home page in the visitor's language (the cookie the language selector wrote, then
 * Accept-Language). It differs by those two headers, so it says so and stays out of shared caches. next-intl writes the
 * cookie it negotiated for a visitor who sent none; only the selector writes it, so that answer carries no cookie.
 */
function rootLocaleAnswer(request: NextRequest): NextResponse {
  const response = handleRootLocale(request);
  response.headers.delete('set-cookie');
  response.headers.delete('x-middleware-set-cookie');
  response.headers.set('Vary', 'Accept-Language, Cookie');
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

/** `/ko/api/...` and `/ko/api` have no page because the API takes no language prefix. */
function isLocalePrefixedApiPath(pathname: string): boolean {
  const [, first, second] = pathname.split('/');
  return (routing.locales as readonly string[]).includes(first) && second === 'api';
}

export function middleware(request: NextRequest): NextResponse | Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;

  if (isLocalePrefixedApiPath(pathname)) {
    return problemResponse(HTTP_NOT_FOUND, PROBLEM_NOT_FOUND, 'Not Found', 'API routes take no language prefix.', pathname);
  }
  if (!isApiPath(pathname)) {
    return pathname === '/' ? rootLocaleAnswer(request) : pageLocaleAnswer(request);
  }

  const isHealthProbe = pathname === HEALTH_PATH && HEALTH_METHODS.has(request.method.toUpperCase());

  // Edge barrier identity. The middleware cannot see the socket peer, so attribution follows the deployment
  // contract in src/lib/security/client-ip.ts: forwarding headers count only behind a declared proxy, and an
  // unattributed request shares one conservative bucket instead of a header-chosen key.
  let resolved: ResolvedClientIp;
  try {
    const config = loadClientIpConfig();
    // Production must choose a trust mode explicitly (TRUSTED_PROXIES=<CIDRs>|none, or TRUSTED_CDN). Refusing
    // to serve is louder than silently throttling every client as one.
    if (process.env.NODE_ENV === 'production' && !isClientIpTrustDeclared(config)) {
      if (isHealthProbe) return NextResponse.next();
      warnTrustUnconfiguredOnce();
      return problemResponse(
        HTTP_SERVICE_UNAVAILABLE,
        PROBLEM_TRUST_UNCONFIGURED,
        'Service Unavailable',
        'Client IP trust mode is not configured. Set TRUSTED_PROXIES to the proxy CIDR list, or to "none" when this server is exposed directly. ' +
          'Note that TRUSTED_PROXIES=none means all clients share one rate-limit bucket.',
        pathname,
        { 'Retry-After': String(CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS) }
      );
    }
    resolved = resolveClientIp(request, { config });
  } catch (error) {
    if (!(error instanceof ClientIpError)) throw error;
    if (error.status === HTTP_BAD_REQUEST) {
      return problemResponse(
        error.status,
        PROBLEM_BAD_REQUEST,
        'Bad Request',
        'Malformed client address in forwarding headers.',
        pathname
      );
    }
    console.error(`[edge] ${error.message}`);
    return problemResponse(
      error.status,
      PROBLEM_SERVICE_UNAVAILABLE,
      'Service Unavailable',
      'Client IP trust configuration is invalid.',
      pathname,
      { 'Retry-After': String(CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS) }
    );
  }
  if (resolved.source === 'unattributed') {
    warnUnattributedOnce();
    // Liveness probes must not drain (or be starved by) the bucket every unattributed client shares.
    if (isHealthProbe) return NextResponse.next();
  }
  const clientIp = rateLimitKey(clientIpKey(resolved));

  // 1. Edge-level IP Rate Limiter
  const edgeRate = checkEdgeIpRateLimit(clientIp);
  if (!edgeRate.allowed) {
    return new NextResponse(
      JSON.stringify({
        type: 'https://api.easyconvert.io/problems/rate-limited',
        title: 'Too Many Requests',
        status: 429,
        detail: 'Edge rate limit exceeded. Please slow down your requests.',
        instance: pathname,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/problem+json',
          'Retry-After': String(edgeRate.retryAfterSec),
        },
      }
    );
  }

  // 2. Body size: a malformed or oversize Content-Length is refused before any route reads the body. A route that takes
  // files takes one request of a file (entry 137); every other route takes a small JSON or form body. A body without a
  // length is counted as it arrives, after the CSRF check below.
  const bodyCheck = requestBodyVerdict(request.nextUrl, request.headers);
  if (bodyCheck && !('countUpTo' in bodyCheck)) return bodyProblem(bodyCheck.status, bodyCheck.detail, pathname);

  // 3. CSRF Protection for Cookie-Authenticated State Mutations
  if (MUTATING_METHODS.has(request.method.toUpperCase())) {
    const hasSessionCookie =
      request.cookies.has('easyconvert_session') || request.cookies.has('session');
    const authHeader = request.headers.get('authorization');
    const hasApiKey =
      Boolean(request.headers.get('x-api-key')) ||
      Boolean(authHeader?.startsWith('Bearer ec_live_'));

    // If request relies on ambient browser credentials (cookies) without an explicit API key:
    if (hasSessionCookie && !hasApiKey) {
      const originHeader = request.headers.get('origin');
      const refererHeader = request.headers.get('referer');

      let incomingOrigin: string | null = null;
      if (originHeader) {
        incomingOrigin = originHeader;
      } else if (refererHeader) {
        try {
          incomingOrigin = new URL(refererHeader).origin;
        } catch {
          incomingOrigin = null;
        }
      }

      if (!incomingOrigin) {
        return new NextResponse(
          JSON.stringify({
            type: 'https://api.easyconvert.io/problems/forbidden',
            title: 'Forbidden',
            status: 403,
            detail: 'Cross-site request forgery detected: missing Origin/Referer on cookie-authenticated mutation.',
            instance: pathname,
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/problem+json' },
          }
        );
      }

      if (!isOriginAllowed(incomingOrigin, request)) {
        return new NextResponse(
          JSON.stringify({
            type: 'https://api.easyconvert.io/problems/forbidden',
            title: 'Forbidden',
            status: 403,
            detail: `Cross-site request forgery detected: untrusted origin "${incomingOrigin}".`,
            instance: pathname,
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/problem+json' },
          }
        );
      }
    }
  }

  if (bodyCheck && request.body) return countedBody(request.body, bodyCheck, pathname);
  return NextResponse.next();
}

export const config = {
  // API routes, and every path that is not a framework internal or a static asset in `public/` or `src/app/`. Dotted paths
  // that are not static assets (`/robots.txt`, `/foo.html`, `/wp-login.php`, `/.env`, `/.git/config`) and bare `/api` go
  // through `pageLocaleAnswer`, so `src/app/[locale]/[slug]/page.tsx` and `src/app/[locale]/[...rest]/page.tsx` answer them
  // 404 without reaching `src/app/[locale]/page.tsx` with an unknown `locale` parameter (`NoFallbackError`).
  matcher: [
    '/api/:path*',
    '/((?!api/|_next/|_vercel/|fonts/|screenshots/|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|sample\\.pdf$).*)',
  ],
};
