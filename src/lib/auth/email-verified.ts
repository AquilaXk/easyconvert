import type { UserRecord } from './types';

/** Whether the address of the account is known to be the owner's: Google vouches for it, an email sign-up proves it with a mailed code, an older one with a link. */
export function isEmailVerified(record: Pick<UserRecord, 'provider' | 'emailVerified'>): boolean {
  return record.provider === 'google' || record.emailVerified === true;
}

/** An account that signs in with an email and a password and has not been linked to Google. */
export function isPasswordAccount(record: Pick<UserRecord, 'provider' | 'passwordHash' | 'salt'>): boolean {
  return record.provider === 'email' && Boolean(record.passwordHash) && Boolean(record.salt);
}

/**
 * Whether an account is treated as an anonymous visitor for conversions: a password account whose address was never confirmed
 * (an account made before sign-up asked for a code) and that has bought nothing. It uses the allowance of its address bucket and
 * not a daily allowance of its own, so a person cannot multiply the free allowance with accounts of addresses they do not own;
 * confirming the address (a code at the next sign-in) ends it. Google accounts and paid accounts are never treated so.
 */
export function countsAsAnonymousForConversions(user: Pick<UserRecord, 'provider' | 'emailVerified' | 'tier'>): boolean {
  return user.provider === 'email' && !isEmailVerified(user) && user.tier === 'free';
}
