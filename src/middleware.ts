import { NextRequest, NextResponse } from 'next/server';
import {
  ClientIpError,
  clientIpKey,
  rateLimitKey,
  resolveClientIp,
  type ResolvedClientIp,
} from '@/lib/security/client-ip';

/**
 * Next.js Edge-compatible Centralized Middleware
 * 1. Cross-Site Request Forgery (CSRF) Protection: Enforces strict Origin / Referer validation
 *    on cookie-authenticated state-changing requests (POST, PUT, PATCH, DELETE).
 * 2. Anonymous IP Edge Rate Limiting: Protective token bucket guard against burst abuse.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const HTTP_BAD_REQUEST = 400;
const PROBLEM_BAD_REQUEST = 'https://api.easyconvert.io/problems/bad-request';
const PROBLEM_INTERNAL_ERROR = 'https://api.easyconvert.io/problems/internal-server-error';

// Fast Edge-compatible in-memory rate limiter per Edge worker instance
interface EdgeRateBucket {
  tokens: number;
  lastRefill: number;
}
const edgeIpBuckets = new Map<string, EdgeRateBucket>();
const EDGE_BUCKET_CAPACITY = 60;
const EDGE_REFILL_RATE = 10; // 10 tokens per second

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
  let bucket = edgeIpBuckets.get(clientIp);

  if (!bucket) {
    bucket = { tokens: EDGE_BUCKET_CAPACITY - 1, lastRefill: now };
    edgeIpBuckets.set(clientIp, bucket);
    return { allowed: true, retryAfterSec: 0 };
  }

  const elapsedSec = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(EDGE_BUCKET_CAPACITY, bucket.tokens + elapsedSec * EDGE_REFILL_RATE);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  const needed = 1 - bucket.tokens;
  const retryAfterSec = Math.max(1, Math.ceil(needed / EDGE_REFILL_RATE));
  return { allowed: false, retryAfterSec };
}

function problemResponse(status: number, title: string, detail: string, instance: string): NextResponse {
  return new NextResponse(
    JSON.stringify({
      type: status === HTTP_BAD_REQUEST ? PROBLEM_BAD_REQUEST : PROBLEM_INTERNAL_ERROR,
      title,
      status,
      detail,
      instance,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } }
  );
}

let warnedUnattributed = false;

function warnUnattributedOnce(): void {
  if (warnedUnattributed) return;
  warnedUnattributed = true;
  console.warn(
    '[edge] Client IP cannot be attributed: set TRUSTED_PROXIES (and/or TRUSTED_CDN) to declare the proxy in ' +
      'front of this server. Until then every request shares one rate-limit bucket.'
  );
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

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Only protect API routes
  if (!pathname.startsWith('/api')) {
    return NextResponse.next();
  }

  // Edge barrier identity. The middleware cannot see the socket peer, so attribution follows the deployment
  // contract in src/lib/security/client-ip.ts: forwarding headers count only behind a declared proxy, and an
  // unattributed request shares one conservative bucket instead of a header-chosen key.
  let resolved: ResolvedClientIp;
  try {
    resolved = resolveClientIp(request);
  } catch (error) {
    if (!(error instanceof ClientIpError)) throw error;
    if (error.status === HTTP_BAD_REQUEST) {
      return problemResponse(error.status, 'Bad Request', 'Malformed client address in forwarding headers.', pathname);
    }
    console.error(`[edge] ${error.message}`);
    return problemResponse(error.status, 'Internal Server Error', 'Client IP trust configuration is invalid.', pathname);
  }
  if (resolved.source === 'unattributed') warnUnattributedOnce();
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

  // 2. CSRF Protection for Cookie-Authenticated State Mutations
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

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
