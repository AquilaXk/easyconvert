import { keyStore } from './key-store';
import { redisKeyStore } from './redis-key-store';
import { getSessionFromRequest } from '../auth/session';
import type { User } from '../auth/types';
import type { ApiKey } from './types';

export interface ApiAuthResult {
  authorized: boolean;
  user?: User;
  apiKey?: ApiKey;
  authMethod?: 'api_key' | 'session';
  error?: string;
  status?: number;
}

export function extractClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  let candidate = '';
  if (forwarded) {
    candidate = forwarded.split(',')[0].trim();
  } else {
    const realIp = request.headers.get('x-real-ip');
    if (realIp) {
      candidate = realIp.trim();
    } else {
      const cfIp = request.headers.get('cf-connecting-ip');
      if (cfIp) candidate = cfIp.trim();
    }
  }

  if (candidate) {
    // Strip brackets and optional port from IPv6, e.g. [2001:db8::1]:8080 or [::1]
    const bracketMatch = candidate.match(/^\[([a-fA-F0-9:]+)\](?::\d+)?$/);
    if (bracketMatch) return bracketMatch[1];
    // Strip trailing port from IPv4, e.g. 192.168.1.1:8080
    const portMatch = candidate.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
    if (portMatch) return portMatch[1];
    return candidate;
  }

  return '127.0.0.1';
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

  if (requiredUnits > 0) {
    const quotaCheck = await keyStore.recordUsage(verification.user.id, requiredUnits);
    if (!quotaCheck.allowed) {
      return {
        authorized: false,
        user: verification.user,
        apiKey: verification.key,
        error: `Daily conversion quota exceeded for tier '${verification.user.tier}'. Please upgrade or wait for the midnight UTC reset.`,
        status: 429,
      };
    }
  } else {
    const quota = await keyStore.getQuotaUsage(verification.user.id);
    if (quota.remaining <= 0) {
      return {
        authorized: false,
        user: verification.user,
        apiKey: verification.key,
        error: `Daily conversion quota exceeded for tier '${verification.user.tier}'.`,
        status: 429,
      };
    }
  }

  return {
    authorized: true,
    user: verification.user,
    apiKey: verification.key,
    authMethod: 'api_key',
  };
}

async function verifySessionAccess(request: Request, requiredUnits: number): Promise<ApiAuthResult> {
  const sessionUser = await getSessionFromRequest(request);
  if (!sessionUser) {
    return {
      authorized: false,
      error: 'Authentication required. Please provide a valid Bearer API key or sign in.',
      status: 401,
    };
  }

  if (requiredUnits > 0) {
    const quotaCheck = await keyStore.recordUsage(sessionUser.id, requiredUnits);
    if (!quotaCheck.allowed) {
      return {
        authorized: false,
        user: sessionUser,
        error: `Daily conversion quota exceeded for tier '${sessionUser.tier}'.`,
        status: 429,
      };
    }
  } else {
    const quota = await keyStore.getQuotaUsage(sessionUser.id);
    if (quota.remaining <= 0) {
      return {
        authorized: false,
        user: sessionUser,
        error: `Daily conversion quota exceeded for tier '${sessionUser.tier}'.`,
        status: 429,
      };
    }
  }

  return {
    authorized: true,
    user: sessionUser,
    authMethod: 'session',
  };
}

/**
 * Validates programmatic REST API requests using either API Key header or User session.
 */
export async function validateApiAccess(
  request: Request,
  requiredUnits: number = 1
): Promise<ApiAuthResult> {
  const clientIp = extractClientIp(request);
  const apiKeySecret = extractApiKeySecret(request);
  if (apiKeySecret) {
    return verifyKeyAccess(apiKeySecret, requiredUnits, clientIp);
  }
  return verifySessionAccess(request, requiredUnits);
}
