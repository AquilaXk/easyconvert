export type UserTier = 'free' | 'pro' | 'enterprise';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  tier: UserTier;
  /** When a paid `tier` ends, in milliseconds since the epoch; the account is on the free plan from then (a subscription that is canceled at period end). */
  tierUntil?: number;
  provider: 'email' | 'google';
  createdAt: number;
  updatedAt: number;
  conversionsCount?: number;
  sessionVersion?: number;
  emailVerified?: boolean;
  /** The version of the terms accepted at sign-up (`TERMS_VERSION`); absent on accounts made before it was recorded. */
  acceptedTermsVersion?: string;
}

export interface UserRecord extends User {
  passwordHash?: string;
  salt?: string;
}

export interface SessionPayload {
  sub: string;
  email: string;
  name: string;
  tier: UserTier;
  jti?: string;
  iss?: string;
  aud?: string;
  sessionVersion?: number;
  iat: number;
  exp: number;
}

export interface AuthResponse {
  user: User;
  token?: string;
}

export interface GoogleUserInfo {
  id: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
}
