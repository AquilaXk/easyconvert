import { redisKeyStore } from './redis-key-store';
import { getSessionFromRequest } from '../auth/session';
import type { User } from '../auth/types';
import type { ApiKey } from './types';
import { extractClientIp } from './ip-utils';

export { extractClientIp };

export interface ApiAuthResult {
  authorized: boolean;
  user?: User;
  apiKey?: ApiKey;
  authMethod?: 'api_key' | 'session';
  error?: string;
  status?: number;
  reservationId?: string;
  remaining?: number;
}

export interface ValidateApiAccessOptions {
  requiredUnits?: number;
  requiredScope?: string;
  scope?: string;
}

/**
 * Validates whether an API key's granted scopes satisfy the required permission scope.
 * Supports exact matches, wildcard root ('*'), and hierarchical sub-scopes (e.g. 'jobs:*').
 */
export function isScopeAllowed(grantedScopes?: string[], requiredScope?: string): boolean {
  if (!requiredScope) return true;
  if (!grantedScopes || grantedScopes.length === 0) return true; // Full access for unscoped keys
  if (grantedScopes.includes('*')) return true;
  if (grantedScopes.includes(requiredScope)) return true;

  // Hierarchical wildcard support: e.g. 'jobs:*' covers 'jobs:read' and 'jobs:write'
  const colonIndex = requiredScope.indexOf(':');
  if (colonIndex > 0) {
    const parentScope = requiredScope.substring(0, colonIndex) + ':*';
    if (grantedScopes.includes(parentScope)) return true;
  }

  // Cross-compatibility mappings
  if (requiredScope === 'convert' && (grantedScopes.includes('convert:write') || grantedScopes.includes('convert:read'))) {
    return true;
  }
  if (requiredScope === 'jobs:write' && grantedScopes.includes('convert')) {
    return true;
  }

  return false;
}

function extractApiKeySecret(request: Request): string | null {
  const customHeader = request.headers.get('x-api-key');
  if (customHeader) {
    return customHeader.trim();
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token.startsWith('ec_live_')) {
      return token;
    }
  }

  return null;
}

async function verifyKeyAccess(
  apiKeySecret: string,
  requiredUnits: number,
  requiredScope?: string,
  clientIp?: string
): Promise<ApiAuthResult> {
  const verification = await redisKeyStore.verifyApiKey(apiKeySecret, clientIp);
  if (!verification.valid || !verification.user || !verification.key) {
    const isIpDenied = verification.error?.includes('IP');
    return {
      authorized: false,
      error: verification.error || 'Invalid, revoked, or non-existent API key provided',
      status: isIpDenied ? 403 : 401,
    };
  }

  // Scope enforcement
  if (requiredScope && !isScopeAllowed(verification.key.scopes, requiredScope)) {
    return {
      authorized: false,
      user: verification.user,
      apiKey: verification.key,
      error: `Forbidden: API key lacks required scope '${requiredScope}'`,
      status: 403,
    };
  }

  if (requiredUnits > 0) {
    const reservation = await redisKeyStore.reserveQuota(verification.user.id, requiredUnits);
    if (!reservation.allowed) {
      return {
        authorized: false,
        user: verification.user,
        apiKey: verification.key,
        error: `Daily conversion quota exceeded for tier '${verification.user.tier}'. Please upgrade or wait for the midnight UTC reset.`,
        status: 429,
        remaining: reservation.remaining,
      };
    }
    return {
      authorized: true,
      user: verification.user,
      apiKey: verification.key,
      authMethod: 'api_key',
      reservationId: reservation.reservationId,
      remaining: reservation.remaining,
    };
  } else {
    const quota = await redisKeyStore.getQuotaUsage(verification.user.id);
    if (quota.remaining <= 0) {
      return {
        authorized: false,
        user: verification.user,
        apiKey: verification.key,
        error: `Daily conversion quota exceeded for tier '${verification.user.tier}'.`,
        status: 429,
        remaining: 0,
      };
    }
    return {
      authorized: true,
      user: verification.user,
      apiKey: verification.key,
      authMethod: 'api_key',
      remaining: quota.remaining,
    };
  }
}

async function verifySessionAccess(
  request: Request,
  requiredUnits: number
): Promise<ApiAuthResult> {
  const sessionUser = await getSessionFromRequest(request);
  if (!sessionUser) {
    return {
      authorized: false,
      error: 'Authentication required. Please provide a valid Bearer API key or sign in.',
      status: 401,
    };
  }

  if (requiredUnits > 0) {
    const reservation = await redisKeyStore.reserveQuota(sessionUser.id, requiredUnits);
    if (!reservation.allowed) {
      return {
        authorized: false,
        user: sessionUser,
        error: `Daily conversion quota exceeded for tier '${sessionUser.tier}'.`,
        status: 429,
        remaining: reservation.remaining,
      };
    }
    return {
      authorized: true,
      user: sessionUser,
      authMethod: 'session',
      reservationId: reservation.reservationId,
      remaining: reservation.remaining,
    };
  } else {
    const quota = await redisKeyStore.getQuotaUsage(sessionUser.id);
    if (quota.remaining <= 0) {
      return {
        authorized: false,
        user: sessionUser,
        error: `Daily conversion quota exceeded for tier '${sessionUser.tier}'.`,
        status: 429,
        remaining: 0,
      };
    }
    return {
      authorized: true,
      user: sessionUser,
      authMethod: 'session',
      remaining: quota.remaining,
    };
  }
}

/**
 * Validates programmatic REST API requests using either API Key header or User session.
 * Supports 2-phase quota transactions (reserve) and granular scope verification.
 */
export async function validateApiAccess(
  request: Request,
  optionsOrUnits: number | ValidateApiAccessOptions = 1,
  legacyScope?: string
): Promise<ApiAuthResult> {
  let requiredUnits = 1;
  let requiredScope: string | undefined = legacyScope;

  if (typeof optionsOrUnits === 'number') {
    requiredUnits = optionsOrUnits;
  } else if (typeof optionsOrUnits === 'object' && optionsOrUnits !== null) {
    requiredUnits = optionsOrUnits.requiredUnits ?? 1;
    requiredScope = optionsOrUnits.requiredScope || optionsOrUnits.scope || legacyScope;
  }

  const clientIp = extractClientIp(request);
  const apiKeySecret = extractApiKeySecret(request);
  if (apiKeySecret) {
    return verifyKeyAccess(apiKeySecret, requiredUnits, requiredScope, clientIp);
  }
  return verifySessionAccess(request, requiredUnits);
}

/**
 * Commits a previously reserved quota transaction.
 */
export async function commitQuota(reservationId: string): Promise<boolean> {
  return redisKeyStore.commitQuota(reservationId);
}

/**
 * Rolls back / refunds a previously reserved quota transaction on failure.
 */
export async function rollbackQuota(reservationId: string): Promise<boolean> {
  return redisKeyStore.rollbackQuota(reservationId);
}

