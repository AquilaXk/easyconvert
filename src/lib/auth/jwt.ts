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

export interface JwtHeader {
  alg: 'HS256';
  typ: 'JWT';
  kid?: string;
}

export interface SignJwtOptions {
  secret?: string;
  kid?: string;
  expiresInSeconds?: number;
  issuer?: string;
  audience?: string;
  jti?: string;
  sessionVersion?: number;
}

export interface VerifyJwtOptions {
  secret?: string;
  previousSecret?: string;
  issuer?: string | string[];
  audience?: string | string[];
  expectedSessionVersion?: number;
}

export function deriveJwtKeyId(secret: string): string {
  return crypto
    .createHash('sha256')
    .update('easyconvert:jwt-kid:v1:')
    .update(secret)
    .digest('hex')
    .slice(0, 16);
}

/** Like `JWT_SECRET`, the previous secret is used exactly as set; neither value is trimmed. */
export function getPreviousJwtSecret(overridePrevious?: string): string | null {
  const prev = overridePrevious ?? process.env.JWT_SECRET_PREVIOUS;
  if (!prev?.trim()) {
    return null;
  }
  if (prev.length < 32) {
    throw new Error(
      'CRITICAL SECURITY ERROR: JWT_SECRET_PREVIOUS environment variable must be at least 32 characters long when set.'
    );
  }
  return prev;
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
  let customKid: string | undefined;
  let expSeconds = expiresInSeconds;
  let issuer = DEFAULT_JWT_ISSUER;
  let audience = DEFAULT_JWT_AUDIENCE;
  let jti: string = crypto.randomUUID();
  let sessionVersion: number | undefined;

  if (typeof secretOrOptions === 'string') {
    secret = secretOrOptions;
  } else if (secretOrOptions && typeof secretOrOptions === 'object') {
    secret = secretOrOptions.secret;
    customKid = secretOrOptions.kid;
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
  const header: JwtHeader = {
    alg: 'HS256',
    typ: 'JWT',
    kid: customKid ?? deriveJwtKeyId(activeSecret),
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
function parseJwtHeader(encodedHeader: string): JwtHeader | null {
  try {
    const parsed = JSON.parse(base64UrlDecode(encodedHeader));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.alg !== 'HS256') {
      return null;
    }
    return parsed as JwtHeader;
  } catch {
    return null;
  }
}

/** Checks the signature against the active secret and the previous one, trying the key named by `kid` first. */
function signatureMatchesAnyKey(
  dataToSign: string,
  signature: string,
  header: JwtHeader,
  activeSecret: string,
  previousSecret: string | null
): boolean {
  const candidates: string[] = [activeSecret];
  if (previousSecret && previousSecret !== activeSecret) {
    candidates.push(previousSecret);
  }

  const kid = typeof header.kid === 'string' && header.kid.length > 0 ? header.kid : undefined;
  const ordered = kid
    ? [...candidates.filter((s) => deriveJwtKeyId(s) === kid), ...candidates.filter((s) => deriveJwtKeyId(s) !== kid)]
    : candidates;

  const sigBuffer = Buffer.from(signature, 'utf-8');
  return ordered.some((candidate) => {
    const expected = Buffer.from(crypto.createHmac('sha256', candidate).update(dataToSign).digest('base64url'), 'utf-8');
    return sigBuffer.length === expected.length && crypto.timingSafeEqual(sigBuffer, expected);
  });
}

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

  const header = parseJwtHeader(encodedHeader);
  if (!header) {
    return null;
  }

  const activeSecret = secret ?? getJwtSecret();
  const previousSecret =
    secret !== undefined && options?.previousSecret === undefined
      ? null
      : getPreviousJwtSecret(options?.previousSecret);

  if (!signatureMatchesAnyKey(`${encodedHeader}.${encodedPayload}`, signature, header, activeSecret, previousSecret)) {
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

