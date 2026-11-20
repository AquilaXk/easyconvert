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
import { applyV1CorsHeaders, createV1PreflightResponse, isV1ApiPath } from '@/lib/api/v1-cors';
import { hasSessionCookie } from '@/lib/auth/session-cookie';
import { PROBLEM_TYPE_BASE } from '@/lib/refusal-codes';

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
const PROBLEM_BAD_REQUEST = `${PROBLEM_TYPE_BASE}bad-request`;
const PROBLEM_NOT_FOUND = `${PROBLEM_TYPE_BASE}not-found`;
const PROBLEM_PAYLOAD_TOO_LARGE = `${PROBLEM_TYPE_BASE}payload-too-large`;
const PROBLEM_LENGTH_REQUIRED = `${PROBLEM_TYPE_BASE}length-required`;
const PROBLEM_SERVICE_UNAVAILABLE = `${PROBLEM_TYPE_BASE}service-unavailable`;
const PROBLEM_TRUST_UNCONFIGURED = `${PROBLEM_TYPE_BASE}client-ip-trust-unconfigured`;

// Readiness (/api/health) and liveness (/api/health/live) probes: stay reachable in degraded (unattributed or undeclared) trust modes.
const HEALTH_PATHS = new Set(['/api/health', '/api/health/live']);
const HEALTH_METHODS = new Set(['GET', 'HEAD']);

// Fast Edge-compatible in-memory rate limiter per Edge worker instance
interface EdgeRateBucket {
  tokens: number;
  lastRefill: number;
}
const edgeIpBuckets = new Map<string, EdgeRateBucket>();
const EDGE_BUCKET_CAPACITY = 60;
const EDGE_REFILL_RATE = 10; // 10 tokens per second
const MAX_EDGE_IP_BUCKETS = 50_000;
const EDGE_BUCKET_TTL_MS = 60_000;
let nextEdgeSweepAt = 0;

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

function cleanExpiredEdgeBuckets(now: number): void {
  if (now < nextEdgeSweepAt && edgeIpBuckets.size < MAX_EDGE_IP_BUCKETS) {
    return;
  }
  nextEdgeSweepAt = now + EDGE_BUCKET_TTL_MS;
  for (const [ip, bucket] of edgeIpBuckets.entries()) {
    if (now - bucket.lastRefill > EDGE_BUCKET_TTL_MS) {
      edgeIpBuckets.delete(ip);
    }
  }
  while (edgeIpBuckets.size >= MAX_EDGE_IP_BUCKETS) {
    const oldestKey = edgeIpBuckets.keys().next().value;
    if (oldestKey === undefined) break;
    edgeIpBuckets.delete(oldestKey);
  }
}

// The notification destination of the payment provider: its answer, not an address, is the gate (the signature check), and a 429 makes the
// provider send the event again, so the route has one bucket of its own, sized like the degraded shared one, in place of the bucket of
// the sender's address. Only a request that carries the provider's signature header takes that bucket; any other request to the path is
// limited by its own address, so a sender without a signature cannot drain the provider's bucket. One that forges the header can, and the
// provider's retries and the hourly reconciliation then make up for the delay.
const BILLING_WEBHOOK_PATH = '/api/billing/webhook';
const BILLING_WEBHOOK_BUCKET_KEY = 'route:billing-webhook';
const BILLING_SIGNATURE_HEADER = 'paddle-signature';
const BILLING_SIGNATURE_MAX_LENGTH = 512;
const BILLING_TIMESTAMP_REGEX = /^\d{1,20}$/;
const BILLING_SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

/**
 * Pure structural guard matching `parseSignatureHeader` in `src/lib/billing/webhook-signature.ts`:
 * requires a bounded header length, an integer `ts`, and at least one 64-char lowercase hex `h1` signature
 * so trivial forged headers cannot consume the shared webhook bucket.
 */
function hasValidBillingSignatureFormat(header: string | null): boolean {
  if (!header || header.length > BILLING_SIGNATURE_MAX_LENGTH) return false;
  let timestamp = '';
  let hashCount = 0;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at);
    const value = part.slice(at + 1);
    if (key === 'ts') {
      timestamp = value;
    } else if (key === 'h1' && value) {
      if (!BILLING_SHA256_HEX_REGEX.test(value)) return false;
      hashCount += 1;
    }
  }
  return BILLING_TIMESTAMP_REGEX.test(timestamp) && hashCount > 0;
}

function isCookieOnlyMutationRoute(pathname: string): boolean {
  return (
    pathname === '/api/auth' ||
    pathname.startsWith('/api/auth/') ||
    ((pathname === '/api/billing' || pathname.startsWith('/api/billing/')) && pathname !== BILLING_WEBHOOK_PATH)
  );
}

function checkEdgeIpRateLimit(bucketKey: string, limits: EdgeBucketLimits): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  let bucket = edgeIpBuckets.get(bucketKey);

  if (!bucket) {
    cleanExpiredEdgeBuckets(now);
    bucket = { tokens: limits.capacity - 1, lastRefill: now };
    edgeIpBuckets.set(bucketKey, bucket);
    return { allowed: true, retryAfterSec: 0 };
  }

  // LRU refresh in insertion-ordered Map
  edgeIpBuckets.delete(bucketKey);
  edgeIpBuckets.set(bucketKey, bucket);
  if (now >= nextEdgeSweepAt) cleanExpiredEdgeBuckets(now);

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

/**
 * Whether the `Origin` (or the origin of the `Referer`) of a cookie-authenticated mutation is this site. In production only an
 * `https:` origin counts, unless the configured APP_ORIGIN is itself the plain-HTTP origin of a deployment without TLS: a page
 * served over plain HTTP for the same host (any on-path attacker can serve one) is not this site, and the Host header alone would
 * accept it as `http://<host>`.
 */
function isOriginAllowed(incomingOrigin: string, request: NextRequest): boolean {
  try {
    const incomingUrl = new URL(incomingOrigin);
    const production = process.env.NODE_ENV === 'production';

    // 1. The configured APP_ORIGIN / NEXT_PUBLIC_APP_URL
    const envAppOrigin = process.env.APP_ORIGIN || process.env.NEXT_PUBLIC_APP_URL;
    if (envAppOrigin) {
      if (incomingUrl.origin === new URL(envAppOrigin).origin) {
        return true;
      }
      if (production) {
        return false;
      }
    }

    // Past the configured origin, production takes HTTPS origins only.
    if (production && incomingUrl.protocol !== 'https:') {
      return false;
    }

    // 2. The origin the request itself came in on
    if (incomingUrl.origin === request.nextUrl.origin) {
      return true;
    }

    // 3. The Host header, with the scheme the request has (https in production)
    const hostHeader = request.headers.get('host');
    if (hostHeader) {
      const allowedSchemes = production ? ['https'] : ['http', 'https'];
      if (allowedSchemes.some((scheme) => incomingUrl.origin === `${scheme}://${hostHeader}`)) {
        return true;
      }
    }

    // 4. Localhost / Loopback allowed in development or testing
    if (!production) {
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

const OCR_ASSET_PATH_PREFIX = /^\/_assets\/ocr\/[^/]+(?:\/[^/]+)+$/;

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || OCR_ASSET_PATH_PREFIX.test(pathname);
}

function isLocalePrefixedApiPath(pathname: string): boolean {
  const [, first, second] = pathname.split('/');
  return (routing.locales as readonly string[]).includes(first) && second === 'api';
}

function csrfForbiddenResponse(pathname: string, detail: string): NextResponse {
  return problemResponse(
    403,
    `${PROBLEM_TYPE_BASE}forbidden`,
    'Forbidden',
    detail,
    pathname
  );
}

function extractRequestOriginHeader(request: NextRequest, fallbackToRawReferer: boolean): string | null {
  const originHeader = request.headers.get('origin');
  if (originHeader) return originHeader;
  const refererHeader = request.headers.get('referer');
  if (!refererHeader) return null;
  try {
    return new URL(refererHeader).origin;
  } catch {
    return fallbackToRawReferer ? refererHeader : null;
  }
}

function checkMutationCsrf(request: NextRequest, pathname: string): NextResponse | null {
  const hasAmbientSession = hasSessionCookie(request.cookies);
  const authHeader = request.headers.get('authorization');
  const acceptsApiKey = !isCookieOnlyMutationRoute(pathname);
  const hasApiKey =
    acceptsApiKey &&
    (Boolean(request.headers.get('x-api-key')) ||
      Boolean(authHeader?.startsWith('Bearer ec_live_')));

  // If request relies on ambient browser credentials (cookies) without an explicit API key:
  if (hasAmbientSession && !hasApiKey) {
    const incomingOrigin = extractRequestOriginHeader(request, false);
    if (!incomingOrigin) {
      return csrfForbiddenResponse(
        pathname,
        'Cross-site request forgery detected: missing Origin/Referer on cookie-authenticated mutation.'
      );
    }
    if (!isOriginAllowed(incomingOrigin, request)) {
      return csrfForbiddenResponse(
        pathname,
        `Cross-site request forgery detected: untrusted origin "${incomingOrigin}".`
      );
    }
    return null;
  }

  // Unauthenticated browser cross-site POST/PUT/PATCH/DELETE guard (Fetch Metadata + Origin/Referer)
  if (!hasApiKey && pathname !== BILLING_WEBHOOK_PATH && !hasAmbientSession) {
    const secFetchSite = request.headers.get('sec-fetch-site')?.toLowerCase().trim();
    if (secFetchSite === 'cross-site') {
      return csrfForbiddenResponse(
        pathname,
        'Cross-site request forgery detected: untrusted Sec-Fetch-Site "cross-site".'
      );
    }
    const incomingOrigin = extractRequestOriginHeader(request, true);
    if (incomingOrigin !== null && !isOriginAllowed(incomingOrigin, request)) {
      return csrfForbiddenResponse(
        pathname,
        `Cross-site request forgery detected: untrusted origin "${incomingOrigin}".`
      );
    }
  }

  return null;
}

const API_HSTS_VALUE = 'max-age=63072000; includeSubDomains';

function finalizeApiHeaders(pathname: string, response: NextResponse): NextResponse {
  if (!response.headers.has('Strict-Transport-Security')) {
    response.headers.set('Strict-Transport-Security', API_HSTS_VALUE);
  }
  if (!response.headers.has('X-Content-Type-Options')) {
    response.headers.set('X-Content-Type-Options', 'nosniff');
  }
  return isV1ApiPath(pathname) ? applyV1CorsHeaders(response) : response;
}

function withV1Cors(pathname: string, outcome: NextResponse | Promise<NextResponse>): NextResponse | Promise<NextResponse> {
  if (outcome instanceof Promise) {
    return outcome.then((response) => finalizeApiHeaders(pathname, response));
  }
  return finalizeApiHeaders(pathname, outcome);
}

export function middleware(request: NextRequest): NextResponse | Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;

  if (isLocalePrefixedApiPath(pathname)) {
    return finalizeApiHeaders(
      pathname,
      problemResponse(HTTP_NOT_FOUND, PROBLEM_NOT_FOUND, 'Not Found', 'API routes take no language prefix.', pathname)
    );
  }
  if (!isApiPath(pathname)) {
    return pathname === '/' ? rootLocaleAnswer(request) : pageLocaleAnswer(request);
  }
  if (isV1ApiPath(pathname) && request.method.toUpperCase() === 'OPTIONS') {
    return finalizeApiHeaders(pathname, createV1PreflightResponse(pathname));
  }

  return withV1Cors(pathname, handleApiMiddleware(request, pathname));
}

function handleApiMiddleware(request: NextRequest, pathname: string): NextResponse | Promise<NextResponse> {
  const isHealthProbe = HEALTH_PATHS.has(pathname) && HEALTH_METHODS.has(request.method.toUpperCase());

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
    // Health probes must not drain (or be starved by) the bucket every unattributed client shares.
    if (isHealthProbe) return NextResponse.next();
  }
  const clientIp = rateLimitKey(clientIpKey(resolved));

  // 1. Edge-level IP Rate Limiter
  const isSignedBillingWebhook =
    request.method.toUpperCase() === 'POST' &&
    pathname === BILLING_WEBHOOK_PATH &&
    hasValidBillingSignatureFormat(request.headers.get(BILLING_SIGNATURE_HEADER));
  const edgeRate =
    isSignedBillingWebhook
      ? checkEdgeIpRateLimit(BILLING_WEBHOOK_BUCKET_KEY, SHARED_LIMITS)
      : checkEdgeIpRateLimit(clientIp, clientIp === UNATTRIBUTED_CLIENT_KEY ? SHARED_LIMITS : PER_CLIENT_LIMITS);
  if (!edgeRate.allowed) {
    return new NextResponse(
      JSON.stringify({
        type: `${PROBLEM_TYPE_BASE}rate-limited`,
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

  // 3. CSRF Protection for Cookie-Authenticated & Browser Cross-Site State Mutations
  if (MUTATING_METHODS.has(request.method.toUpperCase())) {
    const csrfRefusal = checkMutationCsrf(request, pathname);
    if (csrfRefusal) return csrfRefusal;
  }

  if (bodyCheck && request.body) return countedBody(request.body, bodyCheck, pathname);
  return NextResponse.next();
}

export const config = {
  // API routes, and every path that is not a framework internal, a metadata crawler file, or a static asset in `public/` or `src/app/`.
  // Other dotted paths (`/foo.html`, `/wp-login.php`, `/.env`, `/.git/config`, `/ko/robots.txt`) and bare `/api` go
  // through `pageLocaleAnswer`, so `src/app/[locale]/[slug]/page.tsx` and `src/app/[locale]/[...rest]/page.tsx` answer them
  // 404 without reaching `src/app/[locale]/page.tsx` with an unknown `locale` parameter (`NoFallbackError`).
  matcher: [
    '/api/:path*',
    '/((?!api/|_next/|_vercel/|fonts/|format-icons/|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|og\\.png$|sample\\.pdf$|robots\\.txt$|sitemap\\.xml$|\\.well-known/security\\.txt$).*)',
  ],
};
