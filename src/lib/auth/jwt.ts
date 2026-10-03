import crypto from 'node:crypto';
import type { SessionPayload } from './types';

function getJwtSecret(): string {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Security violation: JWT_SECRET environment variable is required in production');
  }
  return 'easyconvert-secure-session-secret-key-default-development-2026';
}

const DEFAULT_EXPIRATION_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const DEFAULT_JWT_ISSUER = 'easyconvert';
export const DEFAULT_JWT_AUDIENCE = 'easyconvert-api';

export interface SignJwtOptions {
  secret?: string;
  expiresInSeconds?: number;
  issuer?: string;
  audience?: string;
  jti?: string;
  sessionVersion?: number;
}

export interface VerifyJwtOptions {
  secret?: string;
  issuer?: string | string[];
  audience?: string | string[];
  expectedSessionVersion?: number;
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64url');
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf-8');
}

/**
 * Signs a payload as an RFC 7519 compliant JSON Web Token (HS256).
 */
export function signJwt(
  payload: Record<string, unknown>,
  secretOrOptions?: string | SignJwtOptions,
  expiresInSeconds: number = DEFAULT_EXPIRATION_SECONDS
): string {
  let secret: string | undefined;
  let expSeconds = expiresInSeconds;
  let issuer = DEFAULT_JWT_ISSUER;
  let audience = DEFAULT_JWT_AUDIENCE;
  let jti: string = crypto.randomUUID();
  let sessionVersion: number | undefined;

  if (typeof secretOrOptions === 'string') {
    secret = secretOrOptions;
  } else if (secretOrOptions && typeof secretOrOptions === 'object') {
    secret = secretOrOptions.secret;
    if (typeof secretOrOptions.expiresInSeconds === 'number') {
      expSeconds = secretOrOptions.expiresInSeconds;
    }
    if (secretOrOptions.issuer !== undefined) {
      issuer = secretOrOptions.issuer;
    }
    if (secretOrOptions.audience !== undefined) {
      audience = secretOrOptions.audience;
    }
    if (secretOrOptions.jti !== undefined) {
      jti = secretOrOptions.jti;
    }
    if (secretOrOptions.sessionVersion !== undefined) {
      sessionVersion = secretOrOptions.sessionVersion;
    }
  }

  const activeSecret = secret ?? getJwtSecret();
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const fullPayload: Record<string, unknown> = {
    ...payload,
    iss: payload.iss ?? issuer,
    aud: payload.aud ?? audience,
    jti: payload.jti ?? jti,
    iat: now,
    exp: now + expSeconds,
  };

  if (sessionVersion !== undefined && fullPayload.sessionVersion === undefined) {
    fullPayload.sessionVersion = sessionVersion;
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', activeSecret)
    .update(dataToSign)
    .digest('base64url');

  return `${dataToSign}.${signature}`;
}

/**
 * Verifies an RFC 7519 JSON Web Token and returns its payload, or null if invalid or expired.
 */
export function verifyJwt<T = SessionPayload>(
  token: string,
  secretOrOptions?: string | VerifyJwtOptions
): T | null {
  if (!token || typeof token !== 'string') {
    return null;
  }

  let secret: string | undefined;
  let options: VerifyJwtOptions | undefined;
  if (typeof secretOrOptions === 'string') {
    secret = secretOrOptions;
  } else if (secretOrOptions && typeof secretOrOptions === 'object') {
    secret = secretOrOptions.secret;
    options = secretOrOptions;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;

  try {
    const header = JSON.parse(base64UrlDecode(encodedHeader));
    if (!header || typeof header !== 'object' || Array.isArray(header) || header.alg !== 'HS256') {
      return null;
    }
  } catch {
    return null;
  }

  const activeSecret = secret ?? getJwtSecret();
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac('sha256', activeSecret)
    .update(dataToSign)
    .digest('base64url');

  const sigBuffer = Buffer.from(signature, 'utf-8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) {
      return null;
    }

    if (options?.issuer) {
      const allowed = Array.isArray(options.issuer) ? options.issuer : [options.issuer];
      if (typeof payload.iss !== 'string' || !allowed.includes(payload.iss)) {
        return null;
      }
    }

    if (options?.audience) {
      const allowed = Array.isArray(options.audience) ? options.audience : [options.audience];
      if (typeof payload.aud !== 'string' || !allowed.includes(payload.aud)) {
        return null;
      }
    }

    if (typeof options?.expectedSessionVersion === 'number') {
      if (typeof payload.sessionVersion === 'number' && payload.sessionVersion < options.expectedSessionVersion) {
        return null;
      }
    }

    return payload as T;
  } catch {
    return null;
  }
}

