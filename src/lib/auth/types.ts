/** `paid` is an account with package credits or an entitling subscription (docs/policy-decisions.md, entry 285). */
export type UserTier = 'free' | 'paid';

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
  /** Epoch milliseconds when an operator suspended this account; absent when active. */
  suspendedAt?: number;
  /** Sanitized operator reason explaining why the account was suspended. */
  suspendedReason?: string;
}

export interface UserRecord extends User {
  passwordHash?: string;
  salt?: string;
}

/**
 * Partial user updates passed to `UserStore.updateUser`. Passing `null` for an optional field removes it
 * in both Redis Lua (`cjson.null` -> `nil`) and the in-memory store.
 */
export type UserRecordUpdates = {
  [K in keyof Omit<UserRecord, 'id' | 'email' | 'createdAt'>]?:
    | Omit<UserRecord, 'id' | 'email' | 'createdAt'>[K]
    | null;
};

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
