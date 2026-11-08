import { NextRequest, NextResponse } from 'next/server';
import { extractClientIp } from '../api-keys/ip-utils';
import { RATE_LIMITED_PROBLEM_TYPE, codedRefusal } from '../api/problem-details';
import type { AuthErrorCode } from '../refusal-codes';
import {
  CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS,
  ClientIpError,
  UNATTRIBUTED_CLIENT_KEY,
  rateLimitKey,
} from '../security/client-ip';
import { sha256 } from './crypto';
import { redisUserStore } from './redis-user-store';

const authRefusal = codedRefusal<AuthErrorCode>;
const HTTP_SERVICE_UNAVAILABLE = 503;
const CLIENT_IP_MALFORMED_MESSAGE = 'Client address could not be determined from the request headers.';
const CLIENT_IP_CONFIG_MESSAGE = "Server misconfiguration: the server's client-IP trust configuration is missing or invalid.";

export function resolveAuthClientIp(
  req: NextRequest
): { clientIp: string | null } | { refused: NextResponse } {
  try {
    const resolvedIp = extractClientIp(req);
    return {
      clientIp: resolvedIp === UNATTRIBUTED_CLIENT_KEY ? null : rateLimitKey(resolvedIp),
    };
  } catch (error) {
    if (!(error instanceof ClientIpError)) throw error;
    if (error.status === HTTP_SERVICE_UNAVAILABLE) {
      return {
        refused: authRefusal(error.status, 'client_ip_unconfigured', CLIENT_IP_CONFIG_MESSAGE, {}, {
          'Retry-After': String(CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS),
        }),
      };
    }
    return {
      refused: authRefusal(error.status, 'client_address_unknown', CLIENT_IP_MALFORMED_MESSAGE),
    };
  }
}

export function authRateLimitRefusal(
  retryAfterSeconds: number,
  detail: string,
  code: AuthErrorCode = 'login_locked'
): NextResponse {
  return NextResponse.json(
    {
      type: RATE_LIMITED_PROBLEM_TYPE,
      title: 'Too Many Requests',
      status: 429,
      code,
      detail,
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
    }
  );
}

export const LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL = 5;
export const LOGIN_MAX_FAILED_ATTEMPTS_PER_IP = 10;
export const LOGIN_WINDOW_SECONDS = 300; // 5 minutes
// Coarse cross-account failure counter, used only for unattributed clients (no per-IP counter exists for them).
// High enough that honest typos never reach it, low enough to bound credential stuffing across many accounts.
export const LOGIN_GLOBAL_MAX_FAILED_ATTEMPTS = 300;
export const LOGIN_GLOBAL_WINDOW_SECONDS = 300; // 5 minutes
const GLOBAL_ATTEMPTS_KEY = 'global';

export const REGISTER_MAX_ATTEMPTS_PER_IP = 10;
export const REGISTER_WINDOW_SECONDS = 300;
export const REGISTER_GLOBAL_MAX_ATTEMPTS = 300;
const REGISTER_GLOBAL_ATTEMPTS_KEY = 'register:global';

export interface LoginRateLimitCheckResult {
  allowed: boolean;
  retryAfterSeconds: number;
  reason?: 'email' | 'ip' | 'global';
}

interface AttemptEntry {
  count: number;
  expiresAt: number;
}

// In-memory fallback cache for isolated unit test and development environments
const inMemoryAttempts = new Map<string, AttemptEntry>();

function cleanStaleAttempts() {
  const now = Date.now();
  for (const [key, entry] of inMemoryAttempts.entries()) {
    if (now > entry.expiresAt) {
      inMemoryAttempts.delete(key);
    }
  }
}

/**
 * A null ip means the client could not be attributed. Every unattributed caller would share one per-IP
 * counter, letting one client lock out everyone, so the per-IP counter is skipped (the per-email counter and
 * lockout still apply). An empty string keeps the legacy loopback key.
 */
function normalizeLoginIp(ip: string | null): string {
  if (ip === null) return '';
  return ip ? ip.trim() : '127.0.0.1';
}

/**
 * A null ip is an unattributed client: it has no per-IP counter, so it feeds the coarse global counter instead.
 */
function usesGlobalCounter(ip: string | null): boolean {
  return ip === null;
}

/**
 * Checks whether login is permitted for the given IP address and email.
 */
export async function checkLoginRateLimit(
  ip: string | null,
  email: string
): Promise<LoginRateLimitCheckResult> {
  const normEmail = email ? email.toLowerCase().trim() : '';
  const normIp = normalizeLoginIp(ip);
  const useGlobal = usesGlobalCounter(ip);

  const redis = redisUserStore.getRedisClient();
  const prefix = redisUserStore.getKeyPrefix();

  if (redis) {
    try {
      const emailKey = `${prefix}login_attempts:email:${normEmail}`;
      const ipKey = `${prefix}login_attempts:ip:${normIp}`;

      if (normEmail) {
        const emailAttempts = parseInt((await redis.get(emailKey)) || '0', 10);
        if (emailAttempts >= LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL) {
          const ttl = Math.max(1, await redis.ttl(emailKey));
          return { allowed: false, retryAfterSeconds: ttl, reason: 'email' };
        }
      }

      if (normIp) {
        const ipAttempts = parseInt((await redis.get(ipKey)) || '0', 10);
        if (ipAttempts >= LOGIN_MAX_FAILED_ATTEMPTS_PER_IP) {
          const ttl = Math.max(1, await redis.ttl(ipKey));
          return { allowed: false, retryAfterSeconds: ttl, reason: 'ip' };
        }
      }

      if (useGlobal) {
        const globalKey = `${prefix}login_attempts:${GLOBAL_ATTEMPTS_KEY}`;
        const globalAttempts = parseInt((await redis.get(globalKey)) || '0', 10);
        if (globalAttempts >= LOGIN_GLOBAL_MAX_FAILED_ATTEMPTS) {
          const ttl = Math.max(1, await redis.ttl(globalKey));
          return { allowed: false, retryAfterSeconds: ttl, reason: 'global' };
        }
      }

      return { allowed: true, retryAfterSeconds: 0 };
    } catch {
      // Fallback to in-memory on Redis error
    }
  }

  cleanStaleAttempts();
  const now = Date.now();

  if (normEmail) {
    const entry = inMemoryAttempts.get(`email:${normEmail}`);
    if (entry && entry.count >= LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL && now < entry.expiresAt) {
      const retryAfter = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
      return { allowed: false, retryAfterSeconds: retryAfter, reason: 'email' };
    }
  }

  if (normIp) {
    const entry = inMemoryAttempts.get(`ip:${normIp}`);
    if (entry && entry.count >= LOGIN_MAX_FAILED_ATTEMPTS_PER_IP && now < entry.expiresAt) {
      const retryAfter = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
      return { allowed: false, retryAfterSeconds: retryAfter, reason: 'ip' };
    }
  }

  if (useGlobal) {
    const entry = inMemoryAttempts.get(GLOBAL_ATTEMPTS_KEY);
    if (entry && entry.count >= LOGIN_GLOBAL_MAX_FAILED_ATTEMPTS && now < entry.expiresAt) {
      const retryAfter = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
      return { allowed: false, retryAfterSeconds: retryAfter, reason: 'global' };
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Increments failed login attempt counters for the IP and email.
 */
export async function recordFailedLogin(ip: string | null, email: string): Promise<void> {
  const normEmail = email ? email.toLowerCase().trim() : '';
  const normIp = normalizeLoginIp(ip);
  const useGlobal = usesGlobalCounter(ip);

  const redis = redisUserStore.getRedisClient();
  const prefix = redisUserStore.getKeyPrefix();

  if (redis) {
    try {
      const pipeline = redis.pipeline();
      if (normEmail) {
        const emailKey = `${prefix}login_attempts:email:${normEmail}`;
        pipeline.incr(emailKey);
        pipeline.expire(emailKey, LOGIN_WINDOW_SECONDS);
      }
      if (normIp) {
        const ipKey = `${prefix}login_attempts:ip:${normIp}`;
        pipeline.incr(ipKey);
        pipeline.expire(ipKey, LOGIN_WINDOW_SECONDS);
      }
      if (useGlobal) {
        const globalKey = `${prefix}login_attempts:${GLOBAL_ATTEMPTS_KEY}`;
        pipeline.incr(globalKey);
        pipeline.expire(globalKey, LOGIN_GLOBAL_WINDOW_SECONDS);
      }
      await pipeline.exec();
      return;
    } catch {
      // Fallback
    }
  }

  cleanStaleAttempts();
  const now = Date.now();
  const expiresAt = now + LOGIN_WINDOW_SECONDS * 1000;

  if (normEmail) {
    const key = `email:${normEmail}`;
    const existing = inMemoryAttempts.get(key);
    inMemoryAttempts.set(key, {
      count: (existing?.count || 0) + 1,
      expiresAt: existing ? existing.expiresAt : expiresAt,
    });
  }

  if (normIp) {
    const key = `ip:${normIp}`;
    const existing = inMemoryAttempts.get(key);
    inMemoryAttempts.set(key, {
      count: (existing?.count || 0) + 1,
      expiresAt: existing ? existing.expiresAt : expiresAt,
    });
  }

  if (useGlobal) {
    const existing = inMemoryAttempts.get(GLOBAL_ATTEMPTS_KEY);
    inMemoryAttempts.set(GLOBAL_ATTEMPTS_KEY, {
      count: (existing?.count || 0) + 1,
      expiresAt: existing ? existing.expiresAt : now + LOGIN_GLOBAL_WINDOW_SECONDS * 1000,
    });
  }
}

/**
 * Resets failed login attempt counters after a successful authentication.
 */
export async function resetLoginAttempts(ip: string | null, email: string): Promise<void> {
  const normEmail = email ? email.toLowerCase().trim() : '';
  const normIp = normalizeLoginIp(ip);

  const redis = redisUserStore.getRedisClient();
  const prefix = redisUserStore.getKeyPrefix();

  if (redis) {
    try {
      const keysToDelete: string[] = [];
      if (normEmail) keysToDelete.push(`${prefix}login_attempts:email:${normEmail}`);
      if (normIp) keysToDelete.push(`${prefix}login_attempts:ip:${normIp}`);
      if (keysToDelete.length > 0) {
        await redis.del(...keysToDelete);
      }
      return;
    } catch {
      // Fallback
    }
  }

  if (normEmail) inMemoryAttempts.delete(`email:${normEmail}`);
  if (normIp) inMemoryAttempts.delete(`ip:${normIp}`);
}

async function consumeRedisFixedWindow(
  redis: NonNullable<ReturnType<typeof redisUserStore.getRedisClient>>,
  key: string,
  windowSeconds: number,
  maxAttempts: number,
  reason: 'email' | 'ip' | 'global'
): Promise<LoginRateLimitCheckResult | null> {
  const pipeline = redis.pipeline();
  pipeline.set(key, 0, 'EX', windowSeconds, 'NX');
  pipeline.incr(key);
  pipeline.ttl(key);
  const results = await pipeline.exec();
  if (!results || results.some(([err]) => err !== null)) {
    throw new Error('Redis registration rate-limit pipeline failed');
  }
  const count = Number(results[1]?.[1] ?? 0);
  const ttlRaw = Number(results[2]?.[1] ?? windowSeconds);
  if (ttlRaw < 0) {
    await redis.expire(key, windowSeconds);
  }
  const retryAfterSeconds = ttlRaw < 0 ? windowSeconds : Math.max(1, ttlRaw);
  if (count > maxAttempts) {
    return { allowed: false, retryAfterSeconds, reason };
  }
  return null;
}

export async function consumeRegistrationRateLimit(
  ip: string | null
): Promise<LoginRateLimitCheckResult> {
  const normIp = normalizeLoginIp(ip);
  const useGlobal = usesGlobalCounter(ip);

  const redis = redisUserStore.getRedisClient();
  const prefix = redisUserStore.getKeyPrefix();

  if (redis) {
    try {
      if (normIp) {
        const ipKey = `${prefix}register_attempts:ip:${normIp}`;
        const blocked = await consumeRedisFixedWindow(
          redis,
          ipKey,
          REGISTER_WINDOW_SECONDS,
          REGISTER_MAX_ATTEMPTS_PER_IP,
          'ip'
        );
        if (blocked) return blocked;
      }

      if (useGlobal) {
        const globalKey = `${prefix}register_attempts:${GLOBAL_ATTEMPTS_KEY}`;
        const blocked = await consumeRedisFixedWindow(
          redis,
          globalKey,
          REGISTER_WINDOW_SECONDS,
          REGISTER_GLOBAL_MAX_ATTEMPTS,
          'global'
        );
        if (blocked) return blocked;
      }

      return { allowed: true, retryAfterSeconds: 0 };
    } catch {}
  }

  cleanStaleAttempts();
  const now = Date.now();
  const expiresAt = now + REGISTER_WINDOW_SECONDS * 1000;

  if (normIp) {
    const key = `register:ip:${normIp}`;
    const existing = inMemoryAttempts.get(key);
    const entry: AttemptEntry =
      existing && now < existing.expiresAt
        ? { count: existing.count + 1, expiresAt: existing.expiresAt }
        : { count: 1, expiresAt };
    inMemoryAttempts.set(key, entry);
    if (entry.count > REGISTER_MAX_ATTEMPTS_PER_IP) {
      const retryAfter = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
      return { allowed: false, retryAfterSeconds: retryAfter, reason: 'ip' };
    }
  }

  if (useGlobal) {
    const existing = inMemoryAttempts.get(REGISTER_GLOBAL_ATTEMPTS_KEY);
    const entry: AttemptEntry =
      existing && now < existing.expiresAt
        ? { count: existing.count + 1, expiresAt: existing.expiresAt }
        : { count: 1, expiresAt };
    inMemoryAttempts.set(REGISTER_GLOBAL_ATTEMPTS_KEY, entry);
    if (entry.count > REGISTER_GLOBAL_MAX_ATTEMPTS) {
      const retryAfter = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
      return { allowed: false, retryAfterSeconds: retryAfter, reason: 'global' };
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Resets all in-memory login rate limit state (useful for test isolation).
 */
export function resetLoginRateLimiterStore(): void {
  inMemoryAttempts.clear();
}

// ---------------------------------------------------------------------------------------------------------
// Mailed links: password reset and email verification
// ---------------------------------------------------------------------------------------------------------

export type MailLinkAction = 'reset-request' | 'verify-resend' | 'reset-confirm' | 'verify-confirm';

export const MAIL_LINK_WINDOW_SECONDS = 600;
/** Mails per address (reset) or account (verification) in one window; the same for known and unknown addresses. */
export const MAIL_LINK_MAX_PER_SUBJECT = 3;
export const MAIL_LINK_MAX_PER_IP = 10;
/** Uses of a link per client in one window; a token is 256 random bits, so this only bounds the load. */
export const MAIL_LINK_CONFIRM_MAX_PER_IP = 30;
export const MAIL_LINK_GLOBAL_MAX = 300;

interface MailLimit {
  key: string;
  max: number;
  reason: 'email' | 'ip' | 'global';
}

function memoryWindow(key: string, max: number, windowSeconds: number, reason: MailLimit['reason']): LoginRateLimitCheckResult | null {
  const now = Date.now();
  const existing = inMemoryAttempts.get(key);
  const entry: AttemptEntry =
    existing && now < existing.expiresAt
      ? { count: existing.count + 1, expiresAt: existing.expiresAt }
      : { count: 1, expiresAt: now + windowSeconds * 1000 };
  inMemoryAttempts.set(key, entry);
  if (entry.count <= max) return null;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)), reason };
}

/**
 * Counts one request for a mailed-link action against its limits and says whether it may go on. The subject (an email
 * address or an account id) is counted whether or not an account exists, so the limit tells nothing about accounts; it is
 * kept as a hash. A client that cannot be attributed (`ip` null) shares one coarse counter instead of a per-client one.
 */
export async function consumeMailLinkRateLimit(
  action: MailLinkAction,
  ip: string | null,
  subject: string | null
): Promise<LoginRateLimitCheckResult> {
  const confirming = action === 'reset-confirm' || action === 'verify-confirm';
  const normIp = normalizeLoginIp(ip);
  const limits: MailLimit[] = [];
  if (subject) {
    limits.push({
      key: `mail_link:${action}:subject:${sha256(subject.toLowerCase().trim())}`,
      max: MAIL_LINK_MAX_PER_SUBJECT,
      reason: 'email',
    });
  }
  if (normIp) {
    limits.push({
      key: `mail_link:${action}:ip:${normIp}`,
      max: confirming ? MAIL_LINK_CONFIRM_MAX_PER_IP : MAIL_LINK_MAX_PER_IP,
      reason: 'ip',
    });
  }
  if (usesGlobalCounter(ip)) {
    limits.push({ key: `mail_link:${action}:global`, max: MAIL_LINK_GLOBAL_MAX, reason: 'global' });
  }

  const redis = redisUserStore.getRedisClient();
  const prefix = redisUserStore.getKeyPrefix();
  for (const limit of limits) {
    let blocked: LoginRateLimitCheckResult | null | undefined;
    if (redis) {
      try {
        blocked = await consumeRedisFixedWindow(redis, `${prefix}${limit.key}`, MAIL_LINK_WINDOW_SECONDS, limit.max, limit.reason);
      } catch {
        blocked = undefined;
      }
    }
    if (blocked === undefined) blocked = memoryWindow(limit.key, limit.max, MAIL_LINK_WINDOW_SECONDS, limit.reason);
    if (blocked) return blocked;
  }
  return { allowed: true, retryAfterSeconds: 0 };
}
