import { keyStore } from './key-store';
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

/**
 * Validates programmatic REST API requests using either API Key header or User session.
 */
export async function validateApiAccess(
  request: Request,
  requiredUnits: number = 1
): Promise<ApiAuthResult> {
  let apiKeySecret: string | null = null;

  // 1. Check X-API-Key header
  const customHeader = request.headers.get('x-api-key');
  if (customHeader) {
    apiKeySecret = customHeader.trim();
  }

  // 2. Check Authorization header
  if (!apiKeySecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      if (token.startsWith('ec_live_')) {
        apiKeySecret = token;
      }
    }
  }

  // If API Key provided, verify it
  if (apiKeySecret) {
    const verification = await keyStore.verifyApiKey(apiKeySecret);
    if (!verification.valid || !verification.user || !verification.key) {
      return {
        authorized: false,
        error: 'Invalid, revoked, or non-existent API key provided',
        status: 401,
      };
    }

    // Check quota
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

    return {
      authorized: true,
      user: verification.user,
      apiKey: verification.key,
      authMethod: 'api_key',
    };
  }

  // Otherwise, fall back to active session
  const sessionUser = await getSessionFromRequest(request);
  if (sessionUser) {
    const quotaCheck = await keyStore.recordUsage(sessionUser.id, requiredUnits);
    if (!quotaCheck.allowed) {
      return {
        authorized: false,
        user: sessionUser,
        error: `Daily conversion quota exceeded for tier '${sessionUser.tier}'.`,
        status: 429,
      };
    }

    return {
      authorized: true,
      user: sessionUser,
      authMethod: 'session',
    };
  }

  return {
    authorized: false,
    error: 'Authentication required. Please provide a valid Bearer API key or sign in.',
    status: 401,
  };
}
