import crypto from 'node:crypto';
import type { GoogleUserInfo } from './types';

export interface OAuthState {
  state: string;
  nonce: string;
  createdAt: number;
}

// In-memory state cache for CSRF protection
const activeStates = new Map<string, OAuthState>();

// Clean up stale states (> 10 minutes)
function cleanStaleStates() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, val] of activeStates.entries()) {
    if (val.createdAt < cutoff) {
      activeStates.delete(key);
    }
  }
}

export function generateOAuthState(): string {
  cleanStaleStates();
  const state = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  activeStates.set(state, {
    state,
    nonce,
    createdAt: Date.now(),
  });
  return state;
}

export function validateOAuthState(state: string): boolean {
  cleanStaleStates();
  if (!state || !activeStates.has(state)) {
    return false;
  }
  activeStates.delete(state);
  return true;
}

export function getGoogleOAuthUrl(redirectUri: string, customState?: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const state = customState || generateOAuthState();

  // If Google Client ID is missing, provide local mock sandbox callback
  if (!clientId) {
    const mockUrl = new URL(redirectUri);
    mockUrl.searchParams.set('code', `mock_code_${state}`);
    mockUrl.searchParams.set('state', state);
    mockUrl.searchParams.set('mock', 'true');
    return mockUrl.toString();
  }

  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: redirectUri,
    client_id: clientId,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    scope: ['openid', 'email', 'profile'].join(' '),
    state,
  };

  const qs = new URLSearchParams(options).toString();
  return `${rootUrl}?${qs}`;
}

export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleUserInfo> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  // Local mock sandbox handling
  const isProduction = process.env.NODE_ENV === 'production';
  if (code.startsWith('mock_code_')) {
    if (isProduction) {
      throw new Error('Security violation: Mock codes are not permitted in production');
    }
    return {
      id: 'google_mock_sub_10001',
      email: 'dev.sandbox@example.com',
      name: 'Sandbox Developer',
      picture: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=120&h=120&q=80',
    };
  }

  if (!clientId || !clientSecret) {
    if (isProduction) {
      throw new Error('OAuth configuration error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production');
    }
    return {
      id: 'google_mock_sub_10001',
      email: 'dev.sandbox@example.com',
      name: 'Sandbox Developer',
      picture: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=120&h=120&q=80',
    };
  }

  // Live RFC 6749 Authorization Code Token Exchange
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const tokenParams = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: tokenParams.toString(),
  });

  if (!tokenRes.ok) {
    const errorText = await tokenRes.text();
    throw new Error(`Google token exchange failed: ${tokenRes.status} ${errorText}`);
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  if (!accessToken) {
    throw new Error('No access_token returned by Google token endpoint');
  }

  // OpenID Connect UserInfo endpoint
  const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!userinfoRes.ok) {
    const errorText = await userinfoRes.text();
    throw new Error(`Failed to fetch Google user profile: ${userinfoRes.status} ${errorText}`);
  }

  const userData = await userinfoRes.json();
  return {
    id: userData.sub,
    email: userData.email,
    name: userData.name || userData.email.split('@')[0],
    picture: userData.picture,
  };
}
