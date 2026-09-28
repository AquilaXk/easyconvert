export type UserTier = 'free' | 'pro' | 'enterprise';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  tier: UserTier;
  provider: 'email' | 'google';
  createdAt: number;
  updatedAt: number;
  conversionsCount?: number;
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
}
