import crypto from 'node:crypto';
import type { SessionPayload } from './types';

function getJwtSecret(): string {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }
  if (process.env.NODE_ENV === 'production') {
    return instanceRandomSecret;
  }
  return 'easyconvert-secure-session-secret-key-default-development-2026';
}

const instanceRandomSecret = crypto.randomBytes(32).toString('hex');
const DEFAULT_EXPIRATION_SECONDS = 7 * 24 * 60 * 60; // 7 days

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
  secret?: string,
  expiresInSeconds: number = DEFAULT_EXPIRATION_SECONDS
): string {
  const activeSecret = secret ?? getJwtSecret();
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

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
  secret?: string
): T | null {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;

  try {
    const header = JSON.parse(base64UrlDecode(encodedHeader));
    if (!header || typeof header !== 'object' || header.alg !== 'HS256') {
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

    return payload as T;
  } catch {
    return null;
  }
}
