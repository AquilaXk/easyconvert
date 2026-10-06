import { redisUserStore } from './redis-user-store';

export const LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL = 5;
export const LOGIN_MAX_FAILED_ATTEMPTS_PER_IP = 10;
export const LOGIN_WINDOW_SECONDS = 300; // 5 minutes
// Coarse cross-account failure counter, used only for unattributed clients (no per-IP counter exists for them).
// High enough that honest typos never reach it, low enough to bound credential stuffing across many accounts.
export const LOGIN_GLOBAL_MAX_FAILED_ATTEMPTS = 300;
export const LOGIN_GLOBAL_WINDOW_SECONDS = 300; // 5 minutes
const GLOBAL_ATTEMPTS_KEY = 'global';

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

/**
 * Resets all in-memory login rate limit state (useful for test isolation).
 */
export function resetLoginRateLimiterStore(): void {
  inMemoryAttempts.clear();
}
