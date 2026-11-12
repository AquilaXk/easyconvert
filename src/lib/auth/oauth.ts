import crypto from 'node:crypto';
import type { GoogleUserInfo } from './types';
import { redisUserStore } from './redis-user-store';
import { failClosed } from './store-unavailable';
import { routing, type AppLocale } from '@/i18n/routing';

export const OAUTH_STATE_COOKIE_NAME = 'easyconvert_oauth_state';
export const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes

export interface OAuthSessionState {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  createdAt: number;
  /** The language the sign-in started in, so that the callback answers in it. */
  locale: AppLocale;
  /** The version of the terms accepted on the sign-up form, kept only when it was the one in force; an account the callback creates records it. */
  acceptedTermsVersion?: string;
}

/** `value` when it names a language the site offers, else the default language. */
export function offeredLocale(value: unknown): AppLocale {
  return routing.locales.find((locale) => locale === value) ?? routing.defaultLocale;
}

// In-memory fallback cache for CSRF protection in local dev / unit tests
const activeStates = new Map<string, OAuthSessionState>();

function cleanStaleStates() {
  const cutoff = Date.now() - OAUTH_STATE_TTL_SECONDS * 1000;
  for (const [key, val] of activeStates.entries()) {
    if (val.createdAt < cutoff) {
      activeStates.delete(key);
    }
  }
}

/**
 * Derives PKCE code_verifier and code_challenge conforming to RFC 7636 (S256).
 */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  // 32 cryptographically secure bytes -> 43 base64url characters
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Creates and persists an OAuth session (state, nonce, PKCE verifier) in Redis or local cache.
 */
export async function createOAuthSession(options?: {
  state?: string;
  nonce?: string;
  codeVerifier?: string;
  locale?: AppLocale;
  acceptedTermsVersion?: string;
}): Promise<OAuthSessionState> {
  cleanStaleStates();
  const state = options?.state || crypto.randomBytes(24).toString('hex');
  const nonce = options?.nonce || crypto.randomBytes(16).toString('hex');

  let codeVerifier = options?.codeVerifier;
  let codeChallenge: string;

  if (codeVerifier) {
    codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
  } else {
    const pkce = createPkcePair();
    codeVerifier = pkce.codeVerifier;
    codeChallenge = pkce.codeChallenge;
  }

  const sessionState: OAuthSessionState = {
    state,
    nonce,
    codeVerifier,
    codeChallenge,
    createdAt: Date.now(),
    locale: options?.locale ?? routing.defaultLocale,
    acceptedTermsVersion: options?.acceptedTermsVersion,
  };

  const redis = redisUserStore.getRedisClient();
  if (redis) {
    try {
      const key = `${redisUserStore.getKeyPrefix()}oauth_state:${state}`;
      await redis.setex(key, OAUTH_STATE_TTL_SECONDS, JSON.stringify(sessionState));
      return sessionState;
    } catch (err) {
      // A state kept only in this process would be unknown to the process that gets the callback.
      return failClosed('OAuth', 'createOAuthSession', err);
    }
  }

  activeStates.set(state, sessionState);
  return sessionState;
}

/**
 * Consumes an OAuth state: it can be used once. In Redis it is read and deleted by one command (GETDEL), so two callbacks that
 * carry the same state cannot both get it; with a Redis that fails the answer is AuthStoreUnavailableError, never a state this
 * process happens to hold.
 */
export async function consumeOAuthSession(state: string): Promise<OAuthSessionState | null> {
  if (!state || typeof state !== 'string') {
    return null;
  }

  cleanStaleStates();

  const redis = redisUserStore.getRedisClient();
  if (redis) {
    let raw: string | null;
    try {
      raw = await redis.getdel(`${redisUserStore.getKeyPrefix()}oauth_state:${state}`);
    } catch (err) {
      return failClosed('OAuth', 'consumeOAuthSession', err);
    }
    activeStates.delete(state);
    if (!raw) return null;
    const stored = JSON.parse(raw) as OAuthSessionState;
    return { ...stored, locale: offeredLocale(stored.locale) };
  }

  const local = activeStates.get(state);
  if (local) {
    activeStates.delete(state);
    return local;
  }

  return null;
}

/**
 * Synchronous/async legacy helper generating an OAuth state token.
 */
export function generateOAuthState(): string {
  cleanStaleStates();
  const state = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const pkce = createPkcePair();
  const session: OAuthSessionState = {
    state,
    nonce,
    codeVerifier: pkce.codeVerifier,
    codeChallenge: pkce.codeChallenge,
    createdAt: Date.now(),
    locale: routing.defaultLocale,
  };
  activeStates.set(state, session);

  const redis = redisUserStore.getRedisClient();
  if (redis) {
    try {
      const key = `${redisUserStore.getKeyPrefix()}oauth_state:${state}`;
      redis.setex(key, OAUTH_STATE_TTL_SECONDS, JSON.stringify(session)).catch(() => {});
    } catch {
      // Ignore sync error in legacy fire-and-forget
    }
  }

  return state;
}

/**
 * Validates whether an OAuth state exists and consumes it (one-time use).
 */
export function validateOAuthState(state: string): boolean {
  cleanStaleStates();
  if (!state || !activeStates.has(state)) {
    return false;
  }
  activeStates.delete(state);

  const redis = redisUserStore.getRedisClient();
  if (redis) {
    const key = `${redisUserStore.getKeyPrefix()}oauth_state:${state}`;
    redis.del(key).catch(() => {});
  }

  return true;
}

export function getAppOrigin(): string {
  const configured =
    process.env.APP_ORIGIN?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }

  return 'http://localhost:3000';
}

export function getGoogleOAuthUrl(
  redirectUri: string,
  customStateOrSession?: string | OAuthSessionState
): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;

  let state: string;
  let nonce: string | undefined;
  let codeChallenge: string | undefined;

  if (typeof customStateOrSession === 'string') {
    state = customStateOrSession;
  } else if (customStateOrSession && typeof customStateOrSession === 'object') {
    state = customStateOrSession.state;
    nonce = customStateOrSession.nonce;
    codeChallenge = customStateOrSession.codeChallenge;
  } else {
    state = generateOAuthState();
    const session = activeStates.get(state);
    if (session) {
      nonce = session.nonce;
      codeChallenge = session.codeChallenge;
    }
  }

  // If Google Client ID is missing, provide local mock sandbox callback in non-production
  if (!clientId) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('OAuth configuration error: GOOGLE_CLIENT_ID is not configured in production');
    }
    const mockUrl = new URL(redirectUri);
    mockUrl.searchParams.set('code', `mock_code_${state}`);
    mockUrl.searchParams.set('state', state);
    mockUrl.searchParams.set('mock', 'true');
    return mockUrl.toString();
  }

  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options: Record<string, string> = {
    redirect_uri: redirectUri,
    client_id: clientId,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    scope: ['openid', 'email', 'profile'].join(' '),
    state,
  };

  if (nonce) {
    options.nonce = nonce;
  }
  if (codeChallenge) {
    options.code_challenge = codeChallenge;
    options.code_challenge_method = 'S256';
  }

  const qs = new URLSearchParams(options).toString();
  return `${rootUrl}?${qs}`;
}

/** The claims of the ID token that Google returned from its token endpoint (read over TLS from Google, so the signature is not what is checked here). */
function idTokenClaims(idToken: unknown): { nonce?: unknown; sub?: unknown; aud?: unknown; iss?: unknown; exp?: unknown } {
  if (typeof idToken !== 'string') throw new Error('Security violation: Google returned no ID token');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Security violation: Google ID token is malformed');
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw new Error('not an object');
    return claims as { nonce?: unknown; sub?: unknown; aud?: unknown; iss?: unknown; exp?: unknown };
  } catch {
    throw new Error('Security violation: Google ID token is malformed');
  }
}

/** The two issuer values Google's ID tokens carry (OpenID Connect Core 3.1.3.7 and Google's own documentation). */
const GOOGLE_ID_TOKEN_ISSUERS: ReadonlySet<unknown> = new Set(['https://accounts.google.com', 'accounts.google.com']);

/**
 * Refuses an ID token that was not issued by Google (iss), has expired (exp), or was not issued for this sign-in (nonce), for
 * this client (aud), or for another account than the profile (sub). The token comes straight from Google's token endpoint over
 * TLS, which OpenID Connect Core 3.1.3.7 accepts in place of checking its signature; the claims are still checked.
 */
function assertIdTokenMatches(idToken: unknown, expectedNonce: string, clientId: string, subject: unknown): void {
  const claims = idTokenClaims(idToken);
  if (!GOOGLE_ID_TOKEN_ISSUERS.has(claims.iss)) throw new Error('Security violation: Google ID token was not issued by Google');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new Error('Security violation: Google ID token has expired');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.nonce !== expectedNonce) throw new Error('Security violation: Google ID token nonce does not match this sign-in');
  if (!audiences.includes(clientId)) throw new Error('Security violation: Google ID token was issued for another client');
  if (typeof claims.sub !== 'string' || claims.sub !== subject) throw new Error('Security violation: Google ID token names another account than the profile');
}

/**
 * Exchanges the authorization code for the profile of the account. The ID token that Google returns must come from Google,
 * be unexpired, carry `expectedNonce` (the nonce of the sign-in's OAuth session), be issued for this client and name the same
 * account as the profile, so a token from another sign-in is not accepted. The nonce is required: a caller cannot skip the checks.
 */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  codeVerifier: string | undefined,
  expectedNonce: string
): Promise<GoogleUserInfo> {
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
      emailVerified: true,
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
      emailVerified: true,
    };
  }

  // Live RFC 6749 Authorization Code Token Exchange with RFC 7636 PKCE
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const tokenParams: Record<string, string> = {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  };

  if (codeVerifier) {
    tokenParams.code_verifier = codeVerifier;
  }

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(tokenParams).toString(),
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
  const emailVerified = userData.email_verified === true || userData.email_verified === 'true';

  if (!emailVerified) {
    throw new Error('Security violation: Google OAuth account email is not verified');
  }

  assertIdTokenMatches(tokenData.id_token, expectedNonce, clientId, userData.sub);

  return {
    id: userData.sub,
    email: userData.email,
    name: userData.name || userData.email.split('@')[0],
    picture: userData.picture,
    emailVerified: true,
  };
}

